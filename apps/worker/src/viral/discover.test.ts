import { describe, expect, it, vi } from 'vitest';
import {
  CUISINE_POOL,
  GENERAL_QUERIES,
  type VideoCandidate,
  type VideoSearch,
  cuisineQueriesFor,
  discoverVideos,
  queriesFor,
  rankCandidates,
  viewsPerHour,
} from './discover.js';

/**
 * Discovery and ranking with YouTube faked.
 *
 * The behaviour worth pinning is section 6's promise that "a video is never
 * processed twice", and the ranking's resistance to a brand-new video with
 * three views looking like the hit of the week.
 */

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;

const video = (videoId: string, over: Partial<VideoCandidate> = {}): VideoCandidate => ({
  videoId,
  title: `${videoId} recipe`,
  channel: 'Some Kitchen',
  description: 'Ingredients: paneer, spinach.',
  thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hq.jpg`,
  publishedAt: new Date(NOW - 48 * HOUR).toISOString(),
  viewCount: 1_000,
  ...over,
});

const searchReturning = (byQuery: Record<string, VideoCandidate[]>): VideoSearch =>
  vi.fn(async (q) => byQuery[q.text] ?? []);

const nothingSeen = vi.fn(async () => new Set<string>());

/* -------------------------------- queries --------------------------------- */

describe('the twelve queries of a run', () => {
  it('asks six general questions and six cuisine ones', () => {
    const queries = queriesFor(NOW);
    expect(queries).toHaveLength(12);
    expect(queries.slice(0, 6)).toEqual([...GENERAL_QUERIES]);
  });

  it('rotates the cuisines from one week to the next', () => {
    const thisWeek = cuisineQueriesFor(NOW);
    const nextWeek = cuisineQueriesFor(NOW + 7 * 86_400_000);
    expect(new Set(thisWeek).size).toBe(6);
    expect(thisWeek).not.toEqual(nextWeek);
  });

  it('comes back round to the same cuisines once the pool is exhausted', () => {
    // Eighteen cuisines, six a week: the rotation must close rather than
    // drift, or some cuisine is only ever asked about in a leap year.
    const weeks = CUISINE_POOL.length / 6;
    expect(cuisineQueriesFor(NOW + weeks * 7 * 86_400_000)).toEqual(cuisineQueriesFor(NOW));
  });
});

/* -------------------------------- ranking --------------------------------- */

describe('ranking by views per hour', () => {
  it('prefers the video gathering views faster', () => {
    const fast = video('fast', { viewCount: 10_000, publishedAt: new Date(NOW - 10 * HOUR).toISOString() });
    const slow = video('slow', { viewCount: 20_000, publishedAt: new Date(NOW - 100 * HOUR).toISOString() });
    expect(rankCandidates([slow, fast], NOW).map((v) => v.videoId)).toEqual(['fast', 'slow']);
  });

  it('does not let a video published minutes ago top the chart on three views', () => {
    // Without the one-hour floor the divisor does the ranking: 3 views over
    // four minutes scores 45/hour and beats a real hit.
    const newborn = video('newborn', {
      viewCount: 3,
      publishedAt: new Date(NOW - 4 * 60_000).toISOString(),
    });
    const hit = video('hit', { viewCount: 500, publishedAt: new Date(NOW - 5 * HOUR).toISOString() });
    expect(rankCandidates([newborn, hit], NOW)[0]?.videoId).toBe('hit');
  });

  it('sinks a video whose published date cannot be read', () => {
    const broken = video('broken', { viewCount: 1_000_000, publishedAt: 'last tuesday' });
    expect(viewsPerHour(broken, NOW)).toBe(0);
    expect(rankCandidates([broken, video('ok')], NOW)[0]?.videoId).toBe('ok');
  });

  it('keeps one row per video when several queries return it', () => {
    const ranked = rankCandidates([video('a', { viewCount: 10 }), video('a', { viewCount: 99 })], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.viewCount).toBe(99);
  });
});

/* -------------------------------- discovery ------------------------------- */

describe('discovering candidates', () => {
  it('asks only for videos published inside the seven-day window', async () => {
    const search = searchReturning({});
    await discoverVideos({ search, seen: nothingSeen, now: NOW });
    const first = vi.mocked(search).mock.calls[0]?.[0];
    expect(Date.parse(first?.publishedAfter ?? '')).toBe(NOW - 7 * 86_400_000);
  });

  it('never returns a video that is already in seen_videos', async () => {
    // Section 6's whole reason for the table: "so a video is never processed
    // twice".
    const search = searchReturning({ 'viral recipe': [video('old'), video('new')] });
    const result = await discoverVideos({
      search,
      seen: async () => new Set(['old']),
      now: NOW,
    });
    expect(result.candidates.map((v) => v.videoId)).toEqual(['new']);
    // `found` counts what the searches turned up, not what survived.
    expect(result.found).toBe(2);
  });

  it('carries on when one of the twelve queries fails', async () => {
    const search: VideoSearch = vi.fn(async (q) => {
      if (q.text === 'viral recipe') throw new Error('quota exceeded');
      return [video(q.text.slice(0, 4))];
    });
    const result = await discoverVideos({ search, seen: nothingSeen, now: NOW });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('quota exceeded');
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('keeps at most the top sixty', async () => {
    const many = Array.from({ length: 80 }, (_, i) => video(`v${String(i)}`, { viewCount: i }));
    const search = searchReturning({ 'viral recipe': many });
    const result = await discoverVideos({ search, seen: nothingSeen, now: NOW });
    expect(result.candidates).toHaveLength(60);
    expect(result.candidates[0]?.videoId).toBe('v79');
  });
});
