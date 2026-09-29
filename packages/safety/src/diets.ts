import type { Diet, IngredientFlag } from '@cooked/shared';
import type { ResolvedIngredient } from './taxonomy.js';

/**
 * Section 7's diet table, as rules over ingredient flags.
 *
 * Three kinds of rule, because not every diet in the table is a blocklist:
 *
 *   blockedFlags   any ingredient carrying one of these violates the diet.
 *   ingredientRule a conditional on one ingredient — Navratri permits grains,
 *                  but only vrat-flagged ones, which a blocklist cannot say.
 *   recipeRule     a rule about the combination — kosher-style forbids meat
 *                  and dairy in one dish, and neither ingredient is wrong alone.
 *
 * `advisory` carries text that is not a violation: halal permits meat but the
 * UI must say "use halal-certified". Advisories never make a recipe fail.
 */

export interface DietRule {
  diet: Diet;
  label: string;
  blockedFlags: IngredientFlag[];
  /** @returns a reason when this one ingredient breaks the diet. */
  ingredientRule?: (ing: ResolvedIngredient) => string | null;
  /** @returns reasons that only the whole ingredient list can reveal. */
  recipeRule?: (ings: ResolvedIngredient[]) => { ingredientName: string; reason: string }[];
  advisory?: (ings: ResolvedIngredient[]) => string | null;
}

const has = (ing: ResolvedIngredient, flag: IngredientFlag): boolean =>
  ing.entry?.dietFlags.includes(flag) ?? false;

/** Flesh of any kind. The base every vegetarian variant is built from. */
const FLESH: IngredientFlag[] = ['meat', 'poultry', 'fish', 'shellfish', 'pork', 'beef'];

/**
 * Section 7 lists "Vegetarian | No meat, poultry, fish or shellfish" and then
 * "Eggetarian / ovo-vegetarian / lacto-vegetarian | Vegetarian, with eggs or
 * dairy allowed as named" — which only makes sense if the base excludes both
 * eggs and dairy, since otherwise the named variants permit nothing new.
 *
 * Read literally, `vegetarian` would allow eggs and the three variants would be
 * redundant. This app is India-centric (paneer, Jain, sattvic, navratri), where
 * "vegetarian" conventionally excludes eggs and includes dairy. So:
 *
 *   vegetarian       no flesh, no egg. Dairy allowed.
 *   eggetarian       no flesh. Egg and dairy allowed.
 *   ovo_vegetarian   no flesh, no dairy. Egg allowed.
 *   lacto_vegetarian no flesh, no egg. Dairy allowed.
 *
 * This is a judgment call on an ambiguous spec, resolved toward the stricter
 * reading: serving egg to someone who did not expect it is a worse failure than
 * withholding a dish from someone who would have eaten it.
 */
export const DIET_RULES: Record<Diet, DietRule> = {
  vegetarian: {
    diet: 'vegetarian',
    label: 'vegetarian',
    blockedFlags: [...FLESH, 'egg'],
  },
  eggetarian: {
    diet: 'eggetarian',
    label: 'eggetarian',
    blockedFlags: [...FLESH],
  },
  ovo_vegetarian: {
    diet: 'ovo_vegetarian',
    label: 'ovo-vegetarian',
    blockedFlags: [...FLESH, 'dairy'],
  },
  lacto_vegetarian: {
    diet: 'lacto_vegetarian',
    label: 'lacto-vegetarian',
    blockedFlags: [...FLESH, 'egg'],
  },
  vegan: {
    diet: 'vegan',
    label: 'vegan',
    blockedFlags: [...FLESH, 'egg', 'dairy', 'honey', 'animal_derived'],
  },
  jain: {
    diet: 'jain',
    label: 'Jain',
    // Vegetarian, plus no eggs, root vegetables, alliums or honey.
    blockedFlags: [...FLESH, 'egg', 'root', 'allium', 'honey'],
  },
  sattvic: {
    diet: 'sattvic',
    label: 'sattvic (no onion or garlic)',
    blockedFlags: ['allium'],
  },
  pescatarian: {
    diet: 'pescatarian',
    label: 'pescatarian',
    blockedFlags: ['meat', 'poultry', 'pork', 'beef'],
  },
  halal: {
    diet: 'halal',
    label: 'halal',
    blockedFlags: ['pork', 'alcohol'],
    // Section 7: meat is permitted but shown as "use halal-certified". That is
    // guidance, not a violation, so it never blocks a recipe.
    advisory: (ings) =>
      ings.some((i) => has(i, 'meat') || has(i, 'poultry') || has(i, 'beef'))
        ? 'Use halal-certified meat.'
        : null,
  },
  kosher_style: {
    diet: 'kosher_style',
    label: 'kosher-style',
    blockedFlags: ['pork', 'shellfish'],
    // "No meat with dairy in one dish" — a combination rule. Neither the meat
    // nor the dairy is wrong on its own, which is why a flag blocklist cannot
    // express it.
    recipeRule: (ings) => {
      const meat = ings.find((i) => has(i, 'meat') || has(i, 'poultry') || has(i, 'beef'));
      const dairy = ings.find((i) => has(i, 'dairy'));
      if (!meat || !dairy) return [];
      return [
        {
          ingredientName: dairy.name,
          reason: `kosher-style does not mix meat and dairy in one dish (with ${meat.name})`,
        },
      ];
    },
  },
  no_beef: { diet: 'no_beef', label: 'no beef', blockedFlags: ['beef'] },
  no_pork: { diet: 'no_pork', label: 'no pork', blockedFlags: ['pork'] },
  gluten_free: { diet: 'gluten_free', label: 'gluten-free', blockedFlags: ['gluten'] },
  dairy_free: { diet: 'dairy_free', label: 'dairy-free', blockedFlags: ['dairy'] },
  keto_friendly: {
    diet: 'keto_friendly',
    label: 'keto-friendly',
    // Section 7 calls this approximate: flags only, no macro counting.
    blockedFlags: ['grain', 'refined_sugar', 'starchy'],
  },
  paleo: {
    diet: 'paleo',
    label: 'paleo',
    blockedFlags: ['grain', 'legume', 'dairy', 'refined_sugar'],
  },
  low_fodmap: {
    diet: 'low_fodmap',
    label: 'low-FODMAP',
    blockedFlags: ['high_fodmap'],
  },
  navratri: {
    diet: 'navratri',
    label: 'Navratri / vrat',
    blockedFlags: ['allium'],
    /**
     * "Only vrat-flagged grains and flours" is an allowlist inside a category,
     * not a blocklist: wheat is out, but kuttu and singhara are in. A grain
     * without `vrat_ok` fails; a non-grain is unaffected by this rule.
     */
    ingredientRule: (ing) =>
      has(ing, 'grain') && !has(ing, 'vrat_ok')
        ? 'not a vrat-permitted grain or flour'
        : null,
  },
};

export const ALL_DIETS = Object.keys(DIET_RULES) as Diet[];
