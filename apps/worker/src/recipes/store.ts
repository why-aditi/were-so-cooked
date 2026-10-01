import { createTaxonomy, type Taxonomy } from '@cooked/safety';
import type { Ingredient, Recipe, RecipeIngredient, Unit } from '@cooked/shared';

/**
 * The shared recipe catalog in D1 (section 4), and the search behind
 * `suggest_recipes`.
 *
 * Section 12 asks for one `RecipeSearch` interface with Vectorize and D1
 * behind it, "so switching is a config change". The interface is here and the
 * D1 implementation is below.
 *
 * ponytail: the Vectorize implementation is not written yet, and not because
 * it was forgotten. Semantic search needs an embedding per recipe, and the
 * only thing that writes those is `ViralRecipesWorkflow`, which is week 3. An
 * index with nothing in it would rank nothing, so today's search is SQL over
 * the tags D1 already holds. When the pipeline starts writing vectors, add
 * `vectorizeRecipeSearch(env)` next to `d1RecipeSearch(env)` and change the
 * caller — spike 1 measured a 68-second lag before a vector is queryable, so
 * whichever lands must treat D1 as authoritative either way.
 */

export interface RecipeQuery {
  /** Free text from the user. Matched against title and cuisine for now. */
  text?: string;
  /** Excludes recipes whose computed allergen tags intersect this. */
  excludeAllergens?: string[];
  /** Keeps only recipes carrying every one of these computed diet tags. */
  requireDiets?: string[];
  maxMinutes?: number;
  /** Only recipes still inside their trending window. */
  trendingOnly?: boolean;
  limit?: number;
}

export interface RecipeSearch {
  find(query: RecipeQuery): Promise<Recipe[]>;
  byId(id: string): Promise<Recipe | null>;
  byTitle(title: string): Promise<Recipe | null>;
}

interface RecipeRow {
  id: string;
  source: string;
  title: string;
  cuisine: string;
  ingredients: string;
  steps: string;
  minutes: number;
  servings: number;
  diet_tags: string;
  allergen_tags: string;
  source_url: string | null;
  creator: string | null;
  thumbnail_url: string | null;
  trending_until: string | null;
  content_hash: string;
  created_at: string;
}

const COLUMNS =
  'id, source, title, cuisine, ingredients, steps, minutes, servings, diet_tags, ' +
  'allergen_tags, source_url, creator, thumbnail_url, trending_until, content_hash, created_at';

export function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    source: row.source as Recipe['source'],
    title: row.title,
    cuisine: row.cuisine,
    ingredients: JSON.parse(row.ingredients) as RecipeIngredient[],
    steps: JSON.parse(row.steps) as string[],
    minutes: row.minutes,
    servings: row.servings,
    dietTags: JSON.parse(row.diet_tags) as Recipe['dietTags'],
    allergenTags: JSON.parse(row.allergen_tags) as Recipe['allergenTags'],
    sourceUrl: row.source_url,
    creator: row.creator,
    thumbnailUrl: row.thumbnail_url,
    trendingUntil: row.trending_until,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

/**
 * Tag filtering in SQL.
 *
 * The tag columns are JSON arrays, so this uses `LIKE '%"peanuts"%'` rather
 * than a join table. That is a scan, and it is fine: section 4 budgets about
 * 4,800 recipes, and D1 reads that many rows in well under the CPU limit.
 *
 * It is also only a pre-filter. Nothing downstream trusts it — every
 * candidate goes through the safety engine afterwards, which reads the actual
 * ingredients rather than the tags. A tag that is stale or wrong costs a
 * wasted candidate, never a missed allergen.
 */
export function d1RecipeSearch(db: D1Database): RecipeSearch {
  return {
    async find(query: RecipeQuery): Promise<Recipe[]> {
      const clauses: string[] = [];
      const binds: unknown[] = [];

      if (query.text) {
        clauses.push('(lower(title) LIKE ? OR lower(cuisine) LIKE ?)');
        const like = `%${query.text.toLowerCase()}%`;
        binds.push(like, like);
      }
      for (const allergen of query.excludeAllergens ?? []) {
        clauses.push('allergen_tags NOT LIKE ?');
        binds.push(`%"${allergen}"%`);
      }
      for (const diet of query.requireDiets ?? []) {
        clauses.push('diet_tags LIKE ?');
        binds.push(`%"${diet}"%`);
      }
      if (query.maxMinutes !== undefined) {
        clauses.push('minutes <= ?');
        binds.push(query.maxMinutes);
      }
      if (query.trendingOnly) {
        clauses.push('trending_until IS NOT NULL AND trending_until > ?');
        binds.push(new Date().toISOString());
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM recipes ${where} ORDER BY created_at DESC LIMIT ?`)
        .bind(...binds, query.limit ?? 20)
        .all<RecipeRow>();
      return (results ?? []).map(toRecipe);
    },

    async byId(id: string): Promise<Recipe | null> {
      const row = await db
        .prepare(`SELECT ${COLUMNS} FROM recipes WHERE id = ?`)
        .bind(id)
        .first<RecipeRow>();
      return row ? toRecipe(row) : null;
    },

    async byTitle(title: string): Promise<Recipe | null> {
      const row = await db
        .prepare(`SELECT ${COLUMNS} FROM recipes WHERE lower(title) = lower(?) LIMIT 1`)
        .bind(title)
        .first<RecipeRow>();
      return row ? toRecipe(row) : null;
    },
  };
}

/**
 * Stores a recipe the model generated, so the next person asking gets it for
 * free (section 12: "Recipe steps are generated once, stored in D1, and
 * reused for every user").
 *
 * `contentHash` carries a UNIQUE index, so `INSERT OR IGNORE` makes this
 * idempotent: two users generating the same dish in the same minute produce
 * one row, not a duplicate and not an error.
 */
export async function saveRecipe(db: D1Database, recipe: Recipe): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO recipes
         (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      recipe.id,
      recipe.source,
      recipe.title,
      recipe.cuisine,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.steps),
      recipe.minutes,
      recipe.servings,
      JSON.stringify(recipe.dietTags),
      JSON.stringify(recipe.allergenTags),
      recipe.sourceUrl,
      recipe.creator,
      recipe.thumbnailUrl,
      recipe.trendingUntil,
      recipe.contentHash,
      recipe.createdAt,
    )
    .run();
}

/** The curated swap table from section 7, read once per call that needs it. */
export async function loadSubstitutions(db: D1Database): Promise<
  { fromId: string; toId: string; rule: string; ratioNote: string | null; explanation: string }[]
> {
  const { results } = await db
    .prepare('SELECT from_id, to_id, rule, ratio_note, explanation FROM substitutions')
    .all<{
      from_id: string;
      to_id: string;
      rule: string;
      ratio_note: string | null;
      explanation: string;
    }>();
  return (results ?? []).map((r) => ({
    fromId: r.from_id,
    toId: r.to_id,
    rule: r.rule,
    ratioNote: r.ratio_note,
    explanation: r.explanation,
  }));
}

/**
 * The ingredient taxonomy from the shared D1 (section 7).
 *
 * Shared by the agent, which holds the result for its lifetime, and by the
 * Workflows, which read it once per step that needs it. ~800 rows is one
 * small query either way.
 */
export async function loadTaxonomy(db: D1Database): Promise<Taxonomy> {
  const { results } = await db
    .prepare(
      'SELECT canonical_id, name, aliases, category, default_unit, default_shelf_days, allergens, diet_flags FROM ingredients',
    )
    .all<{
      canonical_id: string;
      name: string;
      aliases: string;
      category: string;
      default_unit: string;
      default_shelf_days: number | null;
      allergens: string;
      diet_flags: string;
    }>();

  const ingredients: Ingredient[] = (results ?? []).map((r) => ({
    canonicalId: r.canonical_id,
    name: r.name,
    aliases: JSON.parse(r.aliases) as string[],
    category: r.category as Ingredient['category'],
    defaultUnit: r.default_unit as Unit,
    defaultShelfDays: r.default_shelf_days,
    allergens: JSON.parse(r.allergens) as Ingredient['allergens'],
    dietFlags: JSON.parse(r.diet_flags) as Ingredient['dietFlags'],
  }));
  return createTaxonomy(ingredients);
}

/**
 * Stable identity for a generated recipe.
 *
 * Title plus the sorted ingredient ids: the same dish generated twice collides
 * on the UNIQUE index and is stored once, while two genuinely different takes
 * on "palak paneer" stay separate.
 */
export async function contentHash(recipe: Pick<Recipe, 'title' | 'ingredients'>): Promise<string> {
  const basis = [
    recipe.title.trim().toLowerCase(),
    ...recipe.ingredients.map((i) => i.canonicalId ?? i.name.trim().toLowerCase()).sort(),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
