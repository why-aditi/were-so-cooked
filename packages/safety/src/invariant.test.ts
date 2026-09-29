import { Allergen, Diet, type Profile } from '@cooked/shared';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { check } from './check.js';
import { TEST_INGREDIENTS, TEST_SUBSTITUTIONS, recipe } from './fixtures.js';
import { type Proposer, substitute } from './substitute.js';
import { createTaxonomy } from './taxonomy.js';

/**
 * Section 7's stated guarantee:
 *
 *   "Invariant, tested with property-based tests: for any recipe and profile,
 *    the output of `substitute` either passes `check` or is dropped."
 *
 * Every property below re-derives the check independently of the one
 * `substitute` returns. Trusting the reported `check` object would make these
 * tautologies — the engine could return a stale or fabricated result and still
 * pass.
 */

const taxonomy = createTaxonomy(TEST_INGREDIENTS);
const KNOWN_IDS = TEST_INGREDIENTS.map((i) => i.canonicalId);
type P = Pick<Profile, 'diets' | 'allergens' | 'exclusions'>;

/** Ingredient ids, mostly real but sometimes unresolvable. */
const arbIngredientId = fc.oneof(
  { weight: 9, arbitrary: fc.constantFrom(...KNOWN_IDS) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 12 }) },
);

const arbRecipe = fc
  .array(arbIngredientId, { minLength: 0, maxLength: 8 })
  .map((ings) => recipe(ings));

const arbProfile: fc.Arbitrary<P> = fc.record({
  diets: fc.uniqueArray(fc.constantFrom(...Diet.options), { maxLength: 4 }),
  allergens: fc.uniqueArray(fc.constantFrom(...Allergen.options), { maxLength: 5 }),
  exclusions: fc.uniqueArray(
    fc.constantFrom('mushroom', 'onion', 'paneer', 'coriander', 'tomato'),
    { maxLength: 3 },
  ),
});

const RUNS = 500;

describe('the section 7 invariant', () => {
  it('substitute output either passes check or is dropped', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        if (out.dropped) return true;
        // Independently re-checked, not read off the result.
        return check(out.recipe, profile, taxonomy).ok;
      }),
      { numRuns: RUNS },
    );
  });

  it('holds when the LLM proposer returns arbitrary nonsense', async () => {
    // The proposer is untrusted input. Whatever it returns — real ids, invented
    // ids, ingredients that break the profile worse — the invariant must hold.
    const arbProposal = fc.array(
      fc.record({
        toId: fc.oneof(fc.constantFrom(...KNOWN_IDS), fc.string({ maxLength: 20 })),
        explanation: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
      }),
      { maxLength: 4 },
    );

    await fc.assert(
      fc.asyncProperty(
        arbRecipe,
        arbProfile,
        arbProposal,
        async (input, profile, proposals) => {
          const propose: Proposer = async () => proposals;
          const out = await substitute(input, profile, {
            taxonomy,
            substitutions: TEST_SUBSTITUTIONS,
            propose,
          });
          if (out.dropped) return true;
          return check(out.recipe, profile, taxonomy).ok;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('holds when the substitution table itself is arbitrary', async () => {
    // A corrupt or badly curated table must not be able to produce an unsafe
    // recipe either. The final check is the only thing that matters.
    const arbTable = fc.array(
      fc.record({
        fromId: fc.constantFrom(...KNOWN_IDS),
        toId: fc.oneof(fc.constantFrom(...KNOWN_IDS), fc.string({ maxLength: 10 })),
        rule: fc.constantFrom('vegan', 'tree_nuts', 'gluten_free', 'nonsense'),
        ratioNote: fc.constant(null),
        explanation: fc.constant('generated'),
      }),
      { maxLength: 12 },
    );

    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, arbTable, async (input, profile, substitutions) => {
        const out = await substitute(input, profile, { taxonomy, substitutions });
        if (out.dropped) return true;
        return check(out.recipe, profile, taxonomy).ok;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('properties that hold regardless of outcome', () => {
  it('never invents an ingredient outside the taxonomy', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        if (out.dropped) return true;
        const originals = new Set(input.ingredients.map((i) => i.canonicalId));
        // Every ingredient is either untouched or a real taxonomy entry.
        return out.recipe.ingredients.every(
          (i) => originals.has(i.canonicalId) || taxonomy.byId(i.canonicalId ?? '') !== undefined,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps the ingredient count unchanged', async () => {
    // Substitution replaces, never adds or drops — otherwise a recipe could be
    // "fixed" by quietly deleting the offending ingredient.
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        if (out.dropped) return true;
        return out.recipe.ingredients.length === input.ingredients.length;
      }),
      { numRuns: RUNS },
    );
  });

  it('reports a swap for every ingredient it changed, and no others', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        if (out.dropped) return true;
        const changed = input.ingredients.filter(
          (orig, i) => out.recipe.ingredients[i]?.canonicalId !== orig.canonicalId,
        ).length;
        return out.swaps.length === changed;
      }),
      { numRuns: RUNS },
    );
  });

  it('gives a non-empty reason whenever it drops', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        return !out.dropped || out.reason.trim().length > 0;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('check is deterministic and order-free', () => {
  it('gives the same verdict however the ingredients are ordered', async () => {
    await fc.assert(
      fc.property(arbRecipe, arbProfile, (input, profile) => {
        const forwards = check(input, profile, taxonomy);
        const reversed = check(
          { ...input, ingredients: [...input.ingredients].reverse() },
          profile,
          taxonomy,
        );
        return forwards.ok === reversed.ok;
      }),
      { numRuns: RUNS },
    );
  });

  it('is idempotent: checking twice gives the same answer', () => {
    fc.assert(
      fc.property(arbRecipe, arbProfile, (input, profile) => {
        const a = check(input, profile, taxonomy);
        const b = check(input, profile, taxonomy);
        return a.ok === b.ok && a.violations.length === b.violations.length;
      }),
      { numRuns: RUNS },
    );
  });

  it('adding a diet or allergen never makes a failing recipe pass', async () => {
    // Monotonicity: constraints only ever subtract. A rule that relaxed the
    // verdict when tightened would be a serious logic error.
    await fc.assert(
      fc.property(
        arbRecipe,
        arbProfile,
        fc.constantFrom(...Diet.options),
        (input, profile, extra) => {
          const before = check(input, profile, taxonomy);
          const after = check(input, { ...profile, diets: [...profile.diets, extra] }, taxonomy);
          return before.ok || !after.ok;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('a deliberately hostile case', () => {
  it('never returns a recipe containing a declared allergen', async () => {
    // The single failure that matters most, stated as its own property.
    await fc.assert(
      fc.asyncProperty(arbRecipe, arbProfile, async (input, profile) => {
        if (profile.allergens.length === 0) return true;
        const out = await substitute(input, profile, {
          taxonomy,
          substitutions: TEST_SUBSTITUTIONS,
        });
        if (out.dropped) return true;
        for (const ing of out.recipe.ingredients) {
          const entry = taxonomy.byId(ing.canonicalId ?? '');
          // An unresolved ingredient must not survive for an allergy profile.
          if (!entry) return false;
          if (entry.allergens.some((a) => profile.allergens.includes(a))) return false;
        }
        return true;
      }),
      { numRuns: RUNS },
    );
  });
});

describe('fast-check finds the small cases too', () => {
  it('has a shrinking example for an obviously unsafe swap', async () => {
    // Sanity: if the invariant were broken, would the property catch it?
    // This asserts the property harness is actually exercising substitute by
    // proving a known-bad proposer gets rejected every time.
    const alwaysPeanut: Proposer = async () => [{ toId: 'peanut' }];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('prawn', 'chicken', 'beef'), async (id) => {
        const out = await substitute(
          recipe([id]),
          { diets: ['vegan'], allergens: ['peanuts'], exclusions: [] },
          { taxonomy, substitutions: [], propose: alwaysPeanut },
        );
        return out.dropped;
      }),
      { numRuns: 50 },
    );
  });
});
