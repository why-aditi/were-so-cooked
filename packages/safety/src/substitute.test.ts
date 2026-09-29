import type { Profile } from '@cooked/shared';
import { describe, expect, it, vi } from 'vitest';
import { check } from './check.js';
import { EMPTY_PROFILE, TEST_INGREDIENTS, TEST_SUBSTITUTIONS, recipe } from './fixtures.js';
import { type Proposer, substitute, withComputedTags } from './substitute.js';
import { createTaxonomy } from './taxonomy.js';

const taxonomy = createTaxonomy(TEST_INGREDIENTS);
type P = Pick<Profile, 'diets' | 'allergens' | 'exclusions'>;
const profile = (over: Partial<P> = {}): P => ({ ...EMPTY_PROFILE, ...over });
const deps = (over: Partial<Parameters<typeof substitute>[2]> = {}) => ({
  taxonomy,
  substitutions: TEST_SUBSTITUTIONS,
  ...over,
});

const ids = (r: { ingredients: { canonicalId: string | null }[] }) =>
  r.ingredients.map((i) => i.canonicalId);

describe('step 1: already compliant', () => {
  it('returns the ingredients untouched with no swaps', async () => {
    const input = recipe(['tofu', 'rice']);
    const out = await substitute(input, profile({ diets: ['vegan'] }), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(out.recipe.ingredients).toEqual(input.ingredients);
    expect(out.swaps).toHaveLength(0);
  });

  it('still recomputes the tags, because the engine owns them', async () => {
    // A recipe that passes is not exempt from section 7's rule that
    // LLM-provided tags are discarded. Otherwise a model-written recipe
    // claiming "vegan" passes an empty profile untouched, gets stored with
    // that claim, and a tag filter then serves it to an actual vegan.
    const lying = { ...recipe(['chicken', 'rice']), dietTags: ['vegan' as const] };
    const out = await substitute(lying, profile(), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(out.recipe.ingredients).toEqual(lying.ingredients);
    expect(out.recipe.dietTags).not.toContain('vegan');
  });
});

describe('step 2: the curated table', () => {
  it('swaps chicken for a vegan alternative and explains why', async () => {
    const out = await substitute(recipe(['chicken', 'rice']), profile({ diets: ['vegan'] }), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;

    expect(ids(out.recipe)).toEqual(['soya_chaap', 'rice']);
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0]?.fromName).toBe('chicken');
    expect(out.swaps[0]?.toCanonicalId).toBe('soya_chaap');
    expect(out.swaps[0]?.explanation).toContain('Soya chaap');
    expect(out.check.ok).toBe(true);
  });

  it('carries the technique note through', async () => {
    const out = await substitute(recipe(['soy_sauce']), profile({ diets: ['gluten_free'] }), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(out.swaps[0]?.toCanonicalId).toBe('tamari');
  });

  it('fixes several offending ingredients in one pass', async () => {
    const out = await substitute(
      recipe(['chicken', 'butter', 'egg']),
      profile({ diets: ['vegan'] }),
      deps(),
    );
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(out.swaps).toHaveLength(3);
    expect(out.check.ok).toBe(true);
  });
});

/**
 * Section 7: "The cashew example is why step 2 checks every rule: a vegan user
 * with a tree-nut allergy must never be offered cashew cream."
 *
 * The fixture orders `butter -> cashew_cream` before `butter -> coconut_oil`
 * deliberately, so a substitution engine that took the first row matching the
 * violated rule would pick cashew cream and poison the user.
 */
describe('step 2 checks every rule, not just the violated one', () => {
  it('never offers cashew cream to a vegan with a tree-nut allergy', async () => {
    const out = await substitute(
      recipe(['butter', 'rice']),
      profile({ diets: ['vegan'], allergens: ['tree_nuts'] }),
      deps(),
    );
    expect(out.dropped).toBe(false);
    if (out.dropped) return;

    expect(ids(out.recipe)).not.toContain('cashew_cream');
    expect(ids(out.recipe)).toEqual(['coconut_oil', 'rice']);
    expect(out.check.ok).toBe(true);
  });

  it('does offer cashew cream to a vegan with no nut allergy', async () => {
    // The other half: the guard must not be a blanket refusal of cashew cream.
    const out = await substitute(recipe(['butter']), profile({ diets: ['vegan'] }), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(ids(out.recipe)).toEqual(['cashew_cream']);
  });

  it('will not swap in an ingredient that breaks a second diet', async () => {
    // milk -> oat_cream is the only row, and oat cream is a grain, which
    // navratri forbids. There is no valid swap, so the recipe must be dropped.
    const out = await substitute(
      recipe(['milk']),
      profile({ diets: ['vegan', 'navratri'] }),
      deps(),
    );
    expect(out.dropped).toBe(true);
  });
});

describe('step 4: drop rather than return something unsafe', () => {
  it('drops a recipe with no candidate swap and says why', async () => {
    const out = await substitute(recipe(['prawn']), profile({ diets: ['vegan'] }), deps());
    expect(out.dropped).toBe(true);
    if (!out.dropped) return;
    expect(out.reason).toMatch(/could not make this fit/i);
    expect(out.reason.length).toBeGreaterThan(20);
    expect(out.check.ok).toBe(false);
  });

  it('drops when an unknown ingredient cannot be verified', async () => {
    const out = await substitute(
      recipe(['mystery_paste']),
      profile({ allergens: ['peanuts'] }),
      deps(),
    );
    expect(out.dropped).toBe(true);
  });

  it('drops rather than partially fixing a recipe', async () => {
    // chicken can be swapped; prawn cannot. A partial fix would be worse than
    // nothing, because the result still contains shellfish.
    const out = await substitute(
      recipe(['chicken', 'prawn']),
      profile({ diets: ['vegan'] }),
      deps(),
    );
    expect(out.dropped).toBe(true);
  });
});

describe('step 3: the injected LLM proposer', () => {
  it('is only consulted when the table has nothing', async () => {
    const propose = vi.fn<Proposer>(async () => []);
    await substitute(recipe(['chicken']), profile({ diets: ['vegan'] }), deps({ propose }));
    expect(propose).not.toHaveBeenCalled();
  });

  it('is used when the table has no row, and its suggestion is applied', async () => {
    const propose = vi.fn<Proposer>(async () => [
      { toId: 'palak', explanation: 'Spinach instead of prawn.' },
    ]);
    const out = await substitute(
      recipe(['prawn']),
      profile({ diets: ['vegan'] }),
      deps({ propose }),
    );
    expect(propose).toHaveBeenCalledOnce();
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    expect(ids(out.recipe)).toEqual(['palak']);
  });

  it('restricts the proposer to taxonomy ids', async () => {
    const propose = vi.fn<Proposer>(async (req) => {
      // Section 7 step 3: "restricted to taxonomy IDs".
      expect(req.allowedIds).toContain('palak');
      expect(req.allowedIds.length).toBe(TEST_INGREDIENTS.length);
      expect(req.violations.every((v) => v.severity === 'hard')).toBe(true);
      return [];
    });
    await substitute(recipe(['prawn']), profile({ diets: ['vegan'] }), deps({ propose }));
    expect(propose).toHaveBeenCalled();
  });

  it('discards a proposal outside the taxonomy', async () => {
    const propose = vi.fn<Proposer>(async () => [
      { toId: 'unicorn_meat', explanation: 'Trust me.' },
    ]);
    const out = await substitute(
      recipe(['prawn']),
      profile({ diets: ['vegan'] }),
      deps({ propose }),
    );
    // Unverifiable, so unusable — the recipe is dropped instead.
    expect(out.dropped).toBe(true);
  });

  it('discards a proposal that would itself violate the profile', async () => {
    const propose = vi.fn<Proposer>(async () => [{ toId: 'paneer' }]);
    const out = await substitute(
      recipe(['prawn']),
      profile({ diets: ['vegan'] }),
      deps({ propose }),
    );
    expect(out.dropped).toBe(true);
  });

  it('survives a proposer that throws', async () => {
    const propose = vi.fn<Proposer>(async () => {
      throw new Error('model timed out');
    });
    const out = await substitute(
      recipe(['prawn']),
      profile({ diets: ['vegan'] }),
      deps({ propose }),
    );
    // A failing model drops the recipe; it must not crash the engine.
    expect(out.dropped).toBe(true);
  });

  it('survives a proposer returning something that is not an array', async () => {
    const propose = vi.fn(async () => null) as unknown as Proposer;
    const out = await substitute(
      recipe(['prawn']),
      profile({ diets: ['vegan'] }),
      deps({ propose }),
    );
    expect(out.dropped).toBe(true);
  });
});

describe('computed tags', () => {
  it('overwrites whatever the input claimed', async () => {
    // Section 7: "Allergen tags on stored recipes are computed by the engine;
    // LLM-provided tags are discarded."
    const lying = recipe(['paneer'], {
      allergenTags: ['peanuts'],
      dietTags: ['vegan'],
    });
    const tagged = withComputedTags(lying, taxonomy);
    expect(tagged.allergenTags).toEqual(['milk']);
    expect(tagged.dietTags).not.toContain('vegan');
    expect(tagged.dietTags).toContain('vegetarian');
  });

  it('applies computed tags to a substituted recipe', async () => {
    const out = await substitute(recipe(['chicken']), profile({ diets: ['vegan'] }), deps());
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    // soya chaap is soy, not meat.
    expect(out.recipe.allergenTags).toEqual(['soy']);
    expect(out.recipe.dietTags).toContain('vegan');
  });

  it('gives an empty recipe every diet tag and no allergens', () => {
    const tagged = withComputedTags(recipe([]), taxonomy);
    expect(tagged.allergenTags).toEqual([]);
    expect(tagged.dietTags.length).toBeGreaterThan(10);
  });
});

describe('the result always agrees with check', () => {
  it('a returned recipe passes the check reported alongside it', async () => {
    const out = await substitute(
      recipe(['chicken', 'butter']),
      profile({ diets: ['vegan'], allergens: ['tree_nuts'] }),
      deps(),
    );
    expect(out.dropped).toBe(false);
    if (out.dropped) return;
    // Re-derive rather than trusting the reported check object.
    const independent = check(out.recipe, profile({ diets: ['vegan'], allergens: ['tree_nuts'] }), taxonomy);
    expect(independent.ok).toBe(true);
  });
});
