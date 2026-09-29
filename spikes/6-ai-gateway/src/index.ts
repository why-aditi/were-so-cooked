import { type AiBinding, errText, failed, result, table, timer } from '../../_lib/report.js';

interface Env {
  AI: AiBinding;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

const GATEWAY_ID = 'cooked-spike6';
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

/**
 * A demo suggestion chip from section 12: identical context every time, which
 * is exactly the traffic caching is supposed to serve for free.
 */
const INPUT = {
  messages: [
    { role: 'system', content: 'You are a terse cooking assistant. One sentence, no preamble.' },
    { role: 'user', content: 'what can i make tonight with paneer and palak?' },
  ],
  max_tokens: 96,
  temperature: 0,
};

interface Attempt {
  label: string;
  status: number | null;
  cacheStatus: string;
  ms: number;
  bodyPreview: string;
  error: string;
}

async function createGateway(env: Env): Promise<{ ok: boolean; detail: string }> {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    return {
      ok: false,
      detail: 'no CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN, so creation was not attempted',
    };
  }
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: GATEWAY_ID,
          cache_ttl: 3600,
          cache_invalidate_on_update: false,
          collect_logs: true,
          rate_limiting_interval: 0,
          rate_limiting_limit: 0,
          rate_limiting_technique: 'fixed',
        }),
      },
    );
    const json = (await res.json()) as {
      success?: boolean;
      errors?: { code?: number; message?: string }[];
    };
    if (json.success) return { ok: true, detail: `created (HTTP ${res.status})` };
    const messages = (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim());
    // "already exists" is a pass for our purposes.
    if (messages.some((m) => /already exists|duplicate/i.test(m))) {
      return { ok: true, detail: `already existed (HTTP ${res.status})` };
    }
    return { ok: false, detail: `HTTP ${res.status}: ${messages.join('; ') || 'unknown error'}` };
  } catch (e) {
    return { ok: false, detail: errText(e) };
  }
}

async function call(
  env: Env,
  label: string,
  opts: { skipCache: boolean },
): Promise<Attempt> {
  const t = timer();
  try {
    const res = await env.AI.run<Response>(
      MODEL,
      { ...INPUT },
      {
        gateway: { id: GATEWAY_ID, cacheTtl: 3600, skipCache: opts.skipCache },
        returnRawResponse: true,
      },
    );
    const text = await res.text();
    return {
      label,
      status: res.status,
      // The header AI Gateway sets on every response it handles.
      cacheStatus: res.headers.get('cf-aig-cache-status') ?? '(header absent)',
      ms: t(),
      bodyPreview: text.slice(0, 120),
      error: res.ok ? '' : text.slice(0, 200),
    };
  } catch (e) {
    return {
      label,
      status: null,
      cacheStatus: '—',
      ms: t(),
      bodyPreview: '',
      error: errText(e),
    };
  }
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const meta = {
      n: 6,
      title: 'AI Gateway caching on the free plan',
      question: 'Is AI Gateway caching available on the free plan?',
      decides: 'Demo caching strategy.',
    };

    try {
      const creation = await createGateway(env);

      const attempts: Attempt[] = [];
      attempts.push(await call(env, '1st call (cold)', { skipCache: false }));
      attempts.push(await call(env, '2nd call (identical)', { skipCache: false }));
      attempts.push(await call(env, '3rd call (identical)', { skipCache: false }));
      attempts.push(await call(env, '4th call (skipCache: true)', { skipCache: true }));

      const [cold, second, third, skipped] = attempts;
      const hits = attempts.filter((a) => /hit/i.test(a.cacheStatus));
      const caching = hits.length > 0;
      const headerPresent = attempts.some((a) => a.cacheStatus !== '(header absent)');

      const coldMs = cold?.ms ?? 0;
      const hitMs = second && /hit/i.test(second.cacheStatus) ? second.ms : (third?.ms ?? 0);
      const speedup = coldMs > 0 && hitMs > 0 ? coldMs / hitMs : 0;

      const answer = caching
        ? `**Yes.** Identical requests through gateway \`${GATEWAY_ID}\` came back as ` +
          `\`${hits[0]?.cacheStatus}\` on repeat, in **${hitMs} ms** against **${coldMs} ms** cold ` +
          `(${speedup.toFixed(1)}x faster), and a cached response does not reach the model, so it ` +
          `costs no neurons. Section 12's demo caching strategy works: give every demo suggestion ` +
          `chip byte-identical context and repeat reviewers cost nothing.`
        : headerPresent
          ? `**The gateway works but did not serve a cache hit.** Repeat calls came back as ` +
            `\`${second?.cacheStatus}\`. Caching is either off on this gateway or not included on ` +
            `the free plan. Fall back to section 12's other levers: pre-generate the demo plan, ` +
            `store recipe steps in D1 once, and cache blurbs in the agent's own SQLite.`
          : `**Not usable.** No \`cf-aig-cache-status\` header came back at all, so requests are ` +
            `not going through AI Gateway${creation.ok ? '' : ` — gateway creation also failed: ${creation.detail}`}. ` +
            `Do not build the demo strategy on gateway caching; pre-generate demo content and ` +
            `cache in D1 instead.`;

      const body = `## Measured

${table(
  ['Call', 'HTTP', 'cf-aig-cache-status', 'Latency', 'Error'],
  attempts.map((a) => [a.label, a.status ?? 'n/a', a.cacheStatus, `${a.ms} ms`, a.error || '—']),
)}

${table(
  ['Measurement', 'Value'],
  [
    ['Gateway id', GATEWAY_ID],
    ['Gateway creation', creation.ok ? `succeeded — ${creation.detail}` : `failed — ${creation.detail}`],
    ['Model', MODEL],
    ['Cache header present', headerPresent ? 'yes' : 'no'],
    ['Cache hits observed', `${hits.length} of ${attempts.length - 1} repeatable calls`],
    ['Cold latency', `${coldMs} ms`],
    ['Cached latency', caching ? `${hitMs} ms` : 'n/a'],
    ['Speed-up', caching && speedup > 0 ? `${speedup.toFixed(1)}x` : 'n/a'],
    ['skipCache:true honoured', skipped ? (/hit/i.test(skipped.cacheStatus) ? 'NO — still served from cache' : `yes (${skipped.cacheStatus})`) : 'n/a'],
    ['Identical bodies on repeat', cold && second ? String(cold.bodyPreview === second.bodyPreview) : 'n/a'],
  ],
)}

## What this changes

- **Demo strategy:** ${caching ? 'the suggestion chips in section 12 must send byte-identical context, including the system prompt and any timestamp. One varying token and the cache never hits.' : 'pre-generated demo content carries the whole load; budget for it in the seed data rather than at runtime.'}
- **Budget:** ${caching ? 'a cached turn costs 0 neurons, so repeat reviewer sessions are close to free. The "about 6 sessions a day" figure in section 12 is a floor, not a ceiling.' : "section 12's neuron maths stands as written; there is no cache dividend to count on."}
- **Cache busting:** ${caching && skipped && !/hit/i.test(skipped.cacheStatus) ? '`skipCache: true` works, so real user turns can opt out while demo chips opt in.' : 'verify how to bypass the cache before relying on it for real user turns.'}

## Clean up

This spike leaves gateway \`${GATEWAY_ID}\` behind; wrangler has no delete command for it.
Remove it from the AI Gateway section of the dashboard, or:

\`\`\`
curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\
  https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/${GATEWAY_ID}
\`\`\`
`;

      return result({ ...meta, answer, body });
    } catch (e) {
      return failed({ ...meta, error: e });
    }
  },
};
