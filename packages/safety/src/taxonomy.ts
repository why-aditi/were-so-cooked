import type { Ingredient, RecipeIngredient } from '@cooked/shared';

/**
 * Taxonomy lookup. Pure: the caller loads the D1 `ingredients` rows and hands
 * them in, so the engine never touches storage (section 3).
 */

export interface Taxonomy {
  /** Exact canonical id. */
  byId(id: string): Ingredient | undefined;
  /** Canonical id, name or alias, case-insensitive. */
  resolve(nameOrId: string | null | undefined): Ingredient | undefined;
  all(): Ingredient[];
}

const norm = (s: string): string => s.trim().toLowerCase();

export function createTaxonomy(ingredients: Ingredient[]): Taxonomy {
  const byId = new Map<string, Ingredient>();
  const byLabel = new Map<string, Ingredient>();

  for (const ing of ingredients) {
    byId.set(ing.canonicalId, ing);
    byLabel.set(norm(ing.canonicalId), ing);
    byLabel.set(norm(ing.name), ing);
    for (const alias of ing.aliases) byLabel.set(norm(alias), ing);
  }

  return {
    byId: (id) => byId.get(id),
    resolve(nameOrId) {
      if (!nameOrId) return undefined;
      return byId.get(nameOrId) ?? byLabel.get(norm(nameOrId));
    },
    all: () => [...byId.values()],
  };
}

/**
 * A recipe ingredient paired with its taxonomy entry, or `undefined` when it
 * does not resolve.
 *
 * An unresolved ingredient is the dangerous case, not the boring one: the
 * engine cannot know what is in it, so section 7 says anything it cannot verify
 * is blocked. Keeping `entry` explicitly optional means every rule has to
 * decide what to do about that rather than reading an empty flag list and
 * concluding the ingredient is safe.
 */
export interface ResolvedIngredient {
  /** As written in the recipe. */
  name: string;
  canonicalId: string | null;
  entry: Ingredient | undefined;
  source: RecipeIngredient;
}

export function resolveAll(
  ingredients: RecipeIngredient[],
  taxonomy: Taxonomy,
): ResolvedIngredient[] {
  return ingredients.map((source) => {
    const entry = taxonomy.resolve(source.canonicalId) ?? taxonomy.resolve(source.name);
    return {
      name: source.name,
      canonicalId: entry?.canonicalId ?? source.canonicalId ?? null,
      entry,
      source,
    };
  });
}
