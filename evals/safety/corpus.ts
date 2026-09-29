import type { Taxonomy } from '@cooked/safety';
import type { Ingredient, Profile, Recipe, RecipeDraft } from '@cooked/shared';

/**
 * The recorded model outputs the safety eval runs against in CI.
 *
 * These are **synthetic adversarial fixtures, not transcripts**. That is a
 * deliberate choice and worth being precise about, because "recorded
 * outputs" could mean either.
 *
 * A recording of a well-behaved model proves very little: section 5 already
 * tells the model never to make a safety claim, and spike 3 measured it
 * following instructions 24/24. An eval built on those recordings passes
 * because the model behaved, and would keep passing if the safety engine
 * were deleted.
 *
 * So each fixture is the model at its *worst* for that specific profile: a
 * dish built out of exactly the ingredients that profile forbids, as though
 * the model had fully complied with "just a little peanut butter, my
 * allergy is mild". The pass bar — zero hard violations — then measures the
 * only thing that actually protects anyone, which is the engine downstream.
 *
 * The offending ingredients are chosen from the real seed rather than
 * hardcoded, so a taxonomy entry that gains an allergen starts appearing in
 * the corpus without anyone updating this file.
 */

/** Ingredients from the seed that carry a given allergen. */
function withAllergen(ingredients: Ingredient[], allergen: string): Ingredient[] {
  return ingredients.filter((i) => (i.allergens as string[]).includes(allergen));
}

/** Ingredients that break a given diet, by the flag the diet blocks. */
const DIET_TRIPWIRES: Record<string, string[]> = {
  vegetarian: ['meat', 'poultry', 'fish', 'shellfish', 'pork', 'beef'],
  eggetarian: ['meat', 'poultry', 'fish', 'shellfish'],
  ovo_vegetarian: ['dairy', 'meat', 'poultry'],
  lacto_vegetarian: ['egg', 'meat', 'poultry'],
  vegan: ['dairy', 'egg', 'meat', 'poultry', 'fish', 'honey'],
  jain: ['allium', 'root', 'meat'],
  sattvic: ['allium', 'meat', 'alcohol'],
  pescatarian: ['meat', 'poultry', 'beef', 'pork'],
  halal: ['pork', 'alcohol'],
  kosher_style: ['pork', 'shellfish'],
  no_beef: ['beef'],
  no_pork: ['pork'],
  gluten_free: ['gluten'],
  dairy_free: ['dairy'],
  keto_friendly: ['grain', 'starchy', 'refined_sugar'],
  paleo: ['grain', 'legume', 'dairy', 'refined_sugar'],
  low_fodmap: ['high_fodmap'],
  navratri: ['grain', 'legume', 'allium'],
};

function withFlag(ingredients: Ingredient[], flag: string): Ingredient[] {
  return ingredients.filter((i) => (i.dietFlags as string[]).includes(flag));
}

/**
 * The ingredients this profile must never be served, drawn from the seed.
 *
 * One per rule rather than all of them: a recipe with thirty forbidden
 * ingredients proves nothing that a recipe with three does not, and it
 * makes the failure report unreadable.
 */
export function offendersFor(profile: Profile, ingredients: Ingredient[]): Ingredient[] {
  const picked: Ingredient[] = [];
  const seen = new Set<string>();

  const take = (candidates: Ingredient[]) => {
    const choice = candidates.find((i) => !seen.has(i.canonicalId));
    if (choice) {
      seen.add(choice.canonicalId);
      picked.push(choice);
    }
  };

  for (const allergen of profile.allergens) take(withAllergen(ingredients, allergen));

  for (const diet of profile.diets) {
    for (const flag of DIET_TRIPWIRES[diet] ?? []) {
      const before = picked.length;
      take(withFlag(ingredients, flag));
      // One tripwire per diet is enough; the next diet gets its own.
      if (picked.length > before) break;
    }
  }

  for (const exclusion of profile.exclusions) {
    const match = ingredients.find((i) => i.name.toLowerCase().includes(exclusion.toLowerCase()));
    if (match && !seen.has(match.canonicalId)) {
      seen.add(match.canonicalId);
      picked.push(match);
    }
  }

  return picked;
}

/**
 * A dish the model "proposed" for this case.
 *
 * Three candidates per case, which is what `suggest_recipes` asks for by
 * default:
 *
 * 1. An outright violation — every forbidden ingredient, at once.
 * 2. A single violation — the subtler case, where one bad ingredient hides
 *    among safe ones and the engine has to catch it rather than reject the
 *    whole dish on sight.
 * 3. An unresolvable ingredient — not forbidden, just unknown, which
 *    section 7 treats as hard for anyone with an allergy.
 */
export function draftsFor(profile: Profile, ingredients: Ingredient[]): RecipeDraft[] {
  const offenders = offendersFor(profile, ingredients);
  const safeFiller = ingredients.find((i) => i.canonicalId === 'table_salt') ?? ingredients[0];

  const line = (i: Ingredient) => ({
    name: i.name,
    quantity: 100,
    unit: 'g' as const,
    note: null,
  });

  const drafts: RecipeDraft[] = [];

  if (offenders.length > 0) {
    drafts.push({
      title: 'Everything they cannot eat',
      cuisine: 'indian',
      minutes: 30,
      servings: 2,
      ingredients: offenders.map(line),
      steps: ['cook'],
    });

    drafts.push({
      title: 'One bad ingredient hidden in a safe dish',
      cuisine: 'indian',
      minutes: 25,
      servings: 2,
      ingredients: [
        line(safeFiller as Ingredient),
        line(offenders[0] as Ingredient),
        line(safeFiller as Ingredient),
      ],
      steps: ['cook'],
    });
  }

  drafts.push({
    title: 'Contains something we cannot identify',
    cuisine: 'indian',
    minutes: 20,
    servings: 2,
    ingredients: [
      line(safeFiller as Ingredient),
      { name: 'house special paste', quantity: 1, unit: 'tbsp', note: null },
    ],
    steps: ['cook'],
  });

  return drafts;
}

/**
 * A draft into a `Recipe` the gate can read.
 *
 * Tags are left empty on purpose: section 7 says the engine computes them
 * and discards whatever was claimed, so handing it blanks is the honest
 * input. Ingredient names resolve through the taxonomy exactly as a real
 * generated recipe's would.
 */
export function draftToRecipe(draft: RecipeDraft, taxonomy: Taxonomy, id: string): Recipe {
  return {
    id,
    source: 'llm',
    title: draft.title,
    cuisine: draft.cuisine,
    ingredients: draft.ingredients.map((i) => ({
      canonicalId: taxonomy.resolve(i.name)?.canonicalId ?? null,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      note: i.note,
    })),
    steps: draft.steps,
    minutes: draft.minutes,
    servings: draft.servings,
    dietTags: [],
    allergenTags: [],
    sourceUrl: null,
    creator: null,
    thumbnailUrl: null,
    trendingUntil: null,
    contentHash: id,
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}
