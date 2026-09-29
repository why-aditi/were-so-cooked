import { type AiBinding, errText, failed, mean, result, table, timer } from '../../_lib/report.js';

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

interface VectorizeIndex {
  describe(): Promise<{ dimensions?: number; vectorsCount?: number; processedUpToMutation?: string }>;
  upsert(
    vectors: {
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }[],
  ): Promise<{ mutationId?: string }>;
  query(
    vector: number[],
    opts: {
      topK?: number;
      returnMetadata?: boolean | 'all' | 'indexed';
      filter?: Record<string, unknown>;
    },
  ): Promise<{ matches: VectorizeMatch[] }>;
}

interface Env {
  AI: AiBinding;
  RECIPES: VectorizeIndex;
}

const EMBED_MODEL = '@cf/baai/bge-m3';
const SPEC_DIMENSIONS = 1024;

/** Five catalog-shaped recipes plus one query, so the search is realistic. */
const CORPUS = [
  { id: 'r1', text: 'Palak paneer, creamy spinach curry with paneer cubes', cuisine: 'indian', diet: 'vegetarian' },
  { id: 'r2', text: 'Vegan butter chicken made with soya chaap and cashew cream', cuisine: 'indian', diet: 'vegan' },
  { id: 'r3', text: 'Shoyu ramen with chashu pork and soft boiled egg', cuisine: 'japanese', diet: 'omnivore' },
  { id: 'r4', text: 'Pasta alla norma with aubergine and ricotta salata', cuisine: 'italian', diet: 'vegetarian' },
  { id: 'r5', text: 'Chana masala, spiced chickpea curry with tomato and ginger', cuisine: 'indian', diet: 'vegan' },
];
const QUERY_TEXT = 'a creamy north indian curry i can make with paneer';

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run<{ data: number[][] }>(EMBED_MODEL, { text: texts });
  return res.data;
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const meta = {
      n: 1,
      title: 'Vectorize on a free account',
      question: 'Can a free account create and query a Vectorize index?',
      decides: 'Vectorize vs the D1 fallback (section 12).',
    };

    try {
      // 1. Embedding dimensions must match the index and the section 4 budget maths.
      const tEmbed = timer();
      const vectors = await embed(env, CORPUS.map((c) => c.text));
      const embedMs = tEmbed();
      const dims = vectors[0]?.length ?? 0;

      // 2. Describe the index that the runner created via the CLI.
      let described: unknown;
      let describeErr = '';
      try {
        described = await env.RECIPES.describe();
      } catch (e) {
        describeErr = errText(e);
      }

      // 3. Upsert with the section 4 metadata shape.
      const tUpsert = timer();
      const upserted = await env.RECIPES.upsert(
        CORPUS.map((c, i) => ({
          id: c.id,
          values: vectors[i] as number[],
          metadata: { cuisine: c.cuisine, diet_tags: c.diet, trending: false },
        })),
      );
      const upsertMs = tUpsert();

      // 4. Vectorize applies mutations asynchronously, so poll until the
      //    vectors are queryable. How long that takes is a real design input:
      //    the viral pipeline writes and the chat reads minutes apart.
      const [queryVector] = await embed(env, [QUERY_TEXT]);
      const tVisible = timer();
      let matches: VectorizeMatch[] = [];
      let polls = 0;
      let visibleMs = -1;
      while (polls < 40) {
        polls += 1;
        const res = await env.RECIPES.query(queryVector as number[], {
          topK: 3,
          returnMetadata: 'all',
        });
        if (res.matches.length > 0) {
          matches = res.matches;
          visibleMs = tVisible();
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // 5. Metadata filtering is what section 6 needs to pre-filter by diet.
      const tFilter = timer();
      let filtered: VectorizeMatch[] = [];
      let filterErr = '';
      try {
        const res = await env.RECIPES.query(queryVector as number[], {
          topK: 3,
          returnMetadata: 'all',
          filter: { cuisine: 'indian' },
        });
        filtered = res.matches;
      } catch (e) {
        filterErr = errText(e);
      }
      const filterMs = tFilter();

      // 6. Query latency over repeated runs, since chat is on this path.
      const latencies: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t = timer();
        await env.RECIPES.query(queryVector as number[], { topK: 3 });
        latencies.push(t());
      }

      const queryable = matches.length > 0;
      const answer = queryable
        ? `**Yes.** A free account created the index, upserted ${CORPUS.length} vectors and got ` +
          `${matches.length} ranked matches back. Vectorize is usable; the D1 fallback in section 12 ` +
          `stays a documented contingency rather than the default. Vectors became queryable ` +
          `${visibleMs} ms after upsert, so the write path is not instant — the viral pipeline must ` +
          `not assume read-after-write.`
        : `**No — or not usable in practice.** The index accepted an upsert but nothing became ` +
          `queryable within ${polls} polls (~60 s). Treat Vectorize as unavailable and take the ` +
          `D1 BLOB fallback with \`bge-small-en-v1.5\` (384 dims) from section 12.`;

      const body = `## Measured

${table(
  ['Measurement', 'Value'],
  [
    ['Embedding model', EMBED_MODEL],
    ['Dimensions returned', `${dims} (section 4 assumes ${SPEC_DIMENSIONS})`],
    ['Dimensions match spec', dims === SPEC_DIMENSIONS ? 'yes' : `NO — budget maths need redoing`],
    ['Embed 5 texts', `${embedMs} ms`],
    ['Upsert 5 vectors', `${upsertMs} ms`],
    ['Mutation id returned', upserted.mutationId ?? '(none)'],
    ['Polls until queryable', queryable ? String(polls) : `gave up after ${polls}`],
    ['Time until queryable', queryable ? `${visibleMs} ms` : 'never'],
    ['Query latency (mean of 5)', `${mean(latencies).toFixed(0)} ms`],
    ['Query latency (min / max)', `${Math.min(...latencies)} / ${Math.max(...latencies)} ms`],
    ['Metadata filter supported', filterErr ? `NO — ${filterErr}` : `yes (${filtered.length} matches, ${filterMs} ms)`],
    ['index.describe()', describeErr ? `failed — ${describeErr}` : JSON.stringify(described)],
  ],
)}

## Ranked matches for "${QUERY_TEXT}"

${
  queryable
    ? table(
        ['id', 'score', 'recipe', 'metadata'],
        matches.map((m) => [
          m.id,
          m.score.toFixed(4),
          CORPUS.find((c) => c.id === m.id)?.text ?? '(unknown)',
          JSON.stringify(m.metadata ?? {}),
        ]),
      )
    : '_No matches were returned._'
}

## What this changes

- **Storage budget:** at ${dims} dimensions the free allowance of 5 million stored
  dimensions holds about ${Math.floor(5_000_000 / Math.max(dims, 1)).toLocaleString('en-US')} recipes.
  Section 4 assumed about 4,800.
- **Read-after-write:** ${queryable ? `${visibleMs} ms` : 'unbounded'} between upsert and visibility.
  \`ViralRecipesWorkflow\` must treat the Vectorize upsert as fire-and-forget and keep D1 authoritative.
- **Pre-filtering:** ${filterErr ? 'metadata filters failed, so diet and allergen filtering has to happen in SQL before the vector search.' : 'metadata filters work, so the section 6 diet and allergen pre-filter can run inside the query.'}
`;

      return result({ ...meta, answer, body });
    } catch (e) {
      return failed({
        ...meta,
        error: e,
        note:
          '## Reading this failure\n\n' +
          'If the error mentions billing, entitlement or "not available on your plan", the answer to ' +
          'the spike is **no** and section 12\'s D1 fallback becomes the primary path. If the index ' +
          'simply does not exist, the runner\'s `wrangler vectorize create` step failed first — check ' +
          'its output.\n',
      });
    }
  },
};
