import { createTaxonomy, type SubstitutionRow, type Taxonomy } from '@cooked/safety';
import type { Ingredient, PantryItem, Profile, Recipe, RecipeDraft } from '@cooked/shared';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateResult } from './generate.js';
import type { RecipeSearch } from './store.js';
import {
  coverageOf,
  draftToRecipe,
  gate,
  rankSuggestions,
  substituteRecipe,
  suggestRecipes,
  summariseProfile,
  type Suggestion,
} from './suggest.js';

/**
 * `suggest_recipes` and `substitute`, with the catalog and the model faked.
 *
 * The one thing this file exists to prove is section 5 step 4: nothing that
 * fails the safety engine reaches the caller, whichever half produced it. The
 * engine's own invariant is proved in packages/safety with property tests;
 * what is tested here is that this orchestration actually routes everything
 * through it, including the recipes a model invented.
 */

/* -------------------------------- fixtures -------------------------------- */

const ing = (
  canonicalId: string,
  name: string,
  over: Partial<Ingredient> = {},
): Ingredient => ({
  canonicalId,
  name,
  aliases: [],
  category: 'other',
  defaultUnit: 'g',
  defaultShelfDays: 7,
  allergens: [],
  dietFlags: [],
  ...over,
});

const TAXONOMY: Taxonomy = createTaxonomy([
  ing('paneer', 'paneer', { category: 'dairy', allergens: ['milk'], dietFlags: ['dairy'] }),
  ing('palak', 'spinach', { category: 'produce', aliases: ['palak'] }),
  ing('ghee', 'ghee', { category: 'dairy', allergens: ['milk'], dietFlags: ['dairy'] }),
  ing('tofu', 'tofu', { allergens: ['soy'], dietFlags: ['legume'] }),
  ing('cashew', 'cashew', { allergens: ['tree_nuts'], dietFlags: ['nut'] }),
  ing('sunflower_seed', 'sunflower seed'),
  ing('chicken', 'chicken', { category: 'meat', dietFlags: ['meat', 'poultry'] }),
  ing('rice_basmati', 'basmati rice', { category: 'grains', dietFlags: ['grain'] }),
  ing('table_salt', 'salt', { category: 'spices' }),
]);

const SUBS: SubstitutionRow[] = [
  {
    fromId: 'paneer',
    toId: 'tofu',
    rule: 'vegan',
    ratioNote: 'Press tofu 20 minutes before marinating',
    explanation: 'Tofu takes marinade the same way paneer does.',
  },
  {
    fromId: 'ghee',
    toId: 'cashew',
    rule: 'vegan',
    ratioNote: null,
    explanation: 'Cashew cream stands in for ghee.',
  },
  {
    fromId: 'cashew',
    toId: 'sunflower_seed',
    rule: 'tree_nuts',
    ratioNote: null,
    explanation: 'Sunflower seeds carry the same richness without the nut.',
  },
];

const profile = (over: Partial<Profile> = {}): Profile => ({
  diets: [],
  allergens: [],
  exclusions: [],
  cuisines: [],
  maxCookMinutes: 45,
  servings: 2,
  spiceLevel: 'medium',
  timeZone: 'Asia/Kolkata',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

let rid = 0;
const recipe = (over: Partial<Recipe> = {}): Recipe => {
  rid += 1;
  return {
    id: `r${rid}`,
    source: 'seed',
    title: `Recipe ${rid}`,
    cuisine: 'indian',
    ingredients: [
      { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', note: null },
      { canonicalId: 'palak', name: 'spinach', quantity: 1, unit: 'bunch', note: null },
    ],
    steps: [],
    minutes: 30,
    servings: 2,
    dietTags: [],
    allergenTags: [],
    sourceUrl: null,
    creator: null,
    thumbnailUrl: null,
    trendingUntil: null,
    contentHash: `hash-${rid}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
};

let pid = 0;
const item = (over: Partial<PantryItem> = {}): PantryItem => {
  pid += 1;
  return {
    id: `p${pid}`,
    canonicalId: 'paneer',
    displayName: 'paneer',
    category: 'dairy',
    quantity: 500,
    unit: 'g',
    qtyConfidence: 'exact',
    addedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: null,
    expirySource: 'estimated',
    source: 'chat',
    deletedAt: null,
    ...over,
  };
};

const NOW = Date.parse('2026-09-27T12:00:00Z');

const fakeSearch = (recipes: Recipe[] = []): RecipeSearch => ({
  find: vi.fn(async () => recipes),
  byId: vi.fn(async (id: string) => recipes.find((r) => r.id === id) ?? null),
  byTitle: vi.fn(
    async (t: string) => recipes.find((r) => r.title.toLowerCase() === t.toLowerCase()) ?? null,
  ),
});

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title: 'Invented dish',
  cuisine: 'indian',
  minutes: 25,
  servings: 2,
  ingredients: [{ name: 'paneer', quantity: 200, unit: 'g', note: null }],
  steps: ['cook it'],
  ...over,
});

const fakeGenerate = (...drafts: RecipeDraft[]) =>
  vi.fn(
    async (): Promise<GenerateResult> => ({
      drafts,
      usage: { promptTokens: 800, completionTokens: 600 },
      attempts: 1,
    }),
  );

const baseDeps = { taxonomy: TAXONOMY, substitutions: SUBS, now: NOW };

/* -------------------------------- coverage -------------------------------- */

describe('pantry coverage', () => {
  it('counts what the pantry already has', () => {
    const c = coverageOf(recipe(), [item({ canonicalId: 'paneer' })], NOW);
    expect(c.coverage).toBe(0.5);
    expect(c.have).toEqual(['paneer']);
    expect(c.missing).toEqual(['spinach']);
  });

  it('matches on display name when the recipe line has no canonical id', () => {
    const c = coverageOf(
      { ingredients: [{ canonicalId: null, name: 'Paneer', quantity: 1, unit: 'g', note: null }] },
      [item({ canonicalId: null, displayName: 'paneer' })],
      NOW,
    );
    expect(c.coverage).toBe(1);
  });

  it('ignores quantity, because a suggestion is not a deduction', () => {
    // Someone with 20g of paneer can still be shown palak paneer. Demanding
    // enough of it would hide a dish they are one shop away from cooking.
    const c = coverageOf(recipe(), [item({ quantity: 1 }), item({ canonicalId: 'palak' })], NOW);
    expect(c.coverage).toBe(1);
  });

  it('ignores soft-deleted rows', () => {
    const c = coverageOf(recipe(), [item({ deletedAt: '2026-09-26T00:00:00Z' })], NOW);
    expect(c.coverage).toBe(0);
  });

  it('counts items going off within three days', () => {
    const c = coverageOf(
      recipe(),
      [
        item({ canonicalId: 'paneer', expiresAt: '2026-09-28T00:00:00Z' }),
        item({ canonicalId: 'palak', expiresAt: '2026-12-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(c.usesExpiring).toBe(1);
  });
});

/* -------------------------------- ranking --------------------------------- */

describe('ranking', () => {
  const suggestion = (over: Partial<Suggestion>): Suggestion => ({
    recipe: recipe(),
    pantryCoverage: 0,
    have: [],
    missing: [],
    swaps: [],
    usesExpiring: 0,
    source: 'catalog',
    advisories: [],
    ...over,
  });

  it('puts the best-covered dish first', () => {
    const ranked = rankSuggestions([
      suggestion({ pantryCoverage: 0.2 }),
      suggestion({ pantryCoverage: 0.9 }),
      suggestion({ pantryCoverage: 0.5 }),
    ]);
    expect(ranked.map((s) => s.pantryCoverage)).toEqual([0.9, 0.5, 0.2]);
  });

  it('breaks a tie on what is about to go off', () => {
    // Section 8 plans around using expiring items; a suggestion that saves
    // the spinach beats one that does not.
    const ranked = rankSuggestions([
      suggestion({ pantryCoverage: 0.5, usesExpiring: 0, recipe: recipe({ title: 'A' }) }),
      suggestion({ pantryCoverage: 0.5, usesExpiring: 2, recipe: recipe({ title: 'B' }) }),
    ]);
    expect(ranked[0]?.recipe.title).toBe('B');
  });

  it('prefers a dish that fits as written over one that had to be rebuilt', () => {
    const swap = {
      fromName: 'paneer',
      fromCanonicalId: 'paneer',
      toName: 'tofu',
      toCanonicalId: 'tofu',
      constraint: 'vegan' as const,
      explanation: '',
      note: null,
    };
    const ranked = rankSuggestions([
      suggestion({ pantryCoverage: 0.5, swaps: [swap], recipe: recipe({ title: 'Rebuilt' }) }),
      suggestion({ pantryCoverage: 0.5, swaps: [], recipe: recipe({ title: 'As written' }) }),
    ]);
    expect(ranked[0]?.recipe.title).toBe('As written');
  });

  it('is stable for genuinely equal suggestions', () => {
    const ranked = rankSuggestions([
      suggestion({ recipe: recipe({ title: 'Zebra' }) }),
      suggestion({ recipe: recipe({ title: 'Apple' }) }),
    ]);
    expect(ranked.map((s) => s.recipe.title)).toEqual(['Apple', 'Zebra']);
  });
});

/* ------------------------------- the gate ---------------------------------- */

describe('the safety gate', () => {
  it('passes a recipe that already fits, unchanged', async () => {
    const result = await gate(recipe(), profile(), baseDeps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.swaps).toEqual([]);
  });

  it('swaps paneer for tofu to make a dish vegan', async () => {
    const result = await gate(recipe(), profile({ diets: ['vegan'] }), baseDeps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.swaps[0]).toMatchObject({ fromName: 'paneer', toName: 'tofu' });
    expect(result.recipe.ingredients.map((i) => i.canonicalId)).toContain('tofu');
  });

  it('never offers cashew cream to a vegan with a tree-nut allergy', async () => {
    // Section 7 calls this out by name: it is why step 2 checks every rule in
    // the profile rather than only the violated one.
    const withGhee = recipe({
      ingredients: [{ canonicalId: 'ghee', name: 'ghee', quantity: 2, unit: 'tbsp', note: null }],
    });
    const result = await gate(
      withGhee,
      profile({ diets: ['vegan'], allergens: ['tree_nuts'] }),
      baseDeps,
    );
    if (result.ok) {
      expect(result.recipe.ingredients.map((i) => i.canonicalId)).not.toContain('cashew');
    }
  });

  it('drops a dish it cannot fix, and says why', async () => {
    const chicken = recipe({
      ingredients: [
        { canonicalId: 'chicken', name: 'chicken', quantity: 500, unit: 'g', note: null },
      ],
    });
    const result = await gate(chicken, profile({ diets: ['vegan'] }), baseDeps);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(10);
  });

  it('recomputes the tags rather than trusting what the recipe claimed', async () => {
    // Section 7: LLM-provided tags are discarded.
    const lying = recipe({ dietTags: ['vegan'], allergenTags: [] });
    const result = await gate(lying, profile(), baseDeps);
    expect(result.ok && result.recipe.allergenTags).toEqual(['milk']);
    expect(result.ok && result.recipe.dietTags).not.toContain('vegan');
  });
});

/* ----------------------------- suggest_recipes ----------------------------- */

describe('suggest_recipes', () => {
  it('returns catalog matches without calling a model', async () => {
    const out = await suggestRecipes(
      { query: 'paneer', pantry: [item()], profile: profile() },
      { ...baseDeps, search: fakeSearch([recipe(), recipe()]) },
    );
    expect(out.suggestions).toHaveLength(2);
    expect(out.modelCalled).toBe(false);
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('generates when the catalog comes up short', async () => {
    const generate = fakeGenerate(draft(), draft({ title: 'Another' }));
    const out = await suggestRecipes(
      { query: 'something', pantry: [], profile: profile(), limit: 2 },
      { ...baseDeps, search: fakeSearch([]), generate },
    );
    expect(generate).toHaveBeenCalled();
    expect(out.modelCalled).toBe(true);
    expect(out.suggestions.map((s) => s.source)).toEqual(['generated', 'generated']);
    expect(out.usage.completionTokens).toBe(600);
  });

  it('does not generate when the catalog already filled the slots', async () => {
    const generate = fakeGenerate(draft());
    await suggestRecipes(
      { query: 'x', pantry: [], profile: profile(), limit: 2 },
      { ...baseDeps, search: fakeSearch([recipe(), recipe(), recipe()]), generate },
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('answers catalog-only when there is no generator', async () => {
    // What happens when the budget refused the reservation.
    const out = await suggestRecipes(
      { query: 'x', pantry: [], profile: profile(), limit: 4 },
      { ...baseDeps, search: fakeSearch([recipe()]) },
    );
    expect(out.suggestions).toHaveLength(1);
    expect(out.modelCalled).toBe(false);
  });

  it('rescues a generated recipe when a swap exists', async () => {
    // The model does not know about the allergy and does not need to. The
    // gate rewrites what it can rather than discarding the idea.
    const out = await suggestRecipes(
      { query: 'anything', pantry: [], profile: profile({ allergens: ['milk'] }), limit: 4 },
      {
        ...baseDeps,
        search: fakeSearch([]),
        generate: fakeGenerate(
          draft({
            title: 'Paneer thing',
            ingredients: [{ name: 'paneer', quantity: 200, unit: 'g', note: null }],
          }),
        ),
      },
    );
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]?.swaps[0]).toMatchObject({ fromName: 'paneer', toName: 'tofu' });
    expect(out.suggestions[0]?.recipe.allergenTags).not.toContain('milk');
  });

  it('hides a generated recipe it cannot rescue, and says why', async () => {
    const out = await suggestRecipes(
      { query: 'anything', pantry: [], profile: profile({ diets: ['vegan'] }), limit: 4 },
      {
        ...baseDeps,
        search: fakeSearch([]),
        generate: fakeGenerate(
          draft({
            title: 'Chicken thing',
            ingredients: [{ name: 'chicken', quantity: 500, unit: 'g', note: null }],
          }),
        ),
      },
    );
    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped[0]?.title).toBe('Chicken thing');
    expect(out.dropped[0]?.reason.length).toBeGreaterThan(10);
  });

  it('hides a generated recipe naming an ingredient the taxonomy does not know', async () => {
    // An unresolvable ingredient is a hidden allergen as far as anyone with
    // an allergy is concerned (section 7).
    const out = await suggestRecipes(
      { query: 'anything', pantry: [], profile: profile({ allergens: ['peanuts'] }), limit: 4 },
      {
        ...baseDeps,
        search: fakeSearch([]),
        generate: fakeGenerate(
          draft({ ingredients: [{ name: 'mystery paste', quantity: 1, unit: 'tbsp', note: null }] }),
        ),
      },
    );
    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toHaveLength(1);
  });

  it('keeps that same recipe for a user with no allergies', async () => {
    const out = await suggestRecipes(
      { query: 'anything', pantry: [], profile: profile(), limit: 4 },
      {
        ...baseDeps,
        search: fakeSearch([]),
        generate: fakeGenerate(
          draft({ ingredients: [{ name: 'mystery paste', quantity: 1, unit: 'tbsp', note: null }] }),
        ),
      },
    );
    expect(out.suggestions).toHaveLength(1);
  });

  it('ranks the dish the pantry covers above the one it does not', async () => {
    const covered = recipe({
      title: 'Covered',
      ingredients: [{ canonicalId: 'paneer', name: 'paneer', quantity: 1, unit: 'g', note: null }],
    });
    const uncovered = recipe({
      title: 'Uncovered',
      ingredients: [{ canonicalId: 'chicken', name: 'chicken', quantity: 1, unit: 'g', note: null }],
    });
    const out = await suggestRecipes(
      { query: 'x', pantry: [item({ canonicalId: 'paneer' })], profile: profile() },
      { ...baseDeps, search: fakeSearch([uncovered, covered]) },
    );
    expect(out.suggestions[0]?.recipe.title).toBe('Covered');
  });

  it('respects the requested count', async () => {
    const out = await suggestRecipes(
      { query: 'x', pantry: [], profile: profile(), limit: 2 },
      { ...baseDeps, search: fakeSearch([recipe(), recipe(), recipe(), recipe()]) },
    );
    expect(out.suggestions).toHaveLength(2);
  });

  it('passes the time limit down to the catalog query', async () => {
    const search = fakeSearch([]);
    await suggestRecipes(
      { query: 'x', pantry: [], profile: profile(), maxMinutes: 20 },
      { ...baseDeps, search },
    );
    expect(search.find).toHaveBeenCalledWith(expect.objectContaining({ maxMinutes: 20 }));
  });

  it('does not pre-filter the catalog by diet or allergen tags', async () => {
    // Section 11's `?fits=me` keeps recipes that "pass **or can be
    // substituted**". Filtering on tags here would discard exactly the ones
    // substitution exists to rescue.
    const search = fakeSearch([]);
    await suggestRecipes(
      { query: 'x', pantry: [], profile: profile({ diets: ['vegan'], allergens: ['milk'] }) },
      { ...baseDeps, search },
    );
    const query = (search.find as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(query.requireDiets).toBeUndefined();
    expect(query.excludeAllergens).toBeUndefined();
  });

  it('tells the model what is already on the table so it offers something else', async () => {
    const generate = fakeGenerate(draft());
    await suggestRecipes(
      { query: 'x', pantry: [], profile: profile(), limit: 3 },
      { ...baseDeps, search: fakeSearch([recipe({ title: 'Already here' })]), generate },
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ avoidTitles: ['Already here'] }),
    );
  });

  it('survives a generator that returned nothing usable', async () => {
    const out = await suggestRecipes(
      { query: 'x', pantry: [], profile: profile() },
      {
        ...baseDeps,
        search: fakeSearch([recipe()]),
        generate: vi.fn(async () => ({
          drafts: [],
          usage: { promptTokens: 700, completionTokens: 0 },
          attempts: 2,
          error: 'bad json',
        })),
      },
    );
    expect(out.suggestions).toHaveLength(1);
    // The failed attempt still cost tokens and is still reported.
    expect(out.usage.promptTokens).toBe(700);
  });
});

/* -------------------------------- substitute -------------------------------- */

describe('substitute', () => {
  it('returns a fitting recipe untouched', async () => {
    const out = await substituteRecipe(
      { recipeTitle: 'Recipe 1', recipeId: 'r1' },
      profile(),
      { ...baseDeps, search: fakeSearch([recipe({ id: 'r1', title: 'Recipe 1' })]) },
    );
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.alreadyFitted).toBe(true);
    expect(out.status === 'ok' && out.swaps).toEqual([]);
  });

  it('applies the extra constraint without touching the saved profile', async () => {
    // Spike 3's "butter chicken but vegan": wanting one vegan dinner is not
    // the same as becoming vegan.
    const saved = profile();
    const out = await substituteRecipe(
      { recipeTitle: 'Recipe 1', recipeId: 'r1', extraDiets: ['vegan'] },
      saved,
      { ...baseDeps, search: fakeSearch([recipe({ id: 'r1', title: 'Recipe 1' })]) },
    );
    expect(out.status === 'ok' && out.swaps[0]).toMatchObject({ toName: 'tofu' });
    expect(saved.diets).toEqual([]);
  });

  it('keeps the profile allergens on top of the extra constraint', async () => {
    const withGhee = recipe({
      id: 'r1',
      title: 'Ghee thing',
      ingredients: [{ canonicalId: 'ghee', name: 'ghee', quantity: 2, unit: 'tbsp', note: null }],
    });
    const out = await substituteRecipe(
      { recipeTitle: 'Ghee thing', extraDiets: ['vegan'] },
      profile({ allergens: ['tree_nuts'] }),
      { ...baseDeps, search: fakeSearch([withGhee]) },
    );
    if (out.status === 'ok') {
      expect(out.recipe.ingredients.map((i) => i.canonicalId)).not.toContain('cashew');
    }
  });

  it('finds a recipe by title when no id was given', async () => {
    const out = await substituteRecipe({ recipeTitle: 'recipe 1' }, profile(), {
      ...baseDeps,
      search: fakeSearch([recipe({ id: 'r1', title: 'Recipe 1' })]),
    });
    expect(out.status).toBe('ok');
  });

  it('invents the dish when the catalog has never heard of it', async () => {
    const out = await substituteRecipe({ recipeTitle: 'Butter chicken' }, profile(), {
      ...baseDeps,
      search: fakeSearch([]),
      generate: fakeGenerate(draft({ title: 'Butter chicken' })),
    });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.source).toBe('generated');
  });

  it('says so plainly when it cannot find or build the dish', async () => {
    const out = await substituteRecipe({ recipeTitle: 'Nani special' }, profile(), {
      ...baseDeps,
      search: fakeSearch([]),
    });
    expect(out.status).toBe('not_found');
  });

  it('drops rather than guessing when nothing makes the dish fit', async () => {
    const chicken = recipe({
      id: 'r1',
      title: 'Chicken curry',
      ingredients: [
        { canonicalId: 'chicken', name: 'chicken', quantity: 500, unit: 'g', note: null },
      ],
    });
    const out = await substituteRecipe({ recipeTitle: 'Chicken curry' }, profile({ diets: ['vegan'] }), {
      ...baseDeps,
      search: fakeSearch([chicken]),
    });
    expect(out.status).toBe('dropped');
    expect(out.status === 'dropped' && out.reason).toBeTruthy();
  });

  it('reports the tokens a generation cost even when the result is dropped', async () => {
    const out = await substituteRecipe({ recipeTitle: 'Chicken thing' }, profile({ diets: ['vegan'] }), {
      ...baseDeps,
      search: fakeSearch([]),
      generate: fakeGenerate(
        draft({
          title: 'Chicken thing',
          ingredients: [{ name: 'chicken', quantity: 500, unit: 'g', note: null }],
        }),
      ),
    });
    expect(out.status).toBe('dropped');
    expect(out.usage.completionTokens).toBe(600);
  });
});

/* --------------------------------- drafts ---------------------------------- */

describe('turning a draft into a recipe', () => {
  it('resolves ingredient names to canonical ids', async () => {
    const r = await draftToRecipe(
      draft({ ingredients: [{ name: 'palak', quantity: 1, unit: 'bunch', note: null }] }),
      TAXONOMY,
      NOW,
    );
    expect(r.ingredients[0]?.canonicalId).toBe('palak');
  });

  it('leaves an unresolvable name null rather than guessing', async () => {
    const r = await draftToRecipe(
      draft({ ingredients: [{ name: 'unobtainium', quantity: 1, unit: 'g', note: null }] }),
      TAXONOMY,
      NOW,
    );
    expect(r.ingredients[0]?.canonicalId).toBeNull();
  });

  it('computes the tags itself', async () => {
    const r = await draftToRecipe(draft(), TAXONOMY, NOW);
    expect(r.allergenTags).toEqual(['milk']);
    expect(r.source).toBe('llm');
  });

  it('gives the same dish the same content hash, so it stores once', async () => {
    const a = await draftToRecipe(draft(), TAXONOMY, NOW);
    const b = await draftToRecipe(draft(), TAXONOMY, NOW);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
  });

  it('gives two different dishes different hashes', async () => {
    const a = await draftToRecipe(draft({ title: 'One' }), TAXONOMY, NOW);
    const b = await draftToRecipe(draft({ title: 'Two' }), TAXONOMY, NOW);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe('the profile summary handed to the model', () => {
  it('leads with the allergies', () => {
    expect(summariseProfile(profile({ allergens: ['peanuts'] }))).toMatch(/^allergic to peanuts/);
  });

  it('says so when there are none', () => {
    expect(summariseProfile(profile())).toContain('no allergies');
  });
});
