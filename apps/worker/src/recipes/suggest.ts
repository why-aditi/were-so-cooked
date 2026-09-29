import {
  type Proposer,
  type SubstitutionRow,
  type Taxonomy,
  substitute,
  withComputedTags,
} from '@cooked/safety';
import type { PantryItem, Profile, Recipe, RecipeDraft, Swap } from '@cooked/shared';
import type { TokenUsage } from '../budget/rates.js';
import type { GenerateRequest, GenerateResult } from './generate.js';
import { type RecipeSearch, contentHash } from './store.js';

/**
 * `suggest_recipes` and `substitute` from section 5, as pure orchestration.
 *
 * Section 5 step 4: "Any tool that returns food runs the result through the
 * safety engine before the model sees it." These are the two tools that
 * return food, so the gate is here and it is not optional — every candidate,
 * whether it came from the catalog or from a model, goes through
 * `substitute`, whose final unconditional `check` is what makes section 7's
 * invariant hold. A recipe reaches the caller having just passed, or it
 * reaches them as a drop with a reason.
 *
 * No I/O: the catalog, the model and the clock all arrive as dependencies, so
 * the ranking and the gate are testable without workerd and without neurons.
 */

export interface Suggestion {
  recipe: Recipe;
  /** 0..1 of the recipe's ingredients the pantry already covers. */
  pantryCoverage: number;
  have: string[];
  missing: string[];
  /** Ingredients swapped to make it fit. Empty when it already did. */
  swaps: Swap[];
  /** How many of the covered items are going off within three days. */
  usesExpiring: number;
  source: 'catalog' | 'generated';
  /** Non-blocking notes, e.g. halal's "use halal-certified meat". */
  advisories: string[];
}

export interface SuggestRequest {
  query: string;
  pantry: PantryItem[];
  profile: Profile;
  maxMinutes?: number | undefined;
  limit?: number;
}

export interface SuggestDeps {
  taxonomy: Taxonomy;
  search: RecipeSearch;
  substitutions: SubstitutionRow[];
  /** Absent means catalog-only: no neurons, fewer answers. */
  generate?: ((req: GenerateRequest) => Promise<GenerateResult>) | undefined;
  propose?: Proposer | undefined;
  /** Section 7: dislikes lower a ranking, they never block. */
  dislikes?: string[] | undefined;
  now?: number | undefined;
}

export interface SuggestOutcome {
  suggestions: Suggestion[];
  /** Shown to the user: section 10's "Removed this recipe because…" copy. */
  dropped: { title: string; reason: string }[];
  usage: TokenUsage;
  modelCalled: boolean;
}

const DEFAULT_LIMIT = 4;
/** Pull wider than needed, because the safety gate rejects some. */
const CANDIDATE_MULTIPLIER = 4;
/** Section 5 names the same window for the pantry slot. */
const EXPIRING_DAYS = 3;

const norm = (s: string): string => s.trim().toLowerCase();

/* -------------------------------- coverage -------------------------------- */

interface Coverage {
  coverage: number;
  have: string[];
  missing: string[];
  usesExpiring: number;
}

/**
 * How much of a recipe the pantry already covers.
 *
 * Matched on canonical ID first and display name second, which is the same
 * order the deduction uses. Quantities are deliberately ignored: "do you have
 * any paneer" is the question a suggestion needs answered, and demanding
 * enough paneer would hide a dish someone is one shop away from cooking.
 */
export function coverageOf(
  recipe: Pick<Recipe, 'ingredients'>,
  pantry: PantryItem[],
  now: number,
): Coverage {
  const live = pantry.filter((i) => i.deletedAt === null);
  const byId = new Map(live.filter((i) => i.canonicalId).map((i) => [i.canonicalId as string, i]));
  const byName = new Map(live.map((i) => [norm(i.displayName), i]));
  const expiringCutoff = now + EXPIRING_DAYS * 86_400_000;

  const have: string[] = [];
  const missing: string[] = [];
  let usesExpiring = 0;

  for (const ing of recipe.ingredients) {
    const match =
      (ing.canonicalId ? byId.get(ing.canonicalId) : undefined) ?? byName.get(norm(ing.name));
    if (!match) {
      missing.push(ing.name);
      continue;
    }
    have.push(ing.name);
    if (match.expiresAt !== null && Date.parse(match.expiresAt) <= expiringCutoff) {
      usesExpiring += 1;
    }
  }

  const total = recipe.ingredients.length;
  return {
    coverage: total === 0 ? 0 : have.length / total,
    have,
    missing,
    usesExpiring,
  };
}

/**
 * Best first.
 *
 * Coverage leads because the whole point is cooking what is already there.
 * Expiring items break the tie — section 8 plans around using them up, and a
 * suggestion that saves the spinach is worth more than one that does not.
 * Fewer swaps next: a dish that fits as written beats the same dish rebuilt.
 */
export function rankSuggestions(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort(
    (a, b) =>
      b.pantryCoverage - a.pantryCoverage ||
      b.usesExpiring - a.usesExpiring ||
      a.swaps.length - b.swaps.length ||
      a.recipe.minutes - b.recipe.minutes ||
      a.recipe.title.localeCompare(b.recipe.title),
  );
}

/* --------------------------------- drafts --------------------------------- */

/**
 * A model's draft into a real `Recipe`.
 *
 * `withComputedTags` is what makes this safe to store: section 7 requires the
 * engine to own `dietTags` and `allergenTags`, and the draft schema does not
 * even accept them, so there is nothing to discard.
 */
export async function draftToRecipe(
  draft: RecipeDraft,
  taxonomy: Taxonomy,
  now: number,
): Promise<Recipe> {
  const ingredients = draft.ingredients.map((i) => ({
    canonicalId: taxonomy.resolve(i.name)?.canonicalId ?? null,
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    note: i.note,
  }));

  const base: Recipe = {
    id: crypto.randomUUID(),
    source: 'llm',
    title: draft.title,
    cuisine: draft.cuisine,
    ingredients,
    steps: draft.steps,
    minutes: draft.minutes,
    servings: draft.servings,
    dietTags: [],
    allergenTags: [],
    sourceUrl: null,
    creator: null,
    thumbnailUrl: null,
    trendingUntil: null,
    contentHash: await contentHash({ title: draft.title, ingredients }),
    createdAt: new Date(now).toISOString(),
  };
  return withComputedTags(base, taxonomy);
}

/* -------------------------------- the gate -------------------------------- */

/**
 * One candidate through the safety engine.
 *
 * `substitute` returns the recipe unchanged when it already passes, so this
 * covers both section 5 tools: `suggest_recipes` wants the ones that survive,
 * `substitute` wants the swaps that got them there.
 */
export async function gate(
  recipe: Recipe,
  profile: Profile,
  deps: Pick<SuggestDeps, 'taxonomy' | 'substitutions' | 'propose' | 'dislikes'>,
): Promise<
  { ok: true; recipe: Recipe; swaps: Swap[]; advisories: string[] } | { ok: false; reason: string }
> {
  const outcome = await substitute(recipe, profile, {
    taxonomy: deps.taxonomy,
    substitutions: deps.substitutions,
    ...(deps.propose ? { propose: deps.propose } : {}),
    ...(deps.dislikes ? { checkOptions: { dislikes: deps.dislikes } } : {}),
  });

  if (outcome.dropped) return { ok: false, reason: outcome.reason };
  return {
    ok: true,
    recipe: outcome.recipe,
    swaps: outcome.swaps,
    advisories: outcome.check.advisories,
  };
}

/* ------------------------------ suggest_recipes ----------------------------- */

export async function suggestRecipes(
  req: SuggestRequest,
  deps: SuggestDeps,
): Promise<SuggestOutcome> {
  const now = deps.now ?? Date.now();
  const limit = req.limit ?? DEFAULT_LIMIT;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  // Deliberately no diet or allergen filter on this query. Section 11's
  // `?fits=me` keeps recipes that "pass **or can be substituted**", and a tag
  // pre-filter would throw away exactly the ones substitution exists to
  // rescue. The tags narrow nothing here; the engine decides below.
  const catalog = await deps.search.find({
    ...(req.query ? { text: req.query } : {}),
    ...(req.maxMinutes !== undefined ? { maxMinutes: req.maxMinutes } : {}),
    limit: limit * CANDIDATE_MULTIPLIER,
  });

  const candidates: { recipe: Recipe; source: 'catalog' | 'generated' }[] = catalog.map((r) => ({
    recipe: r,
    source: 'catalog' as const,
  }));

  const suggestions: Suggestion[] = [];
  const dropped: { title: string; reason: string }[] = [];
  let modelCalled = false;

  const consider = async (recipe: Recipe, source: 'catalog' | 'generated'): Promise<void> => {
    const result = await gate(recipe, req.profile, deps);
    if (!result.ok) {
      dropped.push({ title: recipe.title, reason: result.reason });
      return;
    }
    const { coverage, have, missing, usesExpiring } = coverageOf(result.recipe, req.pantry, now);
    suggestions.push({
      recipe: result.recipe,
      pantryCoverage: coverage,
      have,
      missing,
      swaps: result.swaps,
      usesExpiring,
      source,
      advisories: result.advisories,
    });
  };

  for (const c of candidates) await consider(c.recipe, c.source);

  // Section 5: "Search the catalog **and** generate new options." Generation
  // only runs when the catalog came up short, because it is the half that
  // costs neurons — and while the catalog is empty it is the half doing all
  // the work.
  if (suggestions.length < limit && deps.generate) {
    modelCalled = true;
    const generated = await deps.generate({
      query: req.query,
      pantry: req.pantry.filter((i) => i.deletedAt === null).map((i) => i.displayName),
      profileSummary: summariseProfile(req.profile),
      maxMinutes: req.maxMinutes,
      // One spare, because the gate will reject some.
      count: Math.min(6, limit - suggestions.length + 1),
      avoidTitles: suggestions.map((s) => s.recipe.title),
    });
    usage.promptTokens += generated.usage.promptTokens;
    usage.completionTokens += generated.usage.completionTokens;

    for (const draft of generated.drafts) {
      await consider(await draftToRecipe(draft, deps.taxonomy, now), 'generated');
    }
  }

  return { suggestions: rankSuggestions(suggestions).slice(0, limit), dropped, usage, modelCalled };
}

/* -------------------------------- substitute -------------------------------- */

export interface SubstituteRequest {
  /** Catalog id, else a title to look up, else a title to invent. */
  recipeId?: string | undefined;
  recipeTitle: string;
  /**
   * An extra constraint for this dish only — spike 3's "butter chicken but
   * vegan". Applied on top of the profile without saving it, because wanting
   * one vegan dinner is not the same as becoming vegan.
   */
  extraDiets?: Profile['diets'];
  extraAllergens?: Profile['allergens'];
  extraExclusions?: string[];
}

export type SubstituteToolOutcome =
  | {
      status: 'ok';
      recipe: Recipe;
      swaps: Swap[];
      advisories: string[];
      /** True when it already fitted and nothing was changed. */
      alreadyFitted: boolean;
      source: 'catalog' | 'generated';
      usage: TokenUsage;
    }
  | { status: 'dropped'; title: string; reason: string; usage: TokenUsage }
  | { status: 'not_found'; title: string; usage: TokenUsage };

export async function substituteRecipe(
  req: SubstituteRequest,
  profile: Profile,
  deps: SuggestDeps,
): Promise<SubstituteToolOutcome> {
  const now = deps.now ?? Date.now();
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  let recipe =
    (req.recipeId ? await deps.search.byId(req.recipeId) : null) ??
    (await deps.search.byTitle(req.recipeTitle));
  let source: 'catalog' | 'generated' = 'catalog';

  // Someone asking for "butter chicken but vegan" rarely has butter chicken
  // saved. Inventing the dish and then rewriting it is the same pipeline, and
  // the gate below does not care which half produced the candidate.
  if (!recipe && deps.generate) {
    const generated = await deps.generate({
      query: req.recipeTitle,
      pantry: [],
      profileSummary: summariseProfile(profile),
      count: 1,
    });
    usage.promptTokens += generated.usage.promptTokens;
    usage.completionTokens += generated.usage.completionTokens;
    const draft = generated.drafts[0];
    if (draft) {
      recipe = await draftToRecipe(draft, deps.taxonomy, now);
      source = 'generated';
    }
  }

  if (!recipe) return { status: 'not_found', title: req.recipeTitle, usage };

  const effective: Profile = {
    ...profile,
    diets: [...new Set([...profile.diets, ...(req.extraDiets ?? [])])],
    allergens: [...new Set([...profile.allergens, ...(req.extraAllergens ?? [])])],
    exclusions: [...new Set([...profile.exclusions, ...(req.extraExclusions ?? [])])],
  };

  const result = await gate(recipe, effective, deps);
  if (!result.ok) {
    return { status: 'dropped', title: recipe.title, reason: result.reason, usage };
  }

  return {
    status: 'ok',
    recipe: result.recipe,
    swaps: result.swaps,
    advisories: result.advisories,
    // No swaps means `substitute` returned it untouched at step 1.
    alreadyFitted: result.swaps.length === 0,
    source,
    usage,
  };
}

/** The profile as one line a model can read. */
export function summariseProfile(p: Profile): string {
  const bits = [
    p.allergens.length > 0 ? `allergic to ${p.allergens.join(', ')}` : 'no allergies',
    p.diets.length > 0 ? `diets: ${p.diets.join(', ')}` : '',
    p.exclusions.length > 0 ? `will not eat ${p.exclusions.join(', ')}` : '',
    p.cuisines.length > 0 ? `likes ${p.cuisines.join(', ')}` : '',
    `cooks for ${p.servings}`,
    `spice ${p.spiceLevel}`,
  ].filter(Boolean);
  return bits.join('; ');
}
