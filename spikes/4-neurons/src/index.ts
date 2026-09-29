import {
  type AiBinding,
  type AiTextResult,
  errText,
  failed,
  mean,
  result,
  table,
  timer,
} from '../../_lib/report.js';
import { CHAT_MODEL, TOOLS, chatMessages, planPrompt, repairPrompt } from './context.js';
import { type UsageSnapshot, fetchPublishedRate, readUsage } from './neurons.js';

interface Env {
  AI: AiBinding;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

/* Section 8's assumptions, the thing this spike exists to check. */
const SPEC = {
  chat: { in: 2500, out: 250, neurons: 120 },
  planGenerate: { in: 3000, out: 1800, calls: 2, neurons: 900 },
  planRepair: { in: 2000, out: 600, neurons: 180 },
  /** Section 12: signed-in users get 2,000 neurons a day. */
  userCap: 2000,
  /** Section 12: a plan with one repair round is "about 1,100". */
  planWithRepair: 1100,
  accountDaily: 10000,
};

/**
 * How long to wait for the analytics pipeline before giving up on a phase.
 *
 * Measured on 2026-09-25: a phase's neurons took between 60 and 120 seconds to
 * appear. The first run budgeted 8 polls x 8s = 64s, which was too short — the
 * chat phase never settled, and because an unsettled phase contributes 0 to the
 * next phase's subtraction, the plan-generate figure silently came out as a
 * running total instead of a delta. A too-short wait does not just lose a
 * number here, it corrupts the next one.
 *
 * 20 x 10s = 200s per phase. Under `wrangler dev` the Worker runs locally, so
 * the free plan's 50-subrequest cap does not apply; a deployed version of this
 * spike would need to cut the budget or split the phases across requests.
 */
const MAX_SETTLE_POLLS = 20;
const SETTLE_INTERVAL_MS = 10000;

interface Call {
  label: string;
  inTokens: number | null;
  outTokens: number | null;
  ms: number;
  error: string;
}

async function measure(env: Env, label: string, input: Record<string, unknown>): Promise<Call> {
  const t = timer();
  try {
    const res = await env.AI.run<AiTextResult>(CHAT_MODEL, input);
    return {
      label,
      inTokens: res.usage?.prompt_tokens ?? null,
      outTokens: res.usage?.completion_tokens ?? null,
      ms: t(),
      error: '',
    };
  } catch (e) {
    return { label, inTokens: null, outTokens: null, ms: t(), error: errText(e) };
  }
}

/**
 * Analytics lag behind the calls by tens of seconds, so a phase's cost is only
 * readable once the running total has moved past the previous phase.
 */
async function settle(
  env: Env,
  from: Date,
  above: number,
): Promise<{ snapshot: UsageSnapshot; polls: number; settled: boolean }> {
  let snapshot = await readUsage(env.CLOUDFLARE_API_TOKEN ?? '', env.CLOUDFLARE_ACCOUNT_ID ?? '', from);
  let polls = 1;
  while (polls < MAX_SETTLE_POLLS && snapshot.ok && snapshot.totalNeurons <= above) {
    await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
    snapshot = await readUsage(
      env.CLOUDFLARE_API_TOKEN ?? '',
      env.CLOUDFLARE_ACCOUNT_ID ?? '',
      from,
    );
    polls += 1;
  }
  return { snapshot, polls, settled: snapshot.ok && snapshot.totalNeurons > above };
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function verdict(measured: number | null, assumed: number): string {
  if (measured == null) return 'not measured';
  const d = measured - assumed;
  return d >= 0
    ? `over by ${fmt(d, 1)} (${((d / assumed) * 100).toFixed(0)}%)`
    : `under by ${fmt(-d, 1)} (${((-d / assumed) * 100).toFixed(0)}%)`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const meta = {
      n: 4,
      title: 'Real neurons per chat turn and per plan',
      question: 'Real neurons per chat turn and per plan.',
      decides: 'Section 12 caps.',
    };

    const params = new URL(req.url).searchParams;
    const chatReps = Math.min(5, Math.max(1, Number(params.get('chat') ?? 3)));
    const runPlan = params.get('plan') !== '0';

    try {
      // Everything billed from here on belongs to this run, so no "before"
      // snapshot is needed — the window itself scopes the query.
      const runStart = new Date(Date.now() - 5000);
      const calls: Call[] = [];

      // Phase 1: chat turns, full section 5 context window, tools attached.
      for (let i = 0; i < chatReps; i += 1) {
        calls.push(
          await measure(env, `chat turn ${i + 1}`, {
            messages: chatMessages(),
            tools: TOOLS,
            max_tokens: 512,
          }),
        );
      }
      const afterChat = await settle(env, runStart, 0);
      const chatNeurons = afterChat.settled ? afterChat.snapshot.totalNeurons : null;

      // Phase 2: the two plan generation calls.
      let genNeurons: number | null = null;
      let repairNeurons: number | null = null;
      let afterGen = afterChat;
      let afterRepair = afterChat;

      if (runPlan) {
        calls.push(
          await measure(env, 'plan generate, days 1-4', {
            messages: [
              { role: 'system', content: 'You plan meals. Answer with strict JSON only.' },
              {
                role: 'user',
                content: planPrompt(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']),
              },
            ],
            max_tokens: 2048,
          }),
        );
        calls.push(
          await measure(env, 'plan generate, days 5-7', {
            messages: [
              { role: 'system', content: 'You plan meals. Answer with strict JSON only.' },
              { role: 'user', content: planPrompt(['2026-09-28', '2026-09-29', '2026-09-30']) },
            ],
            max_tokens: 2048,
          }),
        );
        afterGen = await settle(env, runStart, chatNeurons ?? 0);
        genNeurons = afterGen.settled ? afterGen.snapshot.totalNeurons - (chatNeurons ?? 0) : null;

        // Phase 3: one repair round.
        calls.push(
          await measure(env, 'plan repair round', {
            messages: [
              { role: 'system', content: 'You repair meal plans. Answer with strict JSON only.' },
              { role: 'user', content: repairPrompt() },
            ],
            max_tokens: 1024,
          }),
        );
        afterRepair = await settle(env, runStart, afterGen.snapshot.totalNeurons);
        repairNeurons = afterRepair.settled
          ? afterRepair.snapshot.totalNeurons - afterGen.snapshot.totalNeurons
          : null;
      }

      const rate = await fetchPublishedRate(CHAT_MODEL);

      const chatCalls = calls.filter((c) => c.label.startsWith('chat') && !c.error);
      const genCalls = calls.filter((c) => c.label.startsWith('plan generate') && !c.error);
      const repairCall = calls.find((c) => c.label === 'plan repair round' && !c.error);

      const chatIn = chatCalls.length ? mean(chatCalls.map((c) => c.inTokens ?? 0)) : null;
      const chatOut = chatCalls.length ? mean(chatCalls.map((c) => c.outTokens ?? 0)) : null;
      const perChat = chatNeurons != null && chatReps > 0 ? chatNeurons / chatReps : null;

      const genIn = genCalls.length ? genCalls.reduce((n, c) => n + (c.inTokens ?? 0), 0) : null;
      const genOut = genCalls.length ? genCalls.reduce((n, c) => n + (c.outTokens ?? 0), 0) : null;

      const planTotal =
        genNeurons != null && repairNeurons != null ? genNeurons + repairNeurons : null;
      const turnsLeft =
        perChat != null && planTotal != null && perChat > 0
          ? Math.floor((SPEC.userCap - planTotal) / perChat)
          : null;

      const exhausted = calls.some((c) => /daily free allocation|4006/.test(c.error));

      const answer = exhausted
        ? `**The account was already out of neurons.** Every call returned a 429, so nothing here ` +
          `is a measurement. The cap resets at 00:00 UTC; run the spike again after that.`
        : perChat == null
          ? `**Tokens measured, neurons not.** Calls returned token usage, but the billed figure ` +
            `could not be read: ${afterChat.snapshot.detail}. Token counts below are sound.`
          : `**A chat turn costs ${fmt(perChat, 1)} neurons** against section 8's estimate of ` +
            `${SPEC.chat.neurons}` +
            (planTotal != null
              ? `, and **a full plan with one repair round costs ${fmt(planTotal, 0)}** against ` +
                `section 12's "about ${SPEC.planWithRepair}".`
              : '.') +
            (turnsLeft != null
              ? `\n\nThat leaves **${turnsLeft} chat turns** inside the ${fmt(SPEC.userCap)}-neuron ` +
                `signed-in user cap after one plan; section 12 budgeted for about 7. ` +
                (turnsLeft >= 7
                  ? `**The cap holds.**`
                  : `**The cap does not hold** — raise it, trim the context window, or move plan ` +
                    `generation to a cheaper model.`)
              : '') +
            `\n\nEvery neuron figure is Cloudflare's own billed number, not a derivation: ` +
            `\`${afterChat.snapshot.detail}\`.`;

      const body = `## Every call in this run

${table(
  ['Call', 'prompt_tokens', 'completion_tokens', 'Latency', 'Error'],
  calls.map((c) => [
    c.label,
    fmt(c.inTokens),
    fmt(c.outTokens),
    `${c.ms} ms`,
    c.error ? c.error.slice(0, 80) : '—',
  ]),
)}

## Billed neurons, by phase

Each phase is a separate window on \`aiInferenceAdaptiveGroups.sum.totalNeurons\`, so the
figures are what Cloudflare charged, not tokens multiplied by a rate.

${table(
  ['Phase', 'Calls', 'Billed neurons', 'Per call', 'Analytics polls'],
  [
    ['Chat turns', chatReps, fmt(chatNeurons, 1), fmt(perChat, 1), afterChat.polls],
    ['Plan generate', runPlan ? 2 : 0, fmt(genNeurons, 1), fmt(genNeurons != null ? genNeurons / 2 : null, 1), afterGen.polls],
    ['Plan repair', runPlan ? 1 : 0, fmt(repairNeurons, 1), fmt(repairNeurons, 1), afterRepair.polls],
    ['Plan total', runPlan ? 3 : 0, fmt(planTotal, 1), '—', '—'],
  ],
)}

## Measured against section 8

${table(
  ['Task', 'Assumed in / out', 'Measured in / out', 'Assumed neurons', 'Billed neurons', 'Verdict'],
  [
    [
      'Chat turn with tools',
      `${fmt(SPEC.chat.in)} / ${fmt(SPEC.chat.out)}`,
      `${fmt(chatIn)} / ${fmt(chatOut)}`,
      SPEC.chat.neurons,
      fmt(perChat, 1),
      verdict(perChat, SPEC.chat.neurons),
    ],
    [
      'Weekly plan generate (2 calls)',
      `${fmt(SPEC.planGenerate.in * 2)} / ${fmt(SPEC.planGenerate.out * 2)}`,
      `${fmt(genIn)} / ${fmt(genOut)}`,
      SPEC.planGenerate.neurons,
      fmt(genNeurons, 1),
      verdict(genNeurons, SPEC.planGenerate.neurons),
    ],
    [
      'Plan repair round',
      `${fmt(SPEC.planRepair.in)} / ${fmt(SPEC.planRepair.out)}`,
      `${fmt(repairCall?.inTokens ?? null)} / ${fmt(repairCall?.outTokens ?? null)}`,
      SPEC.planRepair.neurons,
      fmt(repairNeurons, 1),
      verdict(repairNeurons, SPEC.planRepair.neurons),
    ],
  ],
)}

## Section 12 caps, recomputed

${table(
  ['Line', 'Section 12 says', 'This run says'],
  [
    ['Plan with one repair round', `about ${fmt(SPEC.planWithRepair)} neurons`, fmt(planTotal, 0)],
    ['Chat turns left inside the 2,000 user cap', 'about 7', turnsLeft == null ? 'not measured' : String(turnsLeft)],
    [
      'Full reviewer sessions per day (10,000 account)',
      'about 6',
      planTotal != null && perChat != null
        ? String(Math.floor(SPEC.accountDaily / (planTotal + perChat * 7)))
        : 'not measured',
    ],
    [
      'Demo user cap (800) in chat turns',
      'a ready plan plus a few turns',
      perChat != null ? `${Math.floor(800 / perChat)} turns, no plan` : 'not measured',
    ],
  ],
)}

## Per model, this run

${
  afterRepair.snapshot.ok && afterRepair.snapshot.byModel.length > 0
    ? table(
        ['Model', 'Requests', 'Billed neurons', 'Input tokens', 'Output tokens'],
        afterRepair.snapshot.byModel.map((m) => [
          m.modelId,
          m.requests,
          fmt(m.neurons, 1),
          fmt(m.inputTokens),
          fmt(m.outputTokens),
        ]),
      )
    : `_No per-model rows: ${afterRepair.snapshot.detail}_`
}

## Cross-check against the published rate

${table(
  ['', 'Value'],
  [
    ['Source', rate.note],
    ['Input neurons per M tokens', fmt(rate.inputNeuronsPerMillion)],
    ['Output neurons per M tokens', fmt(rate.outputNeuronsPerMillion)],
    [
      'Rate-derived total for this run',
      rate.inputNeuronsPerMillion != null && rate.outputNeuronsPerMillion != null
        ? fmt(
            (calls.reduce((n, c) => n + (c.inTokens ?? 0), 0) / 1e6) * rate.inputNeuronsPerMillion +
              (calls.reduce((n, c) => n + (c.outTokens ?? 0), 0) / 1e6) *
                rate.outputNeuronsPerMillion,
            1,
          )
        : 'n/a',
    ],
    ['Billed total for this run', fmt(afterRepair.snapshot.totalNeurons, 1)],
  ],
)}

## What this changes

- **Section 8 table:** replace the assumed token counts with the measured ones above.
- **Section 12 per-user cap:** ${
        turnsLeft == null
          ? 'recompute once the billed figures are available.'
          : turnsLeft >= 7
            ? `the 2,000 cap gives ${turnsLeft} turns after a plan, so it stands.`
            : `the 2,000 cap gives only ${turnsLeft} turns after a plan. Trim the 1,200-token system prompt or reduce the 600-token pantry slot.`
      }
- **Fixed cost per turn:** the system prompt and tool definitions are paid on every
  turn before the user's message is even read. ${chatIn != null ? `That is most of the ${fmt(chatIn)} input tokens measured.` : ''}

## Caveat, stated plainly

The billed figure counts **all** Workers AI traffic on the account inside each phase
window. Nothing else may call Workers AI while this runs. Latency includes
\`wrangler dev\` round-trips and is not production latency.
`;

      return result({ ...meta, answer, body });
    } catch (e) {
      return failed({ ...meta, error: e });
    }
  },
};
