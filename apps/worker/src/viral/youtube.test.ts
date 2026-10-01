import { describe, expect, it, vi } from 'vitest';
import { youtubeSearch } from './youtube.js';

/**
 * The YouTube adapter against a fake `fetch`: the two calls it makes, the
 * shape it maps to, and that the API key never leaks into an error — those
 * end up on the status page.
 */

const KEY = 'AIza-not-a-real-key';
const QUERY = { text: 'viral recipe', publishedAfter: '2026-09-24T00:00:00.000Z', limit: 25 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const video = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    title: `Dish ${id}`,
    channelTitle: 'Nani Cooks',
    description: 'Ingredients: 200 g paneer…',
    publishedAt: '2026-09-28T10:00:00Z',
    thumbnails: { default: { url: `https://i.ytimg.com/${id}/d.jpg` }, high: { url: `https://i.ytimg.com/${id}/h.jpg` } },
    ...over,
  },
  statistics: { viewCount: '12345' },
});

function fakeFetch(search: unknown, videos: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return url.pathname.endsWith('/search') ? json(search) : json(videos);
  });
}

describe('youtubeSearch', () => {
  it('searches, then enriches the ids it found', async () => {
    const fetcher = fakeFetch(
      { items: [{ id: { videoId: 'a' } }, { id: { videoId: 'b' } }, { id: { videoId: 'a' } }] },
      { items: [video('a'), video('b')] },
    );
    const out = await youtubeSearch(KEY, fetcher as unknown as typeof fetch)(QUERY);

    const [search, enrich] = fetcher.mock.calls.map(([u]) => new URL(String(u)));
    expect(search?.searchParams.get('q')).toBe('viral recipe');
    expect(search?.searchParams.get('publishedAfter')).toBe(QUERY.publishedAfter);
    expect(search?.searchParams.get('order')).toBe('viewCount');
    // Deduplicated before enrich: one id, one quota slot.
    expect(enrich?.searchParams.get('id')).toBe('a,b');

    expect(out).toEqual([
      {
        videoId: 'a',
        title: 'Dish a',
        channel: 'Nani Cooks',
        description: 'Ingredients: 200 g paneer…',
        thumbnailUrl: 'https://i.ytimg.com/a/h.jpg',
        publishedAt: '2026-09-28T10:00:00Z',
        viewCount: 12345,
      },
      expect.objectContaining({ videoId: 'b' }),
    ]);
  });

  it('makes no enrich call when the search finds nothing', async () => {
    const fetcher = fakeFetch({ items: [] }, { items: [] });
    expect(await youtubeSearch(KEY, fetcher as unknown as typeof fetch)(QUERY)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('drops a video it could not credit', async () => {
    const fetcher = fakeFetch(
      { items: [{ id: { videoId: 'a' } }] },
      { items: [video('a', { channelTitle: '' })] },
    );
    expect(await youtubeSearch(KEY, fetcher as unknown as typeof fetch)(QUERY)).toEqual([]);
  });

  it("names Google's reason on failure and never the key", async () => {
    const fetcher = vi.fn(async () =>
      json({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403),
    );
    const error = await youtubeSearch(KEY, fetcher as unknown as typeof fetch)(QUERY).catch(
      (e: Error) => e,
    );
    expect(String(error)).toContain('403 (quotaExceeded)');
    expect(String(error)).not.toContain(KEY);
  });
});
