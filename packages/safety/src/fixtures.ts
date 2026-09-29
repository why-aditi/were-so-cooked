import type { Allergen, Diet, Ingredient, Recipe, RecipeIngredient } from '@cooked/shared';
import type { SubstitutionRow } from './substitute.js';

/**
 * A small taxonomy for tests, not the real one.
 *
 * The real seed targets ~1,500 ingredients (section 7) and lives in D1. This
 * covers every allergen in the enum, every flag any diet rule reads, and every
 * row of section 7's worked examples — enough to exercise each rule exactly
 * once without pretending to be a food database.
 */

function ing(
  canonicalId: string,
  name: string,
  allergens: Ingredient['allergens'],
  dietFlags: Ingredient['dietFlags'],
  extra: Partial<Ingredient> = {},
): Ingredient {
  return {
    canonicalId,
    name,
    aliases: [],
    category: 'other',
    // Unit is irrelevant to every safety rule, so the fixtures use one value
    // and let `extra` override it where a test cares.
    defaultUnit: 'packet',
    defaultShelfDays: 7,
    allergens,
    dietFlags,
    ...extra,
  };
}

export const TEST_INGREDIENTS: Ingredient[] = [
  /* ---- section 7's taxonomy table, verbatim ---- */
  ing('paneer', 'paneer', ['milk'], ['dairy'], { aliases: ['cottage cheese'], category: 'dairy' }),
  ing('ghee', 'ghee', ['milk'], ['dairy'], { category: 'dairy' }),
  ing('khoa', 'khoa', ['milk'], ['dairy'], { category: 'dairy' }),
  ing('soy_sauce', 'soy sauce', ['soy', 'gluten'], ['gluten'], { category: 'condiments' }),
  ing('fish_sauce', 'fish sauce', ['fish'], ['fish'], { category: 'condiments' }),
  ing('oyster_sauce', 'oyster sauce', ['molluscs'], ['shellfish'], { category: 'condiments' }),
  ing('worcestershire', 'Worcestershire sauce', ['fish'], ['fish'], { category: 'condiments' }),
  ing('pesto', 'pesto', ['tree_nuts', 'milk'], ['dairy'], { category: 'condiments' }),
  ing('tahini', 'tahini', ['sesame'], [], { category: 'condiments' }),
  ing('naan', 'naan', ['gluten', 'milk'], ['gluten', 'dairy', 'grain'], { category: 'bakery' }),
  ing('mayonnaise', 'mayonnaise', ['egg'], ['egg'], { category: 'condiments' }),
  ing('onion', 'onion', [], ['allium', 'root', 'high_fodmap'], { aliases: ['pyaz'] }),
  ing('garlic', 'garlic', [], ['allium', 'root', 'high_fodmap'], { aliases: ['lehsun'] }),
  ing('potato', 'potato', [], ['root', 'starchy'], { aliases: ['aloo'] }),
  ing('carrot', 'carrot', [], ['root'], { aliases: ['gajar'] }),
  ing('ginger', 'ginger', [], ['root'], { aliases: ['adrak'] }),

  /* ---- flesh, for the vegetarian family ---- */
  ing('chicken', 'chicken', [], ['meat', 'poultry'], { category: 'meat' }),
  ing('beef', 'beef', [], ['meat', 'beef'], { category: 'meat' }),
  ing('pork', 'pork', [], ['meat', 'pork'], { category: 'meat' }),
  ing('salmon', 'salmon', ['fish'], ['fish'], { category: 'seafood' }),
  ing('prawn', 'prawn', ['crustaceans'], ['shellfish'], { category: 'seafood' }),

  /* ---- the remaining allergens, one carrier each ---- */
  ing('egg', 'egg', ['egg'], ['egg']),
  ing('milk', 'milk', ['milk'], ['dairy'], { category: 'dairy' }),
  ing('peanut', 'peanut', ['peanuts'], ['nut', 'legume']),
  ing('cashew', 'cashew', ['tree_nuts'], ['nut']),
  ing('mustard_seed', 'mustard seed', ['mustard'], [], { category: 'spices' }),
  ing('celery', 'celery', ['celery'], []),
  ing('lupin_flour', 'lupin flour', ['lupin'], ['legume']),
  ing('wine', 'wine', ['sulphites'], ['alcohol'], { category: 'beverages' }),

  /* ---- animal products beyond flesh ---- */
  ing('honey', 'honey', [], ['honey'], { category: 'sweets' }),
  ing('gelatin', 'gelatin', [], ['animal_derived']),
  ing('butter', 'butter', ['milk'], ['dairy'], { category: 'dairy' }),
  ing('cream', 'cream', ['milk'], ['dairy'], { category: 'dairy' }),

  /* ---- grains, legumes, sugars, FODMAPs ---- */
  ing('wheat_flour', 'wheat flour', ['gluten'], ['gluten', 'grain'], { aliases: ['atta', 'maida'] }),
  ing('rice', 'rice', [], ['grain'], { category: 'grains' }),
  ing('kuttu_flour', 'kuttu flour', [], ['grain', 'vrat_ok'], { aliases: ['buckwheat flour'] }),
  ing('singhara_flour', 'singhara flour', [], ['grain', 'vrat_ok']),
  ing('rock_salt', 'rock salt', [], ['vrat_ok'], { aliases: ['sendha namak'] }),
  ing('rajma', 'rajma', [], ['legume'], { category: 'legumes' }),
  ing('chana', 'chana', [], ['legume', 'high_fodmap'], { category: 'legumes' }),
  ing('sugar', 'sugar', [], ['refined_sugar'], { category: 'sweets' }),

  /* ---- the substitution targets from section 7's swap table ---- */
  ing('tofu', 'tofu', ['soy'], ['legume']),
  ing('soya_chaap', 'soya chaap', ['soy'], ['legume']),
  ing('tamari', 'tamari', ['soy'], [], { category: 'condiments' }),
  ing('cashew_cream', 'cashew cream', ['tree_nuts'], ['nut']),
  ing('sunflower_cream', 'sunflower-seed cream', [], []),
  ing('oat_cream', 'oat cream', [], ['grain']),
  ing('coconut_oil', 'coconut oil', [], []),
  ing('flax_egg', 'flax egg', [], []),
  // Section 7's note: "Hing must be gluten-free if also gluten-free." Commercial
  // hing is usually cut with wheat flour, so the default carries gluten and the
  // gluten-free variant is a separate entry.
  ing('hing', 'hing', ['gluten'], ['gluten'], { aliases: ['asafoetida'] }),
  ing('hing_gf', 'gluten-free hing', [], []),
  ing('tomato', 'tomato', [], []),
  ing('palak', 'palak', [], [], { aliases: ['spinach'] }),
  ing('mushroom', 'mushroom', [], ['high_fodmap']),
];

/** Section 7's swap table, plus the alternates its cashew example implies. */
export const TEST_SUBSTITUTIONS: SubstitutionRow[] = [
  { fromId: 'chicken', toId: 'soya_chaap', rule: 'vegan', ratioNote: null, explanation: 'Soya chaap holds up to the same marinade.' },
  { fromId: 'chicken', toId: 'tofu', rule: 'vegan', ratioNote: 'Press tofu 20 minutes before marinating.', explanation: 'Extra-firm tofu takes the place of chicken.' },
  // Deliberately ordered cashew-first: the engine must reject it for a
  // tree-nut allergy and fall through to coconut oil.
  { fromId: 'butter', toId: 'cashew_cream', rule: 'vegan', ratioNote: 'Blend soaked cashews until smooth.', explanation: 'Cashew cream replaces butter.' },
  { fromId: 'butter', toId: 'coconut_oil', rule: 'vegan', ratioNote: null, explanation: 'Coconut oil replaces butter.' },
  { fromId: 'cream', toId: 'cashew_cream', rule: 'vegan', ratioNote: null, explanation: 'Cashew cream replaces dairy cream.' },
  { fromId: 'cashew_cream', toId: 'sunflower_cream', rule: 'tree_nuts', ratioNote: null, explanation: 'Sunflower-seed cream, chosen because it passes both rules.' },
  { fromId: 'cashew_cream', toId: 'oat_cream', rule: 'tree_nuts', ratioNote: null, explanation: 'Oat cream, chosen because it passes both rules.' },
  { fromId: 'egg', toId: 'flax_egg', rule: 'vegan', ratioNote: '1 tbsp ground flax + 3 tbsp water.', explanation: 'Flax egg binds in place of egg.' },
  { fromId: 'onion', toId: 'hing_gf', rule: 'jain', ratioNote: null, explanation: 'Hing and a tomato base stand in for onion.' },
  { fromId: 'garlic', toId: 'hing_gf', rule: 'jain', ratioNote: null, explanation: 'Hing and a tomato base stand in for garlic.' },
  { fromId: 'soy_sauce', toId: 'tamari', rule: 'gluten_free', ratioNote: null, explanation: 'Tamari is brewed without wheat.' },
  { fromId: 'paneer', toId: 'tofu', rule: 'vegan', ratioNote: null, explanation: 'Tofu replaces paneer.' },
  { fromId: 'wheat_flour', toId: 'kuttu_flour', rule: 'navratri', ratioNote: null, explanation: 'Kuttu flour is vrat-permitted.' },
  { fromId: 'milk', toId: 'oat_cream', rule: 'vegan', ratioNote: null, explanation: 'Oat cream replaces milk.' },
];

export function ri(nameOrId: string, over: Partial<RecipeIngredient> = {}): RecipeIngredient {
  return { canonicalId: nameOrId, name: nameOrId, quantity: 1, unit: 'piece', note: null, ...over };
}

/** A complete Recipe with only the ingredients varying. */
export function recipe(ingredientIds: string[], over: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    source: 'seed',
    title: 'Test dish',
    cuisine: 'indian',
    ingredients: ingredientIds.map((i) => ri(i)),
    steps: [],
    minutes: 30,
    servings: 2,
    dietTags: [],
    allergenTags: [],
    sourceUrl: null,
    creator: null,
    thumbnailUrl: null,
    trendingUntil: null,
    contentHash: 'hash',
    createdAt: '2026-09-25T00:00:00Z',
    ...over,
  };
}

export const EMPTY_PROFILE: {
  diets: Diet[];
  allergens: Allergen[];
  exclusions: string[];
} = { diets: [], allergens: [], exclusions: [] };
