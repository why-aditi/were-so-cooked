import { type SubstitutionRow, type Taxonomy, createTaxonomy } from '@cooked/safety';
import type {
  CookingLogEntry,
  Ingredient,
  PantryItem,
  PlanMeal,
  Profile,
  Recipe,
  RecipeDraft,
  RecipeIngredient,
} from '@cooked/shared';
import type { GenerateRequest, GenerateResult } from '../recipes/generate.js';
import type { RecipeQuery, RecipeSearch } from '../recipes/store.js';

/**
 * A kitchen small enough to reason about, for the planner's tests.
 *
 * Deliberately not the safety package's fixtures: those exist to exercise
 * every diet rule once, and a planner test that fails should point at the
 * planner. What matters here is a handful of ingredients with different
 * categories, units and allergens, and one dish per slot.
 */

function ing(canonicalId: string, name: string, over: Partial<Ingredient> = {}): Ingredient {
  return {
    canonicalId,
    name,
    aliases: [],
    category: 'other',
    defaultUnit: 'g',
    defaultShelfDays: 7,
    allergens: [],
    dietFlags: [],
    ...over,
  };
}

export const TAXONOMY: Taxonomy = createTaxonomy([
  ing('paneer', 'paneer', { category: 'dairy', allergens: ['milk'], dietFlags: ['dairy'] }),
  ing('milk', 'milk', { category: 'dairy', allergens: ['milk'], dietFlags: ['dairy'] }),
  ing('tofu', 'tofu', { allergens: ['soy'], dietFlags: ['legume'] }),
  ing('palak', 'spinach', { category: 'produce', aliases: ['palak'] }),
  ing('dhaniya', 'coriander', { category: 'produce', defaultUnit: 'bunch' }),
  ing('tomato', 'tomato', { category: 'produce' }),
  ing('rice', 'basmati rice', { category: 'grains', dietFlags: ['grain'] }),
  ing('sugar', 'sugar', { category: 'sweets', dietFlags: ['refined_sugar'] }),
  ing('chicken', 'chicken', { category: 'meat', dietFlags: ['meat', 'poultry'] }),
  ing('table_salt', 'salt', { category: 'spices' }),
]);

export const SUBS: SubstitutionRow[] = [
  {
    fromId: 'paneer',
    toId: 'tofu',
    rule: 'vegan',
    ratioNote: 'Press tofu 20 minutes before marinating',
    explanation: 'Tofu takes marinade the same way paneer does.',
  },
  {
    fromId: 'milk',
    toId: 'tofu',
    rule: 'vegan',
    ratioNote: null,
    explanation: 'Blended silken tofu stands in for milk.',
  },
];

export const profile = (over: Partial<Profile> = {}): Profile => ({
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
export const recipe = (over: Partial<Recipe> = {}): Recipe => {
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
export const item = (over: Partial<PantryItem> = {}): PantryItem => {
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

export const cooked = (recipeTitle: string, cookedAt: string): CookingLogEntry => ({
  id: `log-${recipeTitle}`,
  recipeId: null,
  recipeTitle,
  cookedAt,
  deducted: [],
});

export const ri = (
  canonicalId: string | null,
  name: string,
  quantity: number | null,
  unit: RecipeIngredient['unit'],
): RecipeIngredient => ({ canonicalId, name, quantity, unit, note: null });

export const meal = (over: Partial<PlanMeal> = {}): PlanMeal => ({
  slot: 'dinner',
  recipeId: null,
  title: 'A dish',
  ingredients: [],
  minutes: 30,
  pantryCoverage: 0,
  swaps: [],
  ...over,
});

/**
 * A catalog that answers every query with the same list, unless a per-query
 * responder is given. `find` ignores the text filter on purpose: the planner's
 * slot terms are a hint to real search, and a test that mimicked the D1 LIKE
 * would be testing `d1RecipeSearch`, not the planner.
 */
export const fakeSearch = (
  recipes: Recipe[] | ((q: RecipeQuery) => Recipe[]),
): RecipeSearch => ({
  find: async (q) => (typeof recipes === 'function' ? recipes(q) : recipes),
  byId: async (id) => (typeof recipes === 'function' ? [] : recipes).find((r) => r.id === id) ?? null,
  byTitle: async (t) =>
    (typeof recipes === 'function' ? [] : recipes).find(
      (r) => r.title.toLowerCase() === t.toLowerCase(),
    ) ?? null,
});

export const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title: 'Invented dish',
  cuisine: 'indian',
  minutes: 25,
  servings: 2,
  ingredients: [{ name: 'paneer', quantity: 200, unit: 'g', note: null }],
  steps: [],
  ...over,
});

/** A generator that returns a fresh batch per call, so repair rounds differ. */
export const fakeGenerate = (
  batches: RecipeDraft[][],
): ((req: GenerateRequest) => Promise<GenerateResult>) & { calls: GenerateRequest[] } => {
  const calls: GenerateRequest[] = [];
  const fn = async (req: GenerateRequest): Promise<GenerateResult> => {
    calls.push(req);
    return {
      drafts: batches[Math.min(calls.length - 1, batches.length - 1)] ?? [],
      usage: { promptTokens: 1173, completionTokens: 94 },
      attempts: 1,
    };
  };
  return Object.assign(fn, { calls });
};
