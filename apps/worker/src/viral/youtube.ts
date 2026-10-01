import type { VideoCandidate, VideoQuery, VideoSearch } from './discover.js';

/**
 * The YouTube Data API behind `VideoSearch` (section 6's discover and enrich
 * steps).
 *
 * Two calls per query: `search.list` for ids — its snippets truncate the
 * description, and descriptions are where the recipe is — then `videos.list`
 * for the full snippet and the view count the ranking needs.
 *
 * ponytail: enrich runs once per query, so twelve `videos.list` calls of up
 * to 25 ids where section 6 budgets six of 50. That is 12 quota units against
 * a 10,000-unit day, and it keeps the port one function per query. Batch
 * across queries only if quota ever gets tight; `search.list` at 100 units a
 * call is the cost that matters, and that is unchanged.
 *
 * The API key never appears in an error. A thrown message ends up in
 * `pipeline_runs.errors`, which the signed-in status page shows.
 */

const API = 'https://www.googleapis.com/youtube/v3';

interface SearchListResponse {
  items?: { id?: { videoId?: string } }[];
}

interface VideosListResponse {
  items?: {
    id?: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      description?: string;
      publishedAt?: string;
      thumbnails?: Record<string, { url?: string } | undefined>;
    };
    statistics?: { viewCount?: string };
  }[];
}

export function youtubeSearch(
  apiKey: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): VideoSearch {
  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', apiKey);

    const res = await fetcher(url.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // Google's error body names the reason (quotaExceeded, keyInvalid)
      // without echoing the key; the URL would echo it, so it is left out.
      const body = (await res.json().catch(() => null)) as {
        error?: { errors?: { reason?: string }[]; message?: string };
      } | null;
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.message ?? 'unknown';
      throw new Error(`YouTube ${path} returned ${String(res.status)} (${reason})`);
    }
    return (await res.json()) as T;
  };

  return async (query: VideoQuery): Promise<VideoCandidate[]> => {
    const found = await get<SearchListResponse>('search', {
      part: 'id',
      q: query.text,
      type: 'video',
      order: 'viewCount',
      publishedAfter: query.publishedAfter,
      maxResults: String(Math.min(50, query.limit)),
      // Recipes in a language the extractor cannot read are wasted calls.
      relevanceLanguage: 'en',
      safeSearch: 'strict',
    });

    const ids = [
      ...new Set((found.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return [];

    const details = await get<VideosListResponse>('videos', {
      part: 'snippet,statistics',
      id: ids.join(','),
      maxResults: '50',
    });

    const videos: VideoCandidate[] = [];
    for (const item of details.items ?? []) {
      const s = item.snippet;
      // A video without these cannot be credited or ranked, and section 6
      // wants every stored recipe to credit its creator.
      if (!item.id || !s?.title || !s.channelTitle || !s.publishedAt) continue;
      const thumbs = s.thumbnails ?? {};
      videos.push({
        videoId: item.id,
        title: s.title,
        channel: s.channelTitle,
        description: s.description ?? '',
        thumbnailUrl: thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null,
        publishedAt: s.publishedAt,
        viewCount: Number(item.statistics?.viewCount ?? 0) || 0,
      });
    }
    return videos;
  };
}
