import type { Recipe, RecipeDraft } from '@cooked/shared';
import { describe, expect, it, vi } from 'vitest';
import { TAXONOMY } from '../plan/fixtures.js';
import type { VideoCandidate } from './discover.js';
import type { ExtractResult, FilterResult } from './extract.js';
import {
  type ViralRunDeps,
  draftToTrendingRecipe,
  runViralPipeline,
  toPipelineRun,
} from './pipeline.js';

/**
 * The run that stitches discovery, filtering and extraction together
 * (section 6, ViralRecipesWorkflow).
 *
 * The parts each have their own tests. What only this file can check is the
 * accounting and the refusals: that a video is never processed twice, that a
 * recipe already in the catalog is not added again, that a failed extraction
 * costs one video rather than the run, and that the numbers written to
 * `pipeline_runs` describe what actually happened.
 */

const NOW = Date.parse('2026-09-27T12:00:00Z');

let n = 0;
const video = (over: Partial<VideoCandidate> = {}): VideoCandidate => {
  n += 1;
  return {
    videoId: `vid-${n}`,
    title: `Palak paneer in 10 minutes`,
    channel: 'Some Kitchen',
    description: '200g paneer, 1 bunch palak, 2 tomatoes. Cook it.',
    thumbnailUrl: 'https://i.ytimg.com/vi/x/hq.jpg',
    publishedAt: '2026-09-25T00:00:00.000Z',
    viewCount: 50_000,
    ...over,
  };
};

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
  title: 'Palak paneer',
  cuisine: 'indian',
  minutes: 25,
  servings: 2,
  ingredients: [
    { name: 'paneer', quantity: 200, unit: 'g', note: null },
    { name: 'spinach', quantity: 1, unit: 'bunch', note: null },
  ],
  steps: ['cook it'],
  ...over,
});

const usage = { promptTokens: 400, completionTokens: 200 };

/**
 * `discoverVideos` runs one search per query in the week's rotation, so a
 * search that minted a fresh video per call would invent a dozen of them.
 * Every helper here hands back the same fixed list and lets the pipeline's
 * own dedupe collapse it.
 */
const searching = (videos: VideoCandidate[]) => vi.fn(async () => videos);

function deps(over: Partial<ViralRunDeps> = {}): ViralRunDeps {
  const one = video();
  return {
    search: searching([one]),
    seen: vi.fn(async () => new Set<string>()),
    filter: vi.fn(
      async (videos: VideoCandidate[]): Promise<FilterResult> => ({
        keep: videos,
        usage,
        errors: [],
      }),
    ),
    extract: vi.fn(
      async (): Promise<ExtractResult> => ({ draft: draft(), usage, attempts: 1 }),
    ),
    knownHashes: vi.fn(async () => new Set<string>()),
    taxonomy: TAXONOMY,
    now: NOW,
    ...over,
  };
}

/* --------------------------------- drafts --------------------------------- */

describe('turning a draft into a stored recipe', () => {
  it('takes the credit and the link from the video, never the model', async () => {
    // Section 6 wants every stored recipe to credit its creator. A model
    // that invented a channel name would put a stranger's name on someone
    // else's cooking.
    const out = await draftToTrendingRecipe(
      draft(),
      video({ channel: 'Real Cook' }),
      TAXONOMY,
      NOW,
      7,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.recipe.creator).toBe('Real Cook');
    expect(out.recipe.source).toBe('youtube');
    expect(out.recipe.sourceUrl).toContain('vid-');
  });

  it('computes the tags rather than trusting anything', async () => {
    // Section 7: the engine owns dietTags and allergenTags.
    const out = await draftToTrendingRecipe(draft(), video(), TAXONOMY, NOW, 7);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.recipe.allergenTags).toContain('milk');
    expect(out.recipe.dietTags).not.toContain('vegan');
  });

  it('sets a trending window that expires', async () => {
    const out = await draftToTrendingRecipe(draft(), video(), TAXONOMY, NOW, 7);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const until = Date.parse(out.recipe.trendingUntil as string);

    expect(until).toBeGreaterThan(NOW);
    expect(until - NOW).toBeCloseTo(7 * 86_400_000, -4);
  });

  it('resolves ingredient names through the taxonomy', async () => {
    const out = await draftToTrendingRecipe(draft(), video(), TAXONOMY, NOW, 7);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.recipe.ingredients.map((i) => i.canonicalId)).toContain('paneer');
  });
});

/* ---------------------------------- run ----------------------------------- */

describe('a pipeline run', () => {
  it('adds a recipe it found', async () => {
    const out = await runViralPipeline(deps(), {});

    expect(out.recipes).toHaveLength(1);
    expect(out.counts).toMatchObject({ found: 1, added: 1, duplicates: 0 });
    expect(out.seenVideos[0]).toMatchObject({ outcome: 'added' });
  });

  it('never processes a video twice', async () => {
    // Section 6 gives `seen_videos` its own table for exactly this. Without
    // it every weekly run re-extracts the same fortnight of videos.
    const extract = vi.fn(async (): Promise<ExtractResult> => ({ draft: draft(), usage, attempts: 1 }));
    const out = await runViralPipeline(
      deps({ seen: async (ids) => new Set(ids), extract }),
      {},
    );

    expect(extract).not.toHaveBeenCalled();
    expect(out.recipes).toHaveLength(0);
  });

  it('does not re-add a recipe the catalog already holds', async () => {
    // The same dish goes round several channels in a week; `content_hash`
    // is what stops five copies of it landing.
    const out = await runViralPipeline(deps({ knownHashes: async (h) => new Set(h) }), {});

    expect(out.recipes).toHaveLength(0);
    expect(out.counts.duplicates).toBe(1);
    expect(out.seenVideos[0]).toMatchObject({ outcome: 'duplicate' });
  });

  it('deduplicates two videos of the same dish within one run', async () => {
    // Both are new to `seen_videos` and neither is in D1 yet, so only the
    // in-run check catches this.
    const out = await runViralPipeline(
      deps({ search: searching([video(), video()]) }),
      {},
    );

    expect(out.recipes).toHaveLength(1);
    expect(out.counts.duplicates).toBe(1);
  });

  it('skips a video the filter rejected, without paying for extraction', async () => {
    const extract = vi.fn(async (): Promise<ExtractResult> => ({ draft: draft(), usage, attempts: 1 }));
    const out = await runViralPipeline(
      deps({ filter: async () => ({ keep: [], usage, errors: [] }), extract }),
      {},
    );

    expect(extract).not.toHaveBeenCalled();
    // `counts.filtered` is the funnel stage — how many survived — so a
    // rejected video drives it to zero. The rejection itself is recorded
    // against the video, which is what stops it being re-fetched next week.
    expect(out.counts.filtered).toBe(0);
    expect(out.seenVideos[0]).toMatchObject({ outcome: 'filtered' });
  });

  it('loses one video to a failed extraction, not the run', async () => {
    const out = await runViralPipeline(
      deps({
        search: searching([video({ videoId: 'bad' }), video({ videoId: 'good' })]),
        extract: vi.fn(async (v: VideoCandidate) =>
          v.videoId === 'bad'
            ? { draft: null, usage, attempts: 2, error: 'unparseable' }
            : { draft: draft({ title: 'Dal tadka' }), usage, attempts: 1 },
        ),
      }),
      {},
    );

    expect(out.recipes).toHaveLength(1);
    expect(out.counts.errors.length).toBeGreaterThan(0);
  });

  it('survives the search failing entirely', async () => {
    // A weekly cron that throws leaves no record of why.
    const out = await runViralPipeline(
      deps({
        search: vi.fn(async () => {
          throw new Error('YouTube quota exceeded');
        }),
      }),
      {},
    );

    expect(out.recipes).toEqual([]);
    expect(out.counts.errors.join(' ')).toContain('quota');
  });

  it('stops at the cap section 6 sets', async () => {
    const many = Array.from({ length: 40 }, (_, i) => video({ videoId: `v${i}` }));
    const out = await runViralPipeline(
      deps({
        search: searching(many),
        extract: vi.fn(async (v: VideoCandidate) => ({
          draft: draft({ title: `Dish ${v.videoId}` }),
          usage,
          attempts: 1,
        })),
      }),
      { maxRecipes: 30 },
    );

    expect(out.recipes.length).toBeLessThanOrEqual(30);
  });

  it('records what every decided video was decided as', async () => {
    // `seen_videos` has to cover rejections too, or a filtered video is
    // re-fetched and re-filtered every week for ever.
    const out = await runViralPipeline(
      deps({
        search: searching([video(), video()]),
        filter: async (videos) => ({ keep: videos.slice(0, 1), usage, errors: [] }),
      }),
      {},
    );

    expect(out.seenVideos).toHaveLength(2);
    expect(out.seenVideos.map((s) => s.outcome).sort()).toEqual(['added', 'filtered']);
  });
});

/* -------------------------------- accounting ------------------------------ */

describe('the pipeline_runs row', () => {
  it('carries the counts the status screen shows', async () => {
    const out = await runViralPipeline(deps(), {});
    const row = toPipelineRun(
      { id: 'run-1', startedAt: NOW, finishedAt: NOW + 240_000, status: 'ok' },
      out.counts,
    );

    expect(row).toMatchObject({
      id: 'run-1',
      workflow: 'ViralRecipesWorkflow',
      status: 'ok',
      found: 1,
      added: 1,
    });
    expect(row.finishedAt).toBe(new Date(NOW + 240_000).toISOString());
  });

  it('reports failed when something went wrong', async () => {
    const out = await runViralPipeline(
      deps({
        search: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
      {},
    );
    // The caller decides the status; the counts carry why.
    const row = toPipelineRun(
      { id: 'run-2', startedAt: NOW, finishedAt: NOW + 10_000, status: 'failed' },
      out.counts,
    );

    expect(row.status).toBe('failed');
    expect(row.errors.length).toBeGreaterThan(0);
  });

  it('accounts for the neurons both model steps spent', async () => {
    // Section 12 reserves 2,500 for this pool on Sundays; a run that
    // under-reports its spend makes that budget meaningless.
    const out = await runViralPipeline(deps(), {});
    expect(out.counts.neurons).toBeGreaterThan(0);
  });
});

/* --------------------------------- safety --------------------------------- */

describe('what reaches the catalog', () => {
  it('never carries a diet tag the model asserted', async () => {
    const recipes: Recipe[] = (
      await runViralPipeline(
        deps({
          extract: async () => ({
            draft: draft({ title: 'Totally vegan paneer' }),
            usage,
            attempts: 1,
          }),
        }),
        {},
      )
    ).recipes;

    expect(recipes[0]?.dietTags).not.toContain('vegan');
    expect(recipes[0]?.allergenTags).toContain('milk');
  });
});
