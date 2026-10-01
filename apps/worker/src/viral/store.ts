import type { PipelineRun } from '@cooked/shared';
import type { RunCounts, SeenVideoRow } from './pipeline.js';

/**
 * The D1 side of `ViralRecipesWorkflow`: `seen_videos` and `pipeline_runs`
 * (section 4). The recipe rows themselves go through `saveRecipe` in
 * `recipes/store.ts`, the one writer of the catalog.
 */

/** D1 caps bound parameters per statement; stay well under it. */
const CHUNK = 90;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Section 6: "skip video IDs already in `seen_videos`". */
export async function seenVideoIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const part of chunks(ids)) {
    const { results } = await db
      .prepare(`SELECT video_id FROM seen_videos WHERE video_id IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<{ video_id: string }>();
    for (const r of results ?? []) seen.add(r.video_id);
  }
  return seen;
}

/** Which of these content hashes the catalog already holds. */
export async function knownContentHashes(db: D1Database, hashes: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (const part of chunks(hashes)) {
    const { results } = await db
      .prepare(`SELECT content_hash FROM recipes WHERE content_hash IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<{ content_hash: string }>();
    for (const r of results ?? []) known.add(r.content_hash);
  }
  return known;
}

/**
 * Records what each decided video was decided as. `OR IGNORE` because a
 * retried step may write the same rows twice, and the first verdict on a
 * video is the one that stands.
 */
export async function recordSeenVideos(db: D1Database, rows: SeenVideoRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare('INSERT OR IGNORE INTO seen_videos (video_id, first_seen, outcome) VALUES (?, ?, ?)')
        .bind(r.videoId, r.firstSeen, r.outcome),
    ),
  );
}

/** Opens the run row the status page shows while the pipeline is going. */
export async function openRun(db: D1Database, id: string, startedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pipeline_runs (id, workflow, started_at, status)
       VALUES (?, 'ViralRecipesWorkflow', ?, 'running')`,
    )
    .bind(id, startedAt)
    .run();
}

/** Closes it with the counts, whichever way the run went. */
export async function closeRun(
  db: D1Database,
  id: string,
  status: Exclude<PipelineRun['status'], 'running'>,
  counts: RunCounts,
  finishedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pipeline_runs
          SET status = ?, finished_at = ?, found = ?, filtered = ?, extracted = ?, added = ?,
              duplicates = ?, neurons = ?, errors = ?
        WHERE id = ?`,
    )
    .bind(
      status,
      finishedAt,
      counts.found,
      counts.filtered,
      counts.extracted,
      counts.added,
      counts.duplicates,
      Math.round(counts.neurons * 100) / 100,
      JSON.stringify(counts.errors),
      id,
    )
    .run();
}
