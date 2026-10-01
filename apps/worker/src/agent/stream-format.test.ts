import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { createWorkersAI } from 'workers-ai-provider';
import { singleFormatAi, singleFormatSse } from './stream-format.js';

/**
 * The double-format bug, reproduced through the real `workers-ai-provider`
 * and the real AI SDK, with only the binding faked.
 *
 * The SSE below is shaped like what Llama 3.3 sent in production: every
 * fragment of the tool call's arguments carried once natively and once in the
 * OpenAI-compatible shape. The first test pins the bug, so the day the
 * provider fixes it upstream, this file says the wrapper can go.
 */

const ARGS = '{"text": "1kg paneer, 6 eggs"}';
const fragments = ['{"text": "1', 'kg paneer,', ' 6 eggs"}'];

const sse = (events: unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

/** Both formats in one event — what doubled every fragment. */
const dualFormatEvents = (): unknown[] => [
  {
    tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'add_pantry_items' } }],
    choices: [
      {
        delta: {
          tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'add_pantry_items' } }],
        },
      },
    ],
  },
  ...fragments.map((f) => ({
    tool_calls: [{ index: 0, function: { arguments: f } }],
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: f } }] } }],
  })),
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];

/** A binding whose `run` streams the given SSE, once per call. */
function fakeAi(body: string, wrap: boolean): Ai {
  const ai = {
    run: async () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          // Split mid-event, as the network would, to exercise line buffering.
          const bytes = new TextEncoder().encode(body);
          c.enqueue(bytes.slice(0, 37));
          c.enqueue(bytes.slice(37));
          c.close();
        },
      }),
  } as unknown as Ai;
  return wrap ? singleFormatAi(ai) : ai;
}

/** What the tool was called with, or the raw input the SDK rejected. */
async function toolInput(binding: Ai): Promise<unknown> {
  let received: unknown = 'never called';
  const result = streamText({
    model: createWorkersAI({ binding })('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as never),
    prompt: 'bought 1kg paneer, 6 eggs',
    tools: {
      add_pantry_items: tool({
        inputSchema: jsonSchema<{ text: string }>({
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        }),
        execute: async (input) => {
          received = input;
          return { ok: true };
        },
      }),
    },
    stopWhen: stepCountIs(1),
  });
  for await (const part of result.fullStream) {
    if (part.type === 'tool-error') received = { rejected: part.input };
  }
  return received;
}

describe('a stream carrying both formats', () => {
  it('reproduces the doubled arguments without the wrapper', async () => {
    // If this starts failing, the provider no longer doubles: delete
    // stream-format.ts and its use in kitchen-agent.ts.
    // Each fragment appended twice — the exact shape of the production log.
    expect(await toolInput(fakeAi(sse(dualFormatEvents()), false))).toEqual({
      rejected: '{"text": "1{"text": "1kg paneer,kg paneer, 6 eggs"} 6 eggs"}',
    });
  });

  it('delivers the arguments once with it', async () => {
    expect(await toolInput(fakeAi(sse(dualFormatEvents()), true))).toEqual(JSON.parse(ARGS));
  });

  it('also handles the two formats arriving in separate events', async () => {
    const split = dualFormatEvents().flatMap((e) => {
      const { tool_calls, choices } = e as { tool_calls?: unknown; choices?: unknown };
      return tool_calls ? [{ tool_calls }, { choices }] : [e];
    });
    expect(await toolInput(fakeAi(sse(split), true))).toEqual(JSON.parse(ARGS));
  });
});

describe('a single-format stream', () => {
  it('passes OpenAI-shaped tool calls through untouched', async () => {
    const events = dualFormatEvents().map((e) => {
      const { choices } = e as { choices?: unknown; usage?: unknown };
      return { ...(e as object), tool_calls: undefined, choices };
    });
    expect(await toolInput(fakeAi(sse(events), true))).toEqual(JSON.parse(ARGS));
  });

  it('leaves text that appears in only one format alone', async () => {
    const out: string[] = [];
    const reader = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse([{ response: 'hello ' }, { response: 'there' }])));
        c.close();
      },
    })
      .pipeThrough(singleFormatSse())
      .pipeThrough(new TextDecoderStream())
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out.join('')).toContain('"response":"hello "');
    expect(out.join('')).toContain('"response":"there"');
  });

  it('keeps one copy of text that arrives in both formats', async () => {
    const both = sse([
      { response: 'hi', choices: [{ delta: { content: 'hi' } }] },
      { response: ' you', choices: [{ delta: { content: ' you' } }] },
    ]);
    const text = await new Response(
      new Response(both).body!.pipeThrough(singleFormatSse()),
    ).text();
    expect(text.match(/hi/g)).toHaveLength(1);
    expect(text).not.toContain('"content"');
  });
});
