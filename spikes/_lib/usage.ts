/**
 * Billed neurons, read from the same GraphQL dataset the Cloudflare dashboard
 * uses for its "Neurons used today" figure.
 *
 * The dataset and metric names below are not guesses — they were found by
 * introspecting the live schema from the root `Query` type down through
 * `viewer.accounts`, and the query was verified against a day whose usage the
 * dashboard independently displayed. An earlier version of this file walked the
 * schema at run time looking for anything matching /ai.*groups/i on a type
 * called `Account`. No such type exists; `__type` returned null, the code read
 * that as "no dataset" and silently fell back. Naming the verified path is both
 * shorter and honest about what is known.
 */

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/** Verified live on 2026-09-23. */
const DATASET = 'aiInferenceAdaptiveGroups';

export interface ModelUsage {
  modelId: string;
  requests: number;
  neurons: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSnapshot {
  ok: boolean;
  detail: string;
  totalNeurons: number;
  byModel: ModelUsage[];
}

const QUERY = `query($a: String!, $s: Time!, $e: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    ${DATASET}(limit: 100, filter: { datetime_geq: $s, datetime_leq: $e }) {
      count
      sum { totalNeurons totalInputTokens totalOutputTokens }
      dimensions { modelId }
    }
  } }
}`;

/** Everything Workers AI billed this account between `from` and now. */
export async function readUsage(
  token: string,
  accountId: string,
  from: Date,
): Promise<UsageSnapshot> {
  const empty = { totalNeurons: 0, byModel: [] as ModelUsage[] };
  if (!token || !accountId) {
    return { ok: false, detail: 'no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID', ...empty };
  }
  try {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          a: accountId,
          s: from.toISOString(),
          e: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    });
    const json = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: {
            [k: string]: {
              count: number;
              sum: { totalNeurons: number; totalInputTokens: number; totalOutputTokens: number };
              dimensions: { modelId: string };
            }[];
          }[];
        };
      };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      return { ok: false, detail: json.errors.map((e) => e.message).join('; '), ...empty };
    }
    const rows = json.data?.viewer?.accounts?.[0]?.[DATASET];
    if (!Array.isArray(rows)) {
      return { ok: false, detail: `no ${DATASET} rows in response`, ...empty };
    }
    const byModel = rows.map((r) => ({
      modelId: r.dimensions.modelId,
      requests: r.count,
      neurons: r.sum.totalNeurons,
      inputTokens: r.sum.totalInputTokens,
      outputTokens: r.sum.totalOutputTokens,
    }));
    return {
      ok: true,
      detail: `${DATASET}.sum.totalNeurons over ${rows.length} model group(s)`,
      totalNeurons: byModel.reduce((n, m) => n + m.neurons, 0),
      byModel,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      ...empty,
    };
  }
}

/** Neurons consumed between two snapshots, per model and in total. */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): ModelUsage[] {
  const key = (m: string) => before.byModel.find((b) => b.modelId === m);
  return after.byModel
    .map((a) => {
      const b = key(a.modelId);
      return {
        modelId: a.modelId,
        requests: a.requests - (b?.requests ?? 0),
        neurons: a.neurons - (b?.neurons ?? 0),
        inputTokens: a.inputTokens - (b?.inputTokens ?? 0),
        outputTokens: a.outputTokens - (b?.outputTokens ?? 0),
      };
    })
    .filter((d) => d.requests > 0);
}
