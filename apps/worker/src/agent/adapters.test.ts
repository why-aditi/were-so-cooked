import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';
import { GENERATE_MODEL, generateRecipes } from '../recipes/generate.js';
import { replyText, workersAiRunner } from './adapters.js';

/**
 * The runner behind recipe generation, swaps and the normaliser.
 *
 * Gemma 4 answers in the chat-completions envelope. The runner read only
 * Llama's `response`, so in production every generated recipe list arrived
 * as an empty string, failed its parse twice, and the turn answered with
 * nothing after two full model calls.
 */

const recipeJson = JSON.stringify({
  recipes: [
    {
      title: 'Paneer bhurji',
      cuisine: 'north indian',
      minutes: 20,
      servings: 2,
      ingredients: [{ name: 'paneer', quantity: 200, unit: 'g', note: null }],
      steps: ['Crumble the paneer.', 'Cook it with onion and spices.'],
    },
  ],
});

/** A binding that answers like Gemma 4 does and records what it was sent. */
function gemmaLike() {
  const run = vi.fn(async () => ({
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: GENERATE_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: recipeJson }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 300, completion_tokens: 120 },
  }));
  return { env: { AI: { run } } as unknown as Env, run };
}

describe('replyText', () => {
  it('reads the older envelope', () => {
    expect(replyText({ response: 'hi' })).toBe('hi');
  });

  it('reads the chat-completions envelope', () => {
    expect(replyText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it('is empty, not a crash, when there is neither', () => {
    expect(replyText({})).toBe('');
    expect(replyText({ choices: [{ message: { content: null } }] })).toBe('');
  });
});

describe('workersAiRunner', () => {
  it('turns a Gemma reply into recipes on the first attempt', async () => {
    const { env, run } = gemmaLike();
    const out = await generateRecipes(
      { query: '', pantry: ['paneer'], profileSummary: 'no restrictions', count: 3 },
      { model: workersAiRunner(env) },
    );
    expect(out.error).toBeUndefined();
    expect(out.attempts).toBe(1);
    expect(out.drafts.map((d) => d.title)).toEqual(['Paneer bhurji']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks Gemma for an answer without the reasoning preamble, with room for the list', async () => {
    const { env, run } = gemmaLike();
    await generateRecipes(
      { query: '', pantry: [], profileSummary: '', count: 3 },
      { model: workersAiRunner(env) },
    );
    const input = (run.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input.chat_template_kwargs).toEqual({ enable_thinking: false });
    // The Workers AI default of 256 cannot hold three recipes.
    expect(input.max_tokens).toBeGreaterThanOrEqual(1200);
  });

  it('does not send Gemma-only options to Llama', async () => {
    const run = vi.fn(async () => ({ response: 'ok' }));
    const runner = workersAiRunner({ AI: { run } } as unknown as Env);
    await runner({ model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', messages: [{ role: 'user', content: 'x' }] });
    const input = (run.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input.chat_template_kwargs).toBeUndefined();
    expect(input.max_tokens).toBe(2048);
  });

  it('reads tool calls from either envelope', async () => {
    const run = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"dal"}' } }],
          },
        },
      ],
    }));
    const runner = workersAiRunner({ AI: { run } } as unknown as Env);
    const out = await runner({ model: GENERATE_MODEL, messages: [] });
    expect(out.toolCalls).toEqual([{ name: 'lookup', arguments: { q: 'dal' } }]);
  });
});
