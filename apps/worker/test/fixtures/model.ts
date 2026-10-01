import { MockLanguageModelV4 } from 'ai/test';

/**
 * Mocked Workers AI, as scripted streams.
 *
 * A turn now runs through the AI SDK's `streamText`, so the seam is a
 * `LanguageModel` rather than an `env.AI.run` wrapper. `MockLanguageModelV4`
 * is the SDK's own test double: it takes the provider stream parts and the
 * rest of the pipeline — tool dispatch, approval pausing, message
 * persistence, usage accounting — runs exactly as it does in production.
 *
 * Scripting at the provider level rather than stubbing `streamText` is the
 * point. A stub would prove the tools work; this proves the SDK calls them.
 */

type StreamPart = Record<string, unknown>;

/**
 * The v4 provider spec nests token counts, so a flat `inputTokens: 2400`
 * silently reads back as undefined and every usage assertion passes against
 * zero. Spike 4's measured turn was 2,392 in / 40 out; these are that,
 * rounded.
 */
const usage = (inTokens: number, outTokens: number) => ({
  inputTokens: { total: inTokens, noCache: inTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outTokens },
  totalTokens: inTokens + outTokens,
});

/**
 * `finishReason` is an object in the v4 spec, not a string. A bare
 * `'tool-calls'` is silently coerced to `other`, and `other` stops the tool
 * loop — so `execute` never runs and the whole turn looks like the model
 * simply declined to act. Worth stating, because nothing errors.
 */
const FINISH = { type: 'finish', finishReason: { unified: 'stop' }, usage: usage(2_400, 40) };

const TOOL_FINISH = {
  type: 'finish',
  finishReason: { unified: 'tool-calls' },
  usage: usage(2_400, 30),
};

function stream(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Plain prose, no tools. */
export function says(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    FINISH,
  ];
}

/** One tool call and nothing else, which is what a first step looks like. */
export function calls(toolName: string, input: unknown, id = 'call-1'): StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    TOOL_FINISH,
  ];
}

/**
 * A model that plays each script in turn.
 *
 * One entry per step: the SDK loops back after running a tool, so a tool turn
 * needs two — the call, then the answer about its result.
 */
export function mockModel(...scripts: StreamPart[][]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    provider: 'mock-workers-ai',
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    doStream: async () => {
      const parts = scripts[Math.min(step, scripts.length - 1)] ?? says('ok');
      step += 1;
      return { stream: stream(parts) as never };
    },
  });
}

/** Captures the prompt the SDK actually sent, for context-window assertions. */
export function recordingModel(
  onCall: (options: { prompt: unknown; tools: unknown; toolChoice: unknown }) => void,
  ...scripts: StreamPart[][]
): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    provider: 'mock-workers-ai',
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    doStream: async (options) => {
      onCall({ prompt: options.prompt, tools: options.tools, toolChoice: options.toolChoice });
      const parts = scripts[Math.min(step, scripts.length - 1)] ?? says('ok');
      step += 1;
      return { stream: stream(parts) as never };
    },
  });
}

/** The system block the agent assembled, as one string. */
export function systemTextOf(prompt: unknown): string {
  const messages = prompt as { role: string; content: unknown }[];
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}
