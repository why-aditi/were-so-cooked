import type { BudgetStatus, Pool } from '../budget/policy.js';
import type { TokenUsage } from '../budget/rates.js';
import type { Env } from '../env.js';
import type { VisionRunner } from '../photo/extract.js';


/**
 * The two real edges of a turn: Workers AI and the `BudgetKeeper`.
 *
 * Here rather than in `kitchen-agent.ts` so the mapping from Cloudflare's
 * response shape to ours reads in one place instead of inline in a Durable
 * Object method, and so a test can swap either edge.
 */

/* ------------------------------ the two shapes ----------------------------- */

/**
 * A raw Workers AI call.
 *
 * Distinct from the AI SDK's `LanguageModel`, deliberately. The chat turn
 * goes through `streamText` and wants a `LanguageModel`; the recipe
 * generator, the swap proposer and the normalizer make single non-streaming
 * JSON calls where the SDK would add a provider abstraction over a one-line
 * `env.AI.run`. Keeping both means each caller uses the lighter one that
 * fits, and both are injectable for tests.
 */
export interface ModelRequest {
  model: string;
  messages: { role: string; content: string }[];
  tools?: { name: string; description: string; parameters: unknown }[];
}

export interface ModelResponse {
  text: string;
  toolCalls: { name: string; arguments: unknown }[];
  usage: TokenUsage;
}

export type ModelRunner = (req: ModelRequest) => Promise<ModelResponse>;

export interface BudgetGate {
  reserve(estimate: number): Promise<
    { ok: true; reservationId: string } | { ok: false; reason: string; message: string }
  >;
  commit(reservationId: string, call: { model: string; usage: TokenUsage }): Promise<unknown>;
  release(reservationId: string): Promise<unknown>;
  /** Fraction of the user's daily cap still available, 0..1. */
  fractionLeft(): Promise<number>;
}

/* --------------------------------- gateway --------------------------------- */

/**
 * Section 12: every Workers AI call goes through the AI Gateway.
 *
 * A byte-identical request is served from the cache and never reaches the
 * model, so it costs no neurons — spike 6 measured a repeat at 177ms against
 * 2,488ms cold. That is what makes section 12's demo optimisation work: the
 * suggestion chips send identical context, so the second reviewer to click
 * one is free.
 *
 * One varying token defeats it, including a timestamp. Nothing in the call
 * paths here injects one, and nothing should start.
 *
 * Absent id means no gateway, which happens before `pnpm bootstrap` has run.
 * Calls then go direct and pay full price rather than failing — a missing
 * cache should not take the product down.
 */
function gatewayOptions(env: Env): { gateway: { id: string } } | undefined {
  return env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
}

/* -------------------------------- Workers AI ------------------------------- */

/** What `env.AI.run` actually returns for a chat model. */
interface AiTextResult {
  response?: string;
  tool_calls?: {
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Workers AI reports a tool call in two shapes depending on the model — a flat
 * `{name, arguments}` and an OpenAI-style `{function: {name, arguments}}` —
 * and `arguments` is sometimes a JSON string and sometimes already an object.
 * Spike 3 hit both. Normalising here keeps the loop from caring.
 */
function normaliseToolCalls(result: AiTextResult): { name: string; arguments: unknown }[] {
  const calls: { name: string; arguments: unknown }[] = [];
  for (const raw of result.tool_calls ?? []) {
    const name = raw.name ?? raw.function?.name;
    if (!name) continue;
    const args = raw.arguments ?? raw.function?.arguments;
    let parsed: unknown = args ?? {};
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // Leave the string in place: the loop's Zod check will reject it with
        // a message the model can act on, which beats dropping the call.
      }
    }
    calls.push({ name, arguments: parsed });
  }
  return calls;
}

export function workersAiRunner(env: Env): ModelRunner {
  return async (req: ModelRequest): Promise<ModelResponse> => {
    const input: Record<string, unknown> = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.tools) {
      input.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const result = (await env.AI.run(
      req.model as Parameters<Ai['run']>[0],
      input as never,
      gatewayOptions(env),
    )) as AiTextResult;

    return {
      text: result.response ?? '',
      toolCalls: normaliseToolCalls(result),
      usage: {
        promptTokens: result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completion_tokens ?? 0,
      },
    };
  };
}

/* ---------------------------------- vision --------------------------------- */

/**
 * The photo-extraction edge (section 6).
 *
 * Workers AI takes the image as a plain byte array rather than a data URL,
 * and returns the same `{response, usage}` envelope as a text model. Spike 2
 * measured 713 prompt tokens at 768x768 on this path.
 */
export function workersAiVision(env: Env): VisionRunner {
  return async (req) => {
    const result = (await env.AI.run(
      req.model as Parameters<Ai['run']>[0],
      { prompt: req.prompt, image: req.image, max_tokens: 1024 } as never,
      gatewayOptions(env),
    )) as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

    return {
      text: result.response ?? '',
      usage: {
        promptTokens: result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completion_tokens ?? 0,
      },
    };
  };
}

/* ------------------------------- BudgetKeeper ------------------------------ */

interface KeeperStub {
  reserve(req: { userId: string; estimate: number; isDemo?: boolean; pool?: Pool }): Promise<
    | { ok: true; reservationId: string; estimate: number }
    | { ok: false; reason: string; message: string; left: number }
  >;
  commit(
    id: string,
    call: { model: string; usage: TokenUsage; userId?: string; pool?: Pool },
  ): Promise<unknown>;
  release(id: string): Promise<unknown>;
  status(userId: string, isDemo: boolean): Promise<BudgetStatus>;
}

/** The single global ledger instance (section 12). */
export function budgetKeeper(env: Env): KeeperStub {
  return env.BUDGET_KEEPER.get(
    env.BUDGET_KEEPER.idFromName('global'),
  ) as unknown as KeeperStub;
}

export function budgetKeeperGate(env: Env, userId: string, isDemo: boolean): BudgetGate {
  const keeper = budgetKeeper(env);
  return {
    reserve: async (estimate) => {
      const r = await keeper.reserve({ userId, estimate, isDemo });
      return r.ok
        ? { ok: true, reservationId: r.reservationId }
        : { ok: false, reason: r.reason, message: r.message };
    },
    commit: (id, call) => keeper.commit(id, { ...call, userId }),
    release: (id) => keeper.release(id),
    fractionLeft: async () => {
      const s = await keeper.status(userId, isDemo);
      // Section 8's low-power switch is about the user's own allowance, but a
      // nearly-empty account is the stronger signal — take whichever is worse.
      const user = s.user.limit > 0 ? s.user.left / s.user.limit : 0;
      const account = s.account.limit > 0 ? s.account.left / s.account.limit : 0;
      return Math.min(user, account);
    },
  };
}
