import {
  type AiBinding,
  type AiTextResult,
  type AiToolCall,
  errText,
  failed,
  mean,
  pct,
  result,
  table,
  timer,
} from '../../_lib/report.js';

interface Env {
  AI: AiBinding;
}

const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Seven of the twelve tools from section 5. The ones left out (`list_pantry`,
 * `get_plan`, `get_grocery_list`, `check_grocery_item`, `search_trending`) are
 * read-only and unambiguous; the interesting failures are between the seven
 * below, which overlap in meaning.
 */
const TOOLS = [
  {
    name: 'add_pantry_items',
    description:
      'Add newly bought ingredients to the pantry. Use when the user says they bought, got or ' +
      'now have food.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The raw phrase describing what was bought.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'remove_pantry_items',
    description: 'Remove or delete items from the pantry, or mark them as used up or thrown away.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
      },
      required: ['names'],
    },
  },
  {
    name: 'log_cooked',
    description:
      'Record that the user has cooked a dish and deduct its ingredients from the pantry. Use ' +
      'when they say they made, cooked or ate something they prepared.',
    parameters: {
      type: 'object',
      properties: {
        recipe_title: { type: 'string' },
      },
      required: ['recipe_title'],
    },
  },
  {
    name: 'update_profile',
    description:
      'Change the diets, allergens or custom exclusions on the profile. Safety critical.',
    parameters: {
      type: 'object',
      properties: {
        diets: { type: 'array', items: { type: 'string' } },
        allergens: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
  {
    name: 'suggest_recipes',
    description:
      'Search the catalog and propose dishes the user could cook. Use for any "what can I make" ' +
      'or "suggest something" request.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_minutes: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'substitute',
    description:
      'Rewrite one named dish so it fits the profile, listing each swap. Use when the user names ' +
      'a specific dish and a constraint, such as "butter chicken but vegan".',
    parameters: {
      type: 'object',
      properties: {
        recipe_title: { type: 'string' },
        constraint: { type: 'string' },
      },
      required: ['recipe_title'],
    },
  },
  {
    name: 'start_weekly_plan',
    description: 'Start generating a full week of meals.',
    parameters: {
      type: 'object',
      properties: {
        week_start: { type: 'string' },
      },
      required: [],
    },
  },
];

/** The section 5 system prompt, trimmed to its rules. */
const SYSTEM =
  'You are the kitchen agent for "We\'re So Cooked". You manage one user\'s pantry, diet ' +
  'profile, meal plans and recipes. Hard rules: never invent pantry items; never write a recipe ' +
  'freehand, always call suggest_recipes or substitute; never make a safety or allergy claim ' +
  'yourself. Call exactly one tool when the user asks for an action, and call no tool when they ' +
  'are only chatting or asking about you.';

interface Case {
  prompt: string;
  expect: string | null;
  why: string;
}

const CASES: Case[] = [
  { prompt: 'bought 1kg paneer, 6 eggs and a bunch of dhaniya', expect: 'add_pantry_items', why: 'plain add (F2)' },
  { prompt: 'picked up some atta and two litres of milk on the way home', expect: 'add_pantry_items', why: 'add, no explicit verb' },
  { prompt: 'made palak paneer tonight', expect: 'log_cooked', why: 'auto-deduct (F4)' },
  { prompt: 'we finished the rest of the dahi yesterday', expect: 'remove_pantry_items', why: 'used up, not cooked — the nearest confusion to log_cooked' },
  { prompt: 'chuck the coriander, it has gone off', expect: 'remove_pantry_items', why: 'discard' },
  { prompt: "i'm vegan from today", expect: 'update_profile', why: 'safety-critical, needs approval (F5)' },
  { prompt: 'never give me mushrooms again', expect: 'update_profile', why: 'custom exclusion, could be misread as taste memory' },
  { prompt: 'what can i make tonight with what i have', expect: 'suggest_recipes', why: 'core suggestion path' },
  { prompt: 'butter chicken but vegan', expect: 'substitute', why: 'named dish + constraint (F6)' },
  { prompt: 'give me something korean for dinner, under 30 minutes', expect: 'suggest_recipes', why: 'any cuisine (F7); must not be read as substitute' },
  { prompt: 'plan my meals for next week', expect: 'start_weekly_plan', why: 'workflow kick-off (F8)' },
  { prompt: 'who built you?', expect: null, why: 'chat only — a false tool call here is what forces a pre-classifier' },
];

function toolName(call: AiToolCall | undefined): string | null {
  if (!call) return null;
  return call.name ?? call.function?.name ?? null;
}

function toolArgs(call: AiToolCall | undefined): Record<string, unknown> | null {
  if (!call) return null;
  const raw = call.arguments ?? call.function?.arguments;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface Attempt {
  prompt: string;
  expected: string | null;
  got: string | null;
  correct: boolean;
  argsValid: boolean;
  requiredPresent: boolean;
  known: boolean;
  extraCalls: number;
  ms: number;
  error: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const meta = {
      n: 3,
      title: 'Llama 3.3 70B tool-calling reliability',
      question: 'How reliably does Llama 3.3 70B call tools through `AIChatAgent`?',
      decides: 'Tool design; whether chat needs a pre-classifier.',
    };

    const reps = Math.min(5, Math.max(1, Number(new URL(req.url).searchParams.get('reps') ?? 2)));

    try {
      const attempts: Attempt[] = [];

      for (let rep = 0; rep < reps; rep += 1) {
        for (const c of CASES) {
          const t = timer();
          try {
            const res = await env.AI.run<AiTextResult>(CHAT_MODEL, {
              messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: c.prompt },
              ],
              tools: TOOLS,
              max_tokens: 256,
            });
            const calls = res.tool_calls ?? [];
            const got = toolName(calls[0]);
            const args = toolArgs(calls[0]);
            const spec = TOOLS.find((t2) => t2.name === got);
            const required = spec?.parameters.required ?? [];
            attempts.push({
              prompt: c.prompt,
              expected: c.expect,
              got,
              correct: got === c.expect,
              argsValid: got === null ? true : args !== null,
              requiredPresent:
                got === null ? true : required.every((k) => args != null && k in args),
              known: got === null || TOOLS.some((t2) => t2.name === got),
              extraCalls: Math.max(0, calls.length - 1),
              ms: t(),
              error: '',
            });
          } catch (e) {
            attempts.push({
              prompt: c.prompt,
              expected: c.expect,
              got: null,
              correct: false,
              argsValid: false,
              requiredPresent: false,
              known: true,
              extraCalls: 0,
              ms: t(),
              error: errText(e),
            });
          }
        }
      }

      const total = attempts.length;
      const correct = attempts.filter((a) => a.correct).length;
      const argsOk = attempts.filter((a) => a.argsValid).length;
      const requiredOk = attempts.filter((a) => a.requiredPresent).length;
      const hallucinated = attempts.filter((a) => !a.known).length;
      const errored = attempts.filter((a) => a.error).length;
      const multi = attempts.filter((a) => a.extraCalls > 0).length;

      const chatOnly = attempts.filter((a) => a.expected === null);
      const chatOnlyCorrect = chatOnly.filter((a) => a.correct).length;
      const actions = attempts.filter((a) => a.expected !== null);
      const actionsCorrect = actions.filter((a) => a.correct).length;

      const accuracy = correct / Math.max(total, 1);
      const needsClassifier = accuracy < 0.9 || chatOnlyCorrect < chatOnly.length;

      // Per case, so the weak prompts are visible rather than averaged away.
      const byCase = CASES.map((c) => {
        const mine = attempts.filter((a) => a.prompt === c.prompt);
        const ok = mine.filter((a) => a.correct).length;
        const picked = [...new Set(mine.map((a) => a.got ?? '(no tool)'))].join(', ');
        return [c.prompt, c.expect ?? '(no tool)', `${ok}/${mine.length}`, picked, c.why];
      });

      const answer =
        `**${pct(correct, total)} of ${total} attempts picked the right tool** ` +
        `(${reps} runs x ${CASES.length} prompts). Action prompts: ${pct(actionsCorrect, actions.length)}. ` +
        `Chat-only prompts correctly left alone: ${chatOnlyCorrect}/${chatOnly.length}. ` +
        `Arguments parsed as JSON on ${pct(argsOk, total)} of attempts and carried every required ` +
        `field on ${pct(requiredOk, total)}. ${hallucinated} calls named a tool that does not exist.\n\n` +
        (needsClassifier
          ? `**A pre-classifier is worth its cost.** Accuracy is under 90% or the model reached for ` +
            `a tool during small talk, and every wrong call either mutates the pantry or burns a turn. ` +
            `Route with the 8B model first (about 10 neurons, section 8) and hand only action turns ` +
            `to the 70B model with tools attached.`
          : `**No pre-classifier needed.** The model chose correctly often enough, including leaving ` +
            `chat-only turns alone, that an extra routing call would cost neurons without buying ` +
            `accuracy. Keep the twelve tools in one turn and spend the budget on the plan instead.`);

      const body = `## Per prompt

${table(['Prompt', 'Expected', 'Correct', 'Actually picked', 'Why this case'], byCase)}

## Totals

${table(
  ['Measurement', 'Value'],
  [
    ['Model', CHAT_MODEL],
    ['Tools offered', String(TOOLS.length)],
    ['Attempts', `${total} (${CASES.length} prompts x ${reps} runs)`],
    ['Right tool chosen', `${correct} — ${pct(correct, total)}`],
    ['Right tool, action prompts only', `${actionsCorrect}/${actions.length} — ${pct(actionsCorrect, actions.length)}`],
    ['Correctly stayed silent on small talk', `${chatOnlyCorrect}/${chatOnly.length}`],
    ['Arguments parsed as JSON', `${argsOk} — ${pct(argsOk, total)}`],
    ['All required arguments present', `${requiredOk} — ${pct(requiredOk, total)}`],
    ['Invented a tool name', String(hallucinated)],
    ['More than one tool call in a turn', String(multi)],
    ['Calls that errored outright', String(errored)],
    ['Latency mean', `${mean(attempts.map((a) => a.ms)).toFixed(0)} ms`],
    ['Latency min / max', `${Math.min(...attempts.map((a) => a.ms))} / ${Math.max(...attempts.map((a) => a.ms))} ms`],
  ],
)}

## What this changes

- **Tool count:** ${hallucinated > 0 ? 'the model invented tool names, so trim the twelve tools in section 5 and keep descriptions disjoint.' : 'no invented tool names, so the twelve tools in section 5 can stay as designed.'}
- **Approval flow:** \`update_profile\` and \`log_cooked\` already require approval in section 5.
  That is load-bearing, not polish — it is the backstop for the ${total - correct} wrong choices above.
- **Pre-classifier:** ${needsClassifier ? 'add one, on the 8B model, before the 70B turn.' : 'not needed; revisit if accuracy drops with the full twelve tools.'}
- **Eval:** freeze these ${CASES.length} prompts as the tool-choice eval named in section 13.

## Caveat, stated plainly

This calls the Workers AI binding with the \`tools\` parameter directly. That is the same
\`/v1/chat/completions\` tool protocol \`AIChatAgent\` drives underneath, so the numbers above are the
model's reliability. What it does **not** cover is the Durable Object and streaming layer on top —
resumable streams, tool approval round-trips and message persistence. Those are an integration
test in week 2, not a model question.
`;

      return result({ ...meta, answer, body });
    } catch (e) {
      return failed({ ...meta, error: e });
    }
  },
};
