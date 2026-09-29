import { type Taxonomy, resolveAll, withComputedTags } from '@cooked/safety';
import { type PipelineRun, Recipe, type RecipeDraft } from '@cooked/shared';
import { type TokenUsage, neuronsFor } from '../budget/rates.js';
import { contentHash } from '../recipes/store.js';
import {
  type SeenVideoLookup,
  type VideoCandidate,
  type VideoSearch,
  discoverVideos,
} from './discover.js';
import { EXTRACT_MODEL, FILTER_MODEL, type ExtractResult, type FilterResult } from './extract.js';

/**
 * `ViralRecipesWorkflow` (section 6) as one pure function: candidates in,
 * rows to write out.
 *
 * Every edge is injected — search, the two model calls, the two D1 lookups,
 * the clock — so the whole funnel runs in the node pool without workerd, a
 * YouTube key or a neuron. What the Workflow adds around this is the step
 * boundaries, the budget reservation and the writes; the decisions are all
 * here, where they can be tested.
 *
 * Two of those decisions are not this module's to make and are deliberately
 * borrowed rather than re-argued:
 *
 *   - `contentHash` comes from `recipes/store.ts`, because `recipes` has a
 *     UNIQUE index on that column. A second hashing scheme would dedupe
 *     against a different notion of sameness than the database enforces.
 *   - the tags come from `withComputedTags`, because section 7 gives the
 *     safety engine sole ownership of `dietTags` and `allergenTags`. The
 *     extraction schema has no fields for a model to claim them in, so there
 *     is nothing here to discard.
 */

/** Section 6: "Target: up to 30 new trending recipes per run." */
const MAX_RECIPES = 30;

/** Section 6: "`trending_until` = now + 21 days". */
const TRENDING_DAYS = 21;

/**
 * Section 6 wants small step results, and `pipeline_runs.errors` is one TEXT
 * column. Sixty failures all say the same thing anyway; twenty is enough to
 * see what went wrong.
 */
const MAX_ERRORS = 20;

/**
 * What happened to a video, written to `seen_videos.outcome`.
 *
 * `held` is section 6's "recipes with unknown ingredients are held back".
 * `pipeline_runs` has no column for it, so the outcome row is the only place
 * that distinction survives — worth keeping, because a run where everything
 * is held is a taxonomy problem, not a YouTube one.
 */
export type VideoOutcome = 'added' | 'duplicate' | 'filtered' | 'held' | 'failed';

export interface SeenVideoRow {
  videoId: string;
  firstSeen: string;
  outcome: VideoOutcome;
}

/**
 * The columns of `pipeline_runs` this pipeline fills in.
 *
 * `filtered` is a funnel stage, not a rejection tally: it counts the videos
 * that *survived* the relevance filter, so the row reads found → filtered →
 * extracted → added as a narrowing sequence. Note the deliberate clash with
 * `VideoOutcome`, where `'filtered'` labels a video that was thrown out —
 * there the word describes what happened to one video, here it describes how
 * many were still standing.
 */
export interface RunCounts {
  found: number;
  filtered: number;
  extracted: number;
  added: number;
  duplicates: number;
  neurons: number;
  errors: string[];
}

export interface ViralRunResult {
  /** Ready for `saveRecipe`; already tagged, hashed and schema-valid. */
  recipes: Recipe[];
  /** Only the videos this run actually decided about. */
  seenVideos: SeenVideoRow[];
  counts: RunCounts;
}

export interface ViralRunDeps {
  search: VideoSearch;
  seen: SeenVideoLookup;
  /** `classifyDescriptions` with a model bound to it. */
  filter: (videos: VideoCandidate[]) => Promise<FilterResult>;
  /** `extractRecipe` with a model bound to it. */
  extract: (video: VideoCandidate) => Promise<ExtractResult>;
  /** Which of these content hashes `recipes` already holds. */
  knownHashes: (hashes: string[]) => Promise<Set<string>>;
  taxonomy: Taxonomy;
  now?: number | undefined;
}

export interface ViralRunOptions {
  maxRecipes?: number;
  trendingDays?: number;
}

/* --------------------------------- drafts --------------------------------- */

/**
 * A draft plus its video into a storable recipe.
 *
 * The link, the creator and the thumbnail come from the video, never from the
 * model: they are the parts a viewer is asked to trust, and section 6 wants
 * every stored recipe to credit its creator correctly. A model that invents a
 * channel name would put a stranger's name on someone else's cooking.
 */
export async function draftToTrendingRecipe(
  draft: RecipeDraft,
  video: VideoCandidate,
  taxonomy: Taxonomy,
  now: number,
  trendingDays = TRENDING_DAYS,
): Promise<{ ok: true; recipe: Recipe } | { ok: false; reason: string }> {
  const ingredients = draft.ingredients.map((i) => ({
    canonicalId: taxonomy.resolve(i.name)?.canonicalId ?? null,
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    note: i.note,
  }));

  // Section 6: "recipes with unknown ingredients are held back". The catalog
  // is filtered and ranked by computed tags, and a tag set computed over an
  // ingredient the taxonomy cannot read is a guess — it would look like a
  // cleared recipe while carrying an unchecked allergen.
  const unknown = resolveAll(ingredients, taxonomy)
    .filter((r) => r.entry === undefined)
    .map((r) => r.name);
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown ingredients: ${unknown.slice(0, 5).join(', ')}` };
  }

  const base: Recipe = {
    id: crypto.randomUUID(),
    source: 'youtube',
    title: draft.title,
    cuisine: draft.cuisine,
    ingredients,
    steps: draft.steps,
    minutes: draft.minutes,
    servings: draft.servings,
    dietTags: [],
    allergenTags: [],
    sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    creator: video.channel,
    thumbnailUrl: video.thumbnailUrl,
    trendingUntil: new Date(now + trendingDays * 86_400_000).toISOString(),
    contentHash: await contentHash({ title: draft.title, ingredients }),
    createdAt: new Date(now).toISOString(),
  };

  // The last gate before D1. `RecipeDraft` has already vetted everything the
  // model wrote, so what this catches is a bad video row — an empty channel
  // name, a thumbnail that is not a URL — reaching the insert.
  const parsed = Recipe.safeParse(withComputedTags(base, taxonomy));
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => i.path.join('.')).join(', ') };
  }
  return { ok: true, recipe: parsed.data };
}

/* ---------------------------------- run ----------------------------------- */

export async function runViralPipeline(
  deps: ViralRunDeps,
  options: ViralRunOptions = {},
): Promise<ViralRunResult> {
  const now = deps.now ?? Date.now();
  const firstSeen = new Date(now).toISOString();
  const maxRecipes = options.maxRecipes ?? MAX_RECIPES;
  const errors: string[] = [];
  const outcomes = new Map<string, VideoOutcome>();

  const discovered = await discoverVideos({ search: deps.search, seen: deps.seen, now });
  errors.push(...discovered.errors);

  const filtered = await deps.filter(discovered.candidates);
  errors.push(...filtered.errors);
  const kept = new Set(filtered.keep.map((v) => v.videoId));
  for (const video of discovered.candidates) {
    if (!kept.has(video.videoId)) outcomes.set(video.videoId, 'filtered');
  }

  // Videos past the cap are left out of `seen_videos` entirely. They were
  // never processed, and section 6's table means "processed", so recording
  // them would burn a candidate next week's run could still have used.
  const queue = filtered.keep.slice(0, maxRecipes);

  const extractUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  const built: { video: VideoCandidate; recipe: Recipe }[] = [];
  let extracted = 0;

  for (const video of queue) {
    const result = await deps.extract(video);
    extractUsage.promptTokens += result.usage.promptTokens;
    extractUsage.completionTokens += result.usage.completionTokens;

    if (!result.draft) {
      outcomes.set(video.videoId, 'failed');
      errors.push(`extract ${video.videoId}: ${result.error ?? 'no draft'}`);
      continue;
    }
    extracted += 1;

    const recipe = await draftToTrendingRecipe(
      result.draft,
      video,
      deps.taxonomy,
      now,
      options.trendingDays,
    );
    if (!recipe.ok) {
      outcomes.set(video.videoId, 'held');
      errors.push(`held ${video.videoId}: ${recipe.reason}`);
      continue;
    }
    built.push({ video, recipe: recipe.recipe });
  }

  // One lookup for the whole run rather than one per recipe. Section 6 dedupes
  // on the hash before embedding, and this is the half of that which is
  // authoritative: `recipes.content_hash` is UNIQUE, so a hash already in D1
  // cannot be inserted whatever the embedding later says about similarity.
  //
  // ponytail: the "similarity above 0.92" half of that step is not here. It
  // needs a `bge-m3` embedding per recipe and a Vectorize query, and spike 1
  // measured 68 seconds before a vector is queryable — so a run cannot even
  // dedupe against its own earlier writes. Add it as another injected port
  // beside `knownHashes` once the index has content, and keep D1 the
  // authority either way.
  const known = await deps.knownHashes(built.map((b) => b.recipe.contentHash));
  const recipes: Recipe[] = [];
  const inRun = new Set<string>();
  let duplicates = 0;

  for (const { video, recipe } of built) {
    if (known.has(recipe.contentHash) || inRun.has(recipe.contentHash)) {
      duplicates += 1;
      outcomes.set(video.videoId, 'duplicate');
      continue;
    }
    inRun.add(recipe.contentHash);
    recipes.push(recipe);
    outcomes.set(video.videoId, 'added');
  }

  return {
    recipes,
    seenVideos: [...outcomes].map(([videoId, outcome]) => ({ videoId, firstSeen, outcome })),
    counts: {
      found: discovered.found,
      filtered: filtered.keep.length,
      extracted,
      added: recipes.length,
      duplicates,
      neurons:
        neuronsFor(FILTER_MODEL, filtered.usage) + neuronsFor(EXTRACT_MODEL, extractUsage),
      errors: errors.slice(0, MAX_ERRORS),
    },
  };
}

/* ------------------------------- accounting -------------------------------- */

/** The `pipeline_runs` row for a finished run. */
export function toPipelineRun(
  run: {
    id: string;
    startedAt: number;
    finishedAt?: number | undefined;
    status: PipelineRun['status'];
  },
  counts: RunCounts,
): PipelineRun {
  return {
    id: run.id,
    workflow: 'ViralRecipesWorkflow',
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt === undefined ? null : new Date(run.finishedAt).toISOString(),
    status: run.status,
    ...counts,
  };
}
