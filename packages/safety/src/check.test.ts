import { Allergen, Diet, type Profile } from '@cooked/shared';
import { describe, expect, it } from 'vitest';
import { check, exclusionMatches } from './check.js';
import { ALL_DIETS } from './diets.js';
import { EMPTY_PROFILE, TEST_INGREDIENTS, recipe } from './fixtures.js';
import { createTaxonomy, resolveAll } from './taxonomy.js';

const tax = createTaxonomy(TEST_INGREDIENTS);
type P = Pick<Profile, 'diets' | 'allergens' | 'exclusions'>;
const profile = (over: Partial<P> = {}): P => ({ ...EMPTY_PROFILE, ...over });

/* -------------------------------- allergens ------------------------------- */

/**
 * One carrier per allergen in the enum. `Allergen.options` drives the table, so
 * adding an allergen to packages/shared without a carrier here fails the
 * completeness test below rather than silently going untested.
 */
const ALLERGEN_CARRIERS: Record<string, string> = {
  milk: 'paneer',
  egg: 'mayonnaise',
  fish: 'fish_sauce',
  crustaceans: 'prawn',
  molluscs: 'oyster_sauce',
  peanuts: 'peanut',
  tree_nuts: 'cashew',
  gluten: 'naan',
  soy: 'soy_sauce',
  sesame: 'tahini',
  mustard: 'mustard_seed',
  celery: 'celery',
  lupin: 'lupin_flour',
  sulphites: 'wine',
};

describe('allergens', () => {
  it('covers every allergen in the shared enum', () => {
    expect(Object.keys(ALLERGEN_CARRIERS).sort()).toEqual([...Allergen.options].sort());
  });

  it.each(Allergen.options)('blocks %s', (allergen) => {
    const carrier = ALLERGEN_CARRIERS[allergen] as string;
    const result = check(recipe([carrier]), profile({ allergens: [allergen] }), tax);

    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.rule === allergen);
    expect(v).toBeDefined();
    expect(v?.severity).toBe('hard');
    expect(v?.canonicalId).toBe(carrier);
  });

  it.each(Allergen.options)('allows %s when the profile does not list it', (allergen) => {
    const carrier = ALLERGEN_CARRIERS[allergen] as string;
    expect(check(recipe([carrier]), profile(), tax).ok).toBe(true);
  });

  it('reports every allergen a composite ingredient hides', () => {
    // Section 7: "Composite and packaged ingredients carry their hidden
    // allergens." Pesto is tree nuts *and* milk; naan is gluten *and* milk.
    const result = check(
      recipe(['pesto', 'naan']),
      profile({ allergens: ['tree_nuts', 'milk', 'gluten'] }),
      tax,
    );
    const rules = result.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(['gluten', 'milk', 'milk', 'tree_nuts']);
  });

  it('flags several allergens in one recipe rather than stopping at the first', () => {
    const result = check(
      recipe(['paneer', 'peanut', 'tahini']),
      profile({ allergens: ['milk', 'peanuts', 'sesame'] }),
      tax,
    );
    expect(result.violations.filter((v) => v.severity === 'hard')).toHaveLength(3);
  });
});

/* ---------------------------------- diets --------------------------------- */

/** For each diet: an ingredient it must reject, and one it must accept. */
const DIET_CASES: Record<string, { blocks: string; allows: string }> = {
  vegetarian: { blocks: 'chicken', allows: 'paneer' },
  eggetarian: { blocks: 'chicken', allows: 'egg' },
  ovo_vegetarian: { blocks: 'paneer', allows: 'egg' },
  lacto_vegetarian: { blocks: 'egg', allows: 'paneer' },
  vegan: { blocks: 'honey', allows: 'tofu' },
  jain: { blocks: 'onion', allows: 'paneer' },
  sattvic: { blocks: 'garlic', allows: 'potato' },
  pescatarian: { blocks: 'chicken', allows: 'salmon' },
  halal: { blocks: 'pork', allows: 'chicken' },
  kosher_style: { blocks: 'prawn', allows: 'salmon' },
  no_beef: { blocks: 'beef', allows: 'chicken' },
  no_pork: { blocks: 'pork', allows: 'beef' },
  gluten_free: { blocks: 'wheat_flour', allows: 'rice' },
  dairy_free: { blocks: 'paneer', allows: 'tofu' },
  keto_friendly: { blocks: 'rice', allows: 'paneer' },
  paleo: { blocks: 'rajma', allows: 'chicken' },
  low_fodmap: { blocks: 'onion', allows: 'carrot' },
  navratri: { blocks: 'wheat_flour', allows: 'kuttu_flour' },
};

describe('diets', () => {
  it('covers every diet in the shared enum', () => {
    expect(Object.keys(DIET_CASES).sort()).toEqual([...Diet.options].sort());
    expect(ALL_DIETS.sort()).toEqual([...Diet.options].sort());
  });

  it.each(Diet.options)('%s rejects the ingredient it forbids', (diet) => {
    const { blocks } = DIET_CASES[diet] as { blocks: string };
    const result = check(recipe([blocks]), profile({ diets: [diet] }), tax);
    expect(result.ok, `${diet} should reject ${blocks}`).toBe(false);
    expect(result.violations.find((v) => v.rule === diet)?.severity).toBe('hard');
  });

  it.each(Diet.options)('%s accepts the ingredient it permits', (diet) => {
    const { allows } = DIET_CASES[diet] as { allows: string };
    const result = check(recipe([allows]), profile({ diets: [diet] }), tax);
    expect(result.ok, `${diet} should accept ${allows}: ${JSON.stringify(result.violations)}`).toBe(
      true,
    );
  });
});

describe('the vegetarian family, which the spec leaves ambiguous', () => {
  // Section 7 reads "Vegetarian | No meat, poultry, fish or shellfish" and then
  // defines the variants as "vegetarian, with eggs or dairy allowed as named".
  // Taken literally the variants add nothing, so the base is read as excluding
  // egg, matching Indian usage. These tests pin that reading down.
  it('vegetarian excludes egg but allows dairy', () => {
    expect(check(recipe(['egg']), profile({ diets: ['vegetarian'] }), tax).ok).toBe(false);
    expect(check(recipe(['paneer']), profile({ diets: ['vegetarian'] }), tax).ok).toBe(true);
  });

  it('eggetarian allows both egg and dairy', () => {
    expect(check(recipe(['egg', 'paneer']), profile({ diets: ['eggetarian'] }), tax).ok).toBe(true);
  });

  it('ovo-vegetarian allows egg but not dairy', () => {
    expect(check(recipe(['egg']), profile({ diets: ['ovo_vegetarian'] }), tax).ok).toBe(true);
    expect(check(recipe(['paneer']), profile({ diets: ['ovo_vegetarian'] }), tax).ok).toBe(false);
  });

  it('lacto-vegetarian allows dairy but not egg', () => {
    expect(check(recipe(['paneer']), profile({ diets: ['lacto_vegetarian'] }), tax).ok).toBe(true);
    expect(check(recipe(['egg']), profile({ diets: ['lacto_vegetarian'] }), tax).ok).toBe(false);
  });

  it('every variant still rejects flesh', () => {
    for (const diet of ['vegetarian', 'eggetarian', 'ovo_vegetarian', 'lacto_vegetarian'] as const) {
      expect(check(recipe(['chicken']), profile({ diets: [diet] }), tax).ok, diet).toBe(false);
      expect(check(recipe(['prawn']), profile({ diets: [diet] }), tax).ok, diet).toBe(false);
    }
  });
});

describe('diet rules that a flag blocklist cannot express', () => {
  it('kosher-style allows meat alone and dairy alone, but not together', () => {
    const p = profile({ diets: ['kosher_style'] });
    expect(check(recipe(['chicken']), p, tax).ok).toBe(true);
    expect(check(recipe(['paneer']), p, tax).ok).toBe(true);
    // Neither ingredient is wrong; the combination is.
    const both = check(recipe(['chicken', 'paneer']), p, tax);
    expect(both.ok).toBe(false);
    expect(both.violations.some((v) => v.message.includes('meat and dairy'))).toBe(true);
  });

  it('navratri permits vrat-flagged grains and rejects the rest', () => {
    const p = profile({ diets: ['navratri'] });
    expect(check(recipe(['kuttu_flour', 'singhara_flour', 'rock_salt']), p, tax).ok).toBe(true);
    expect(check(recipe(['rice']), p, tax).ok).toBe(false);
    expect(check(recipe(['wheat_flour']), p, tax).ok).toBe(false);
    // A non-grain is untouched by the vrat rule.
    expect(check(recipe(['paneer']), p, tax).ok).toBe(true);
  });

  it('halal advises on meat without blocking it', () => {
    const result = check(recipe(['chicken']), profile({ diets: ['halal'] }), tax);
    expect(result.ok).toBe(true);
    expect(result.advisories).toContain('Use halal-certified meat.');
  });

  it('halal still blocks pork and alcohol outright', () => {
    const p = profile({ diets: ['halal'] });
    expect(check(recipe(['pork']), p, tax).ok).toBe(false);
    expect(check(recipe(['wine']), p, tax).ok).toBe(false);
  });
});

describe('combined diets', () => {
  it('requires every diet in the profile to pass', () => {
    // Section 7: "Diets can be combined; a recipe must satisfy all of them."
    const p = profile({ diets: ['vegan', 'gluten_free'] });
    expect(check(recipe(['tofu', 'rice']), p, tax).ok).toBe(true);
    expect(check(recipe(['tofu', 'naan']), p, tax).ok).toBe(false); // gluten
    expect(check(recipe(['paneer', 'rice']), p, tax).ok).toBe(false); // dairy
  });

  it('names each diet that a single ingredient breaks', () => {
    const result = check(recipe(['naan']), profile({ diets: ['vegan', 'gluten_free'] }), tax);
    const rules = result.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(['gluten_free', 'vegan']);
  });
});

/* ------------------------------- exclusions -------------------------------- */

describe('custom exclusions', () => {
  it('blocks an excluded ingredient exactly like an allergen', () => {
    const result = check(recipe(['mushroom']), profile({ exclusions: ['mushroom'] }), tax);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.severity).toBe('hard');
    expect(result.violations[0]?.rule).toBe('exclusion:mushroom');
  });

  it('matches aliases and is case-insensitive', () => {
    expect(check(recipe(['onion']), profile({ exclusions: ['Pyaz'] }), tax).ok).toBe(false);
    expect(check(recipe(['palak']), profile({ exclusions: ['SPINACH'] }), tax).ok).toBe(false);
  });

  it('matches whole words only, so "nut" does not catch "coconut oil"', () => {
    // Substring matching is how an exclusion engine starts refusing the catalog.
    const resolved = resolveAll(recipe(['coconut_oil']).ingredients, tax);
    expect(exclusionMatches('nut', resolved[0]!)).toBe(false);
    expect(check(recipe(['coconut_oil']), profile({ exclusions: ['nut'] }), tax).ok).toBe(true);
  });

  it('tolerates a plural on either side', () => {
    const resolved = resolveAll(recipe(['cashew']).ingredients, tax);
    expect(exclusionMatches('cashews', resolved[0]!)).toBe(true);
  });

  it('ignores an empty or whitespace exclusion', () => {
    expect(check(recipe(['paneer']), profile({ exclusions: ['', '   '] }), tax).ok).toBe(true);
  });
});

/* -------------------------------- unknowns -------------------------------- */

describe('unknown ingredients', () => {
  it('lists them and flags, but does not block, a profile with no allergies', () => {
    const result = check(recipe(['some_mystery_powder']), profile(), tax);
    expect(result.unknowns).toEqual(['some_mystery_powder']);
    expect(result.ok).toBe(true);
    expect(result.violations[0]?.severity).toBe('unknown');
  });

  it('blocks outright once the profile lists any allergen', () => {
    // Section 7: "Treated as hard for users with any allergy." The engine
    // cannot rule out that the unknown thing contains the allergen.
    const result = check(recipe(['some_mystery_powder']), profile({ allergens: ['peanuts'] }), tax);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.severity).toBe('hard');
    expect(result.unknowns).toEqual(['some_mystery_powder']);
  });

  it('does not let an unknown ingredient satisfy a diet by having no flags', () => {
    // The dangerous shape: an unresolved ingredient has no flags, so a naive
    // blocklist would call it vegan.
    const result = check(recipe(['mystery_stock_cube']), profile({ diets: ['vegan'] }), tax);
    expect(result.unknowns).toHaveLength(1);
    expect(result.violations.some((v) => v.severity !== 'soft')).toBe(true);
  });

  it('resolves by name when the canonical id is missing', () => {
    const r = recipe([]);
    r.ingredients = [{ canonicalId: null, name: 'paneer', quantity: 1, unit: 'kg', note: null }];
    const result = check(r, profile({ allergens: ['milk'] }), tax);
    expect(result.unknowns).toHaveLength(0);
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------ soft violations ---------------------------- */

describe('taste-memory dislikes', () => {
  it('records them as soft and never blocks', () => {
    // Section 7: soft violations lower ranking only.
    const result = check(recipe(['mushroom']), profile(), tax, { dislikes: ['mushroom'] });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.severity).toBe('soft');
  });

  it('keeps a dislike soft even when the same term is also an allergen carrier', () => {
    const result = check(recipe(['paneer']), profile(), tax, { dislikes: ['paneer'] });
    expect(result.ok).toBe(true);
    expect(result.violations.every((v) => v.severity === 'soft')).toBe(true);
  });

  it('does not stop a hard violation being reported alongside', () => {
    const result = check(recipe(['paneer']), profile({ allergens: ['milk'] }), tax, {
      dislikes: ['paneer'],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.severity).sort()).toEqual(['hard', 'soft']);
  });
});

/* --------------------------------- basics --------------------------------- */

describe('edge cases', () => {
  it('passes an empty recipe', () => {
    const result = check(recipe([]), profile({ diets: ['vegan'], allergens: ['milk'] }), tax);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes anything for an empty profile', () => {
    expect(check(recipe(['pork', 'wine', 'peanut']), profile(), tax).ok).toBe(true);
  });

  it('ignores a diet that has no rule', () => {
    const result = check(recipe(['pork']), { ...profile(), diets: ['not_a_diet' as never] }, tax);
    expect(result.ok).toBe(true);
  });
});
