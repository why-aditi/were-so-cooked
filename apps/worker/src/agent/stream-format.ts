/**
 * One wire format per Workers AI stream.
 *
 * Workers AI streams chat completions as SSE events that can carry the same
 * content twice: in its native shape (`response`, `tool_calls`) and in the
 * OpenAI-compatible shape (`choices[0].delta.content`, `.tool_calls`).
 * `workers-ai-provider` 4.0.0 — the latest release — reads both and appends
 * both. For Llama 3.3 that doubled every tool-call argument fragment, so the
 * first live `add_pantry_items` call arrived as
 *
 *   {"text": "{"text": "11kgkg pane paneerer,,6 6 eggs eggs,, ..."}ya"}
 *
 * — unparseable, so the tool errored, and the model retried the identical call
 * until the step limit, spending a demo account's whole day on one turn. Gemma
 * sends only the OpenAI shape, which is why its turns were fine.
 *
 * The fix sits between the binding and the provider: the first format that
 * carries tool calls in a stream is the only one whose tool calls go through,
 * and the same for text. It handles both formats arriving in one event and in
 * separate events, and leaves a single-format stream byte-for-byte unchanged in
 * meaning.
 *
 * ponytail: delete this wrapper once workers-ai-provider reads one format per
 * stream. `stream-format.test.ts` drives the real provider, so it will say so.
 */

type Format = 'native' | 'openai';

interface Chunk {
  response?: unknown;
  tool_calls?: unknown;
  choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[];
}

const hasItems = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
const hasText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

/** Keeps one format's tool calls and one format's text for the whole stream. */
export function singleFormatSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let toolFormat: Format | null = null;
  let textFormat: Format | null = null;

  const rewrite = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;

    let chunk: Chunk;
    try {
      chunk = JSON.parse(payload) as Chunk;
    } catch {
      return line;
    }
    const delta = chunk.choices?.[0]?.delta;
    let changed = false;

    toolFormat ??= hasItems(chunk.tool_calls) ? 'native' : hasItems(delta?.tool_calls) ? 'openai' : null;
    if (toolFormat === 'native' && delta && 'tool_calls' in delta) {
      delete delta.tool_calls;
      changed = true;
    } else if (toolFormat === 'openai' && 'tool_calls' in chunk) {
      delete chunk.tool_calls;
      changed = true;
    }

    textFormat ??= hasText(chunk.response) ? 'native' : hasText(delta?.content) ? 'openai' : null;
    if (textFormat === 'native' && delta && hasText(delta.content)) {
      delete delta.content;
      changed = true;
    } else if (textFormat === 'openai' && hasText(chunk.response)) {
      delete chunk.response;
      changed = true;
    }

    return changed ? `data: ${JSON.stringify(chunk)}` : line;
  };

  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      // Only whole lines are rewritten; a partial one waits for its ending.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(rewrite).join('\n') + '\n'));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}

/**
 * The `Ai` binding with every streamed response normalised. Everything else —
 * non-streaming calls, embeddings, the gateway option — passes straight through.
 */
export function singleFormatAi(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== 'run') {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const out = await (target.run as (...a: unknown[]) => Promise<unknown>)(...args);
        return out instanceof ReadableStream ? out.pipeThrough(singleFormatSse()) : out;
      };
    },
  });
}
