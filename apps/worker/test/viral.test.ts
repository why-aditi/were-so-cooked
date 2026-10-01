import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  introspectWorkflow,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import worker from '../src/index.js';
import { loadTaxonomy } from '../src/recipes/store.js';
import type { VideoCandidate } from '../src/viral/discover.js';
import { judgeExtraction } from '../src/viral/pipeline.js';

/**
 * `ViralRecipesWorkflow` against the real D1: the run row, the catalog
 * writes, `seen_videos`, and the two ways a run starts.
 *
 * The pool has no Workers AI binding and no YouTube key, so the steps that
 * reach either are mocked with the shapes they return. The steps that write —
 * store, close run — run for real, and that is what these tests are about.
 * The decisions inside those mocked steps are covered against fakes in
 * `src/viral/*.test.ts`.
 */

const ADMIN = 'test-admin-token-not-a-real-secret';
const NOW = Date.now();

const video = (id: string, over: Partial<VideoCandidate> = {}): VideoCandidate => ({
  videoId: id,
  title: `Video ${id}`,
  channel: 'Nani Cooks',
  description: 'Ingredients: paneer, tomato.',
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  publishedAt: new Date(NOW - 86_400_000).toISOString(),
  viewCount: 50_000,
  ...over,
});

const draft = (title: string) => ({
  title,
  cuisine: 'indian',
  minutes: 25,
  servings: 2,
  ingredients: [
    { name: 'paneer', quantity: 200, unit: 'g' as const, note: null },
    { name: 'tomato', quantity: 2, unit: 'piece' as const, note: null },
  ],
  steps: ['Cook the tomatoes down.', 'Add the paneer.'],
});

const usage = { promptTokens: 1_500, completionTokens: 700 };

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));
  const subs = env.TEST_SUBSTITUTIONS_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(subs.map((s) => env.DB.prepare(s)));
});

const runRow = (id: string) =>
  env.DB.prepare('SELECT * FROM pipeline_runs WHERE id = ?').bind(id).first<{
    status: string;
    found: number;
    filtered: number;
    extracted: number;
    added: number;
    duplicates: number;
    neurons: number;
    errors: string;
  }>();

/** Polls the run row until the Workflow has closed it. */
async function closed(id: string) {
  await vi.waitFor(
    async () => {
      const row = await runRow(id);
      expect(row).not.toBeNull();
      expect(row?.status).not.toBe('running');
    },
    { timeout: 10_000, interval: 100 },
  );
  return runRow(id);
}

/* -------------------------------- a full run -------------------------------- */

describe('ViralRecipesWorkflow', () => {
  it('stores what it extracted, records every video, and closes the run', async () => {
    const taxonomy = await loadTaxonomy(env.DB);
    const kept = video('kept-1');
    const held = video('held-1');
    const dropped = video('dropped-1');

    const built = await judgeExtraction(kept, { draft: draft('Viral paneer') }, taxonomy, NOW);
    const unknown = await judgeExtraction(
      held,
      { draft: { ...draft('Mystery dish'), ingredients: [{ name: 'unobtainium', quantity: 1, unit: 'g', note: null }] } },
      taxonomy,
      NOW,
    );
    expect(built.outcome).toBe('built');
    expect(unknown.outcome).toBe('held');

    const introspector = await introspectWorkflow(env.VIRAL_RECIPES);
    let runId = '';
    try {
      await introspector.modifyAll(async (m) => {
        await m.mockStepResult({ name: 'reserve neurons' }, { ok: true, id: 'reservation-1' });
        await m.mockStepResult(
          { name: 'discover' },
          { candidates: [kept, held, dropped], found: 3, errors: [] },
        );
        await m.mockStepResult(
          { name: 'filter 1' },
          { keep: [kept, held], usage: { promptTokens: 600, completionTokens: 40 }, errors: [] },
        );
        await m.mockStepResult({ name: `extract ${kept.videoId}` }, { usage, extracted: true, judged: built });
        await m.mockStepResult({ name: `extract ${held.videoId}` }, { usage, extracted: true, judged: unknown });
      });
      const instance = await env.VIRAL_RECIPES.create({ params: {} });
      runId = instance.id;
      const [run] = await introspector.get();
      await run?.waitForStatus('complete');
      expect(await run?.getOutput()).toEqual({ status: 'ok', added: 1, duplicates: 0, errors: 1 });
    } finally {
      await introspector.dispose();
    }

    // Section 6: the creator is credited and the video linked; tags are the
    // engine's, and the recipe is trending for 21 days.
    const stored = await env.DB.prepare(
      "SELECT title, source, creator, source_url, trending_until, allergen_tags FROM recipes WHERE title = 'Viral paneer'",
    ).first<{ title: string; source: string; creator: string; source_url: string; trending_until: string; allergen_tags: string }>();
    expect(stored).toMatchObject({
      source: 'youtube',
      creator: 'Nani Cooks',
      source_url: 'https://www.youtube.com/watch?v=kept-1',
    });
    expect(JSON.parse(stored?.allergen_tags ?? '[]')).toContain('milk');
    expect(Date.parse(stored?.trending_until ?? '')).toBeGreaterThan(NOW + 20 * 86_400_000);

    // Section 6: "so a video is never processed twice" — every decided video
    // is recorded, each with what happened to it.
    const { results } = await env.DB.prepare(
      "SELECT video_id, outcome FROM seen_videos WHERE video_id IN ('kept-1', 'held-1', 'dropped-1') ORDER BY video_id",
    ).all<{ video_id: string; outcome: string }>();
    expect(results).toEqual([
      { video_id: 'dropped-1', outcome: 'filtered' },
      { video_id: 'held-1', outcome: 'held' },
      { video_id: 'kept-1', outcome: 'added' },
    ]);

    // The status page's row.
    const row = await runRow(runId);
    expect(row).toMatchObject({ status: 'ok', found: 3, filtered: 2, extracted: 2, added: 1, duplicates: 0 });
    expect(row?.neurons).toBeGreaterThan(0);
    expect(JSON.parse(row?.errors ?? '[]')[0]).toContain('held held-1');
  });

  it('records a run it could not start, with the reason, and spends nothing', async () => {
    // No YouTube key in the pool: the precondition fails before reserving.
    const instance = await env.VIRAL_RECIPES.create({ params: {} });
    const row = await closed(instance.id);
    expect(row?.status).toBe('failed');
    expect(JSON.parse(row?.errors ?? '[]')).toEqual(['YOUTUBE_API_KEY is not set.']);
  });
});

/* ------------------------------ starting a run ------------------------------ */

describe('starting a run', () => {
  it('needs the admin token', async () => {
    const none = await SELF.fetch('http://localhost/admin/pipeline/run', { method: 'POST' });
    expect(none.status).toBe(401);
    await none.text();

    const wrong = await SELF.fetch('http://localhost/admin/pipeline/run', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    await wrong.text();
  });

  it('starts a run from the admin route', async () => {
    const res = await SELF.fetch('http://localhost/admin/pipeline/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await closed(runId))?.status).toBe('failed');
  });

  it('starts a run from the Sunday cron', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').first<{ n: number }>();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '30 0 * * SUN' }), env, ctx);
    await waitOnExecutionContext(ctx);

    await vi.waitFor(
      async () => {
        const after = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM pipeline_runs WHERE status != 'running'",
        ).first<{ n: number }>();
        expect(after?.n).toBeGreaterThan(before?.n ?? 0);
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

/* ------------------------------ search_trending ----------------------------- */

describe('search_trending', () => {
  beforeAll(async () => {
    const rows = [
      { id: 'tr-paneer', title: 'Trending paneer tikka', until: NOW + 7 * 86_400_000, ing: 'paneer' },
      { id: 'tr-peanut', title: 'Trending peanut noodles', until: NOW + 7 * 86_400_000, ing: 'peanut' },
      { id: 'tr-old', title: 'Trending last month', until: NOW - 86_400_000, ing: 'tomato' },
    ];
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO recipes
             (id, source, title, cuisine, ingredients, steps, minutes, servings, diet_tags,
              allergen_tags, source_url, creator, trending_until, content_hash, created_at)
           VALUES (?, 'youtube', ?, 'indian', ?, '[]', 20, 2, '[]', '[]', ?, 'Nani Cooks', ?, ?, ?)`,
        ).bind(
          r.id,
          r.title,
          JSON.stringify([{ canonicalId: r.ing, name: r.ing, quantity: 100, unit: 'g', note: null }]),
          `https://www.youtube.com/watch?v=${r.id}`,
          new Date(r.until).toISOString(),
          r.id,
          new Date(NOW).toISOString(),
        ),
      ),
    );
  });

  it("returns this week's recipes that fit, credited, and never a dish past its window", async () => {
    const id = `trending-${crypto.randomUUID()}`;
    const agent = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(id)) as unknown as DurableObjectStub<KitchenAgent>;
    await agent.identify(id, false);
    await agent.setProfile({
      diets: [],
      allergens: ['peanuts'],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'UTC',
    });

    const out = await agent.searchTrending({ query: 'trending', limit: 10 });
    const titles = out.results.map((r) => r.recipe.title);
    expect(titles).toContain('Trending paneer tikka');
    expect(titles).not.toContain('Trending last month');
    // The peanut dish is either hidden or comes back with its peanuts
    // swapped out — never with peanut on the plate.
    const plated = out.results.flatMap((r) => r.recipe.ingredients.map((i) => i.canonicalId));
    expect(plated).not.toContain('peanut');
    expect(out.results.find((r) => r.recipe.title === 'Trending paneer tikka')?.recipe.creator).toBe(
      'Nani Cooks',
    );
  });
});
