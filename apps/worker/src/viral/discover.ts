/**
 * The discover and rank steps of `ViralRecipesWorkflow` (section 6).
 *
 * Search is a dependency rather than a `fetch` call. Section 6 splits the
 * real thing in two — `search.list` for ids, then `videos.list` for snippet
 * and statistics, 50 ids per call — but that split exists to spend YouTube
 * quota well, not because the pipeline cares. What the pipeline needs is a
 * function that returns enriched videos, so that is the shape of the port,
 * and the two-call dance belongs to whichever adapter implements it.
 *
 * Nothing here trusts a video. Titles and descriptions are untrusted input
 * (section 8) and are carried as data only; this file never puts them in
 * front of a model.
 */

export interface VideoCandidate {
  videoId: string;
  title: string;
  channel: string;
  /** Untrusted (section 8). Quoted as data wherever it reaches a model. */
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  viewCount: number;
}

export interface VideoQuery {
  text: string;
  /** ISO instant; section 6 asks for the last 7 days only. */
  publishedAfter: string;
  limit: number;
}

export type VideoSearch = (query: VideoQuery) => Promise<VideoCandidate[]>;

/**
 * Section 6: "skip video IDs already in `seen_videos`", the table that exists
 * "so a video is never processed twice". Batched into one lookup because it
 * is one D1 query for the whole run rather than 300.
 */
export type SeenVideoLookup = (videoIds: string[]) => Promise<Set<string>>;

/** Section 6: "6 general viral-recipe queries". */
export const GENERAL_QUERIES: readonly string[] = [
  'viral recipe',
  'easy dinner recipe',
  'quick recipe under 20 minutes',
  'trending food recipe',
  'one pot recipe',
  'budget meal recipe',
];

/**
 * The pool the "6 rotating cuisine queries" rotate through.
 *
 * Eighteen entries and six per run means three weeks before a cuisine comes
 * round again, which is long enough that the catalog does not fill up with
 * the same six kitchens and short enough that a cuisine is never a year
 * stale.
 */
export const CUISINE_POOL: readonly string[] = [
  'north indian',
  'south indian',
  'bengali',
  'gujarati',
  'italian',
  'mexican',
  'thai',
  'japanese',
  'korean',
  'chinese',
  'lebanese',
  'turkish',
  'greek',
  'vietnamese',
  'ethiopian',
  'sri lankan',
  'nepali',
  'filipino',
];

const CUISINE_QUERIES_PER_RUN = 6;
const WEEK_MS = 7 * 86_400_000;

/** Section 6: "published in the last 7 days". */
const WINDOW_DAYS = 7;

/**
 * Section 6 budgets "12 of the 100 daily searches" and then "`videos.list`
 * … 50 IDs per call … about 6 quota units". Twelve queries of 25 is exactly
 * the 300 ids those six enrich calls pay for, so asking for more here would
 * quietly cost quota the spec has not budgeted.
 */
const PER_QUERY = 25;

/** Section 6: "keep top 60". */
const KEEP_TOP = 60;

/**
 * Which cuisines this run asks about.
 *
 * Derived from the clock rather than stored, so the rotation needs no state
 * and a test can pin it by pinning `now`.
 */
export function cuisineQueriesFor(now: number): string[] {
  const week = Math.floor(now / WEEK_MS);
  const start = (week * CUISINE_QUERIES_PER_RUN) % CUISINE_POOL.length;
  return Array.from(
    { length: CUISINE_QUERIES_PER_RUN },
    (_, i) => `${CUISINE_POOL[(start + i) % CUISINE_POOL.length] as string} recipe`,
  );
}

/** The twelve queries of one run, general first. */
export function queriesFor(now: number): string[] {
  return [...GENERAL_QUERIES, ...cuisineQueriesFor(now)];
}

/**
 * Section 6's ranking: "score by views per hour since publishing".
 *
 * The age is floored at an hour. Without that a video published four minutes
 * ago with 30 views scores 450/hour and outranks a genuine hit, because the
 * divisor, not the popularity, is doing the work.
 */
export function viewsPerHour(video: VideoCandidate, now: number): number {
  const published = Date.parse(video.publishedAt);
  // An unparseable date is a broken row, not a brand-new video. Scoring it
  // zero sinks it rather than floating it to the top of the run.
  if (Number.isNaN(published)) return 0;
  const hours = Math.max(1, (now - published) / 3_600_000);
  return video.viewCount / hours;
}

/**
 * Distinct videos, best first.
 *
 * The twelve queries overlap heavily — "viral recipe" and "one pot recipe"
 * return the same hits — so this dedupes by id first and keeps the row with
 * the higher view count, which is the later of two reads of the same video.
 */
export function rankCandidates(videos: VideoCandidate[], now: number): VideoCandidate[] {
  const best = new Map<string, VideoCandidate>();
  for (const video of videos) {
    const existing = best.get(video.videoId);
    if (!existing || video.viewCount > existing.viewCount) best.set(video.videoId, video);
  }

  return [...best.values()].sort(
    (a, b) =>
      viewsPerHour(b, now) - viewsPerHour(a, now) ||
      b.viewCount - a.viewCount ||
      a.videoId.localeCompare(b.videoId),
  );
}

export interface DiscoverOptions {
  windowDays?: number;
  perQuery?: number;
  keep?: number;
}

export interface DiscoverResult {
  /** Ranked, unseen, capped at `keep`. */
  candidates: VideoCandidate[];
  /** Distinct videos the searches returned, before the `seen_videos` filter. */
  found: number;
  /** Queries that failed. The run continues on whatever the rest returned. */
  errors: string[];
}

/**
 * One run's worth of candidates.
 *
 * A failing query is recorded and skipped rather than thrown. Eleven queries
 * of trending recipes is a good week; zero recipes because one search 500ed
 * is not, and section 6's retry policy would otherwise replay all twelve to
 * recover the one.
 */
export async function discoverVideos(
  deps: { search: VideoSearch; seen: SeenVideoLookup; now?: number | undefined },
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const now = deps.now ?? Date.now();
  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const publishedAfter = new Date(now - windowDays * 86_400_000).toISOString();

  const raw: VideoCandidate[] = [];
  const errors: string[] = [];

  for (const text of queriesFor(now)) {
    try {
      raw.push(
        ...(await deps.search({ text, publishedAfter, limit: options.perQuery ?? PER_QUERY })),
      );
    } catch (e) {
      errors.push(`search "${text}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ranked = rankCandidates(raw, now);
  const seen = await deps.seen(ranked.map((v) => v.videoId));

  return {
    candidates: ranked.filter((v) => !seen.has(v.videoId)).slice(0, options.keep ?? KEEP_TOP),
    found: ranked.length,
    errors,
  };
}
