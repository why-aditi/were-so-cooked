import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import { APPROVAL_TOOLS, buildTools } from '../src/agent/tools.js';
import { calls, mockModel, recordingModel, says, systemTextOf } from './fixtures/model.js';

/**
 * A chat turn through `AIChatAgent`, with Workers AI mocked at the provider
 * seam.
 *
 * Everything below the mock is real: the SDK's turn loop, its message
 * persistence, its tool dispatch, its approval pause, the real Durable
 * Object SQLite, the real seeded taxonomy and the real `BudgetKeeper`
 * ledger. Scripting the provider rather than stubbing `streamText` is what
 * makes these worth having — they prove the SDK calls our tools, not merely
 * that our tools work when called.
 *
 * `runInDurableObject` rather than RPC because a `LanguageModel` is not
 * serializable, so the mock has to be installed inside the object.
 */

const RECIPE_ID = 'chat-palak-paneer';

let n = 0;
const nextUser = (): string => `chat-user-${(n += 1)}-${crypto.randomUUID()}`;

/** Runs `body` inside a fresh agent with a scripted model installed. */
async function withAgent<T>(
  model: unknown,
  body: (agent: KitchenAgent) => Promise<T>,
  userId = nextUser(),
): Promise<T> {
  const stub = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(userId));
  return runInDurableObject(stub, async (agent: KitchenAgent) => {
    agent.identify(userId, false);
    agent.useModel(model as never);
    return body(agent);
  });
}

const toolNames = (tools: unknown): string[] =>
  Array.isArray(tools) ? tools.map((t) => String((t as { name?: string }).name)) : [];

const userMessage = (text: string) => [
  { id: crypto.randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text }] },
];

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));
  const subs = env.TEST_SUBSTITUTIONS_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(subs.map((s) => env.DB.prepare(s)));

  await env.DB.prepare(
    `INSERT OR REPLACE INTO recipes
       (id, source, title, cuisine, ingredients, steps, minutes, servings,
        diet_tags, allergen_tags, content_hash, created_at)
     VALUES (?, 'seed', 'Palak paneer', 'indian', ?, '[]', 30, 2, '[]', '[]', ?,
             '2026-09-01T00:00:00.000Z')`,
  )
    .bind(
      RECIPE_ID,
      JSON.stringify([
        { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', note: null },
      ]),
      RECIPE_ID,
    )
    .run();
});

/* --------------------------------- a turn --------------------------------- */

describe('a chat turn', () => {
  it('persists the question and the answer', async () => {
    const messages = await withAgent(mockModel(says('hey 👋')), async (agent) => {
      await agent.saveMessages(userMessage('hello'));
      return agent.messages;
    });

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(messages[1]?.parts)).toContain('hey 👋');
  });

  it('keeps the transcript across turns', async () => {
    const messages = await withAgent(mockModel(says('one'), says('two')), async (agent) => {
      await agent.saveMessages(userMessage('first'));
      await agent.saveMessages([...agent.messages, ...userMessage('second')]);
      return agent.messages;
    });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('commits the real token counts to the ledger', async () => {
    // Section 5 step 6, against the real BudgetKeeper.
    const { start, end } = await withAgent(mockModel(says('hi')), async (agent) => {
      const before = (await agent.snapshot()).neuronsLeftToday;
      await agent.saveMessages(userMessage('hello'));
      return { start: before, end: (await agent.snapshot()).neuronsLeftToday };
    });
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(start);
  });
});

/* ----------------------------- context window ------------------------------ */

describe('the context window', () => {
  it('sends the system prompt, the profile and the pantry', async () => {
    let seen: unknown;
    const model = recordingModel((c) => {
      seen = c.prompt;
    }, says('ok'));

    await withAgent(model, async (agent) => {
      await agent.addPantryItems('500g paneer, 1 bunch palak');
      await agent.saveMessages(userMessage('what can i make'));
    });

    const system = systemTextOf(seen);
    expect(system).toContain('HARD RULES');
    expect(system).toContain('--- profile ---');
    expect(system).toContain('--- pantry ---');
    expect(system).toContain('paneer');
  });

  it('survives an embedding call that cannot run', async () => {
    // Workers AI is unbound in tests, so the taste slot degrades to empty.
    // The turn must still happen — a missing slot is worse, not fatal.
    let seen: unknown;
    const model = recordingModel((c) => {
      seen = c.prompt;
    }, says('ok'));

    await withAgent(model, async (agent) => {
      await agent.rememberTaste({ text: 'hates okra', kind: 'dislike', subject: 'okra' });
      await agent.saveMessages(userMessage('what should i cook'));
    });

    expect(systemTextOf(seen)).toContain('HARD RULES');
  });

  it('keeps the assembled prompt inside the section 5 budget', async () => {
    let seen: unknown;
    const model = recordingModel((c) => {
      seen = c.prompt;
    }, says('ok'));

    await withAgent(model, async (agent) => {
      // A pantry nobody should have. Without the caps this is where the
      // conversation would silently start falling out of context.
      for (let i = 0; i < 12; i += 1) {
        await agent.addPantryItems('1kg paneer, 2 bunches palak, 6 eggs, 1kg basmati chawal');
      }
      await agent.saveMessages(userMessage('what can i make'));
    });

    // 6K tokens at the four-chars-per-token heuristic the builder uses.
    expect(systemTextOf(seen).length).toBeLessThan(6_000 * 4);
  });

  it('offers the model every registered tool', async () => {
    let tools: unknown;
    const model = recordingModel((c) => {
      tools = c.tools;
    }, says('ok'));

    await withAgent(model, async (agent) => {
      await agent.saveMessages(userMessage('hi'));
    });

    const names = (tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      'add_pantry_items',
      'check_grocery_item',
      'get_grocery_list',
      'get_plan',
      'list_pantry',
      'log_cooked',
      'remember_taste',
      'remove_pantry_items',
      'restore_pantry_items',
      'search_trending',
      'start_weekly_plan',
      'substitute',
      'suggest_recipes',
      'update_pantry_item',
      'update_profile',
    ]);
  });
});

/* ------------------------------ tool dispatch ------------------------------ */

describe('a tool the model calls', () => {
  it('really changes the pantry', async () => {
    const pantry = await withAgent(
      mockModel(calls('add_pantry_items', { text: '1kg paneer and 6 eggs' }), says('stocked 🧀')),
      async (agent) => {
        await agent.saveMessages(userMessage('bought 1kg paneer and 6 eggs'));
        return agent.listPantry();
      },
    );
    expect(pantry.map((i) => i.canonicalId).sort()).toEqual(['egg', 'paneer']);
  });

  it('feeds the result back so the model can talk about it', async () => {
    const prompts: unknown[] = [];
    const model = recordingModel(
      (c) => prompts.push(c.prompt),
      calls('list_pantry', {}),
      says('two things'),
    );

    await withAgent(model, async (agent) => {
      await agent.addPantryItems('500g paneer, 2kg basmati chawal');
      await agent.saveMessages(userMessage('what do i have'));
    });

    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain('paneer');
  });

  it('records the tool call on the persisted message', async () => {
    const messages = await withAgent(
      mockModel(calls('add_pantry_items', { text: '1kg paneer' }), says('done')),
      async (agent) => {
        await agent.saveMessages(userMessage('bought paneer'));
        return agent.messages;
      },
    );
    // The card the UI re-renders on reload comes from this part.
    expect(JSON.stringify(messages)).toContain('add_pantry_items');
  });

  it('shows the model the safety-checked dish, never the original', async () => {
    const prompts: unknown[] = [];
    const model = recordingModel(
      (c) => prompts.push(c.prompt),
      calls('suggest_recipes', { query: 'palak', count: 1 }),
      says('palak paneer 🔥'),
    );

    await withAgent(model, async (agent) => {
      await agent.setProfile({
        diets: ['vegan'],
        allergens: [],
        exclusions: [],
        cuisines: [],
        maxCookMinutes: 60,
        servings: 2,
        spiceLevel: 'medium',
        timeZone: 'UTC',
      });
      await agent.saveMessages(userMessage('what can i make'));
    });

    // The vegan swap already happened inside the tool, so the model is handed
    // the rewritten dish. Section 5 step 4, end to end.
    const toolResult = JSON.stringify(prompts[1]);
    expect(toolResult).toContain('Palak paneer');
    expect(toolResult).toContain('swaps');
  });
});

/* ------------------------------ always answers ----------------------------- */

describe('a turn always ends in words', () => {
  it('lets a failed call be retried once, then makes the model answer', async () => {
    // Production: Llama's doubled arguments made every add_pantry_items call
    // invalid, and the model retried the identical call until the step limit
    // — the whole demo budget, and no reply at all. One corrected retry is
    // worth allowing; a second failure is not.
    const choices: unknown[] = [];
    const toolCounts: number[] = [];
    const messages = await withAgent(
      recordingModel(
        (c) => {
          choices.push(c.toolChoice);
          toolCounts.push(Array.isArray(c.tools) ? c.tools.length : 0);
        },
        calls('add_pantry_items', { wrong: 'shape' }, 'call-1'),
        calls('add_pantry_items', { wrong: 'shape' }, 'call-2'),
        says('that did not work, sorry'),
      ),
      async (agent) => {
        await agent.saveMessages(userMessage('bought paneer'));
        return agent.messages;
      },
    );

    expect(choices).toHaveLength(3);
    // After the first failure the tools are still there, for a fix…
    expect(toolCounts[1]).toBeGreaterThan(0);
    // …after the second they are gone, not merely discouraged, so even a
    // model that ignores tool_choice cannot call one.
    expect(choices[2]).toEqual({ type: 'none' });
    expect(toolCounts[2]).toBe(0);
    expect(JSON.stringify(messages.at(-1))).toContain('that did not work, sorry');
  });

  it('answers a pantry update instead of going on to suggest recipes', async () => {
    // Production: "bought 1kg paneer, 6 eggs" had Llama chain suggest_recipes
    // after the pantry write, unasked, and the reply took three minutes.
    const offered: string[][] = [];
    await withAgent(
      recordingModel(
        (c) => offered.push(toolNames(c.tools)),
        calls('add_pantry_items', { text: '1kg paneer, 6 eggs' }),
        says('stocked 🧀'),
      ),
      async (agent) => {
        await agent.saveMessages(userMessage('bought 1kg paneer, 6 eggs'));
      },
    );
    expect(offered).toHaveLength(2);
    expect(offered[0]).toContain('suggest_recipes');
    expect(offered[1]).not.toContain('suggest_recipes');
    expect(offered[1]).not.toContain('start_weekly_plan');
    // Only the food tools go: a pantry edit that missed can still look the
    // item up and retry, and a second pantry change still goes through.
    expect(offered[1]).toContain('list_pantry');
    expect(offered[1]).toContain('remove_pantry_items');
  });

  it('reminds the replying step how to talk, and hides item ids from the model', async () => {
    // Production: "The function `add_pantry_items` has added two items… The
    // ids for these items are "0904…" and "230e…" respectively."
    const prompts: unknown[] = [];
    await withAgent(
      recordingModel(
        (c) => prompts.push(c.prompt),
        calls('add_pantry_items', { text: '1kg paneer, 6 eggs' }),
        says('stocked 🧀'),
      ),
      async (agent) => {
        await agent.saveMessages(userMessage('bought 1kg paneer, 6 eggs'));
      },
    );
    expect(systemTextOf(prompts[0])).not.toContain('NOW REPLY');
    expect(systemTextOf(prompts[1])).toContain('NOW REPLY');

    const toolResult = JSON.stringify(
      (prompts[1] as { role: string }[]).filter((m) => m.role === 'tool'),
    );
    expect(toolResult).toContain('paneer');
    expect(toolResult).not.toMatch(/"id"/);
  });

  it('still suggests after a pantry update when the message asked for food', async () => {
    const offered: string[][] = [];
    await withAgent(
      recordingModel(
        (c) => offered.push(toolNames(c.tools)),
        calls('add_pantry_items', { text: '1kg paneer' }),
        says('stocked, now ideas'),
      ),
      async (agent) => {
        await agent.saveMessages(userMessage('bought 1kg paneer, what can i make tonight?'));
      },
    );
    expect(offered[1]).toContain('suggest_recipes');
  });

  it('accepts numbers sent as strings, the way Llama sends them', async () => {
    // Production: suggest_recipes {"query": "", "count": "4"} failed the
    // schema and the reply became the call written out as JSON.
    const messages = await withAgent(
      mockModel(calls('suggest_recipes', { query: '', count: '4' }), says('here is what fits')),
      async (agent) => {
        await agent.saveMessages(userMessage('what can I make tonight?'));
        return agent.messages;
      },
    );
    const turn = JSON.stringify(messages.at(-1));
    expect(turn).toContain('"state":"output-available"');
    expect(turn).not.toContain('output-error');
  });

  it('takes the tools away on the last allowed step', async () => {
    const choices: unknown[] = [];
    const toolCounts: number[] = [];
    await withAgent(
      // A model that would call a tool forever.
      recordingModel(
        (c) => {
          choices.push(c.toolChoice);
          toolCounts.push(Array.isArray(c.tools) ? c.tools.length : 0);
        },
        calls('list_pantry', {}),
      ),
      async (agent) => {
        await agent.saveMessages(userMessage('what do I have'));
      },
    );

    expect(choices.length).toBeGreaterThan(1);
    expect(choices.at(-1)).toEqual({ type: 'none' });
    expect(toolCounts.at(-1)).toBe(0);
    expect(choices.slice(0, -1).every((c) => !c || (c as { type: string }).type !== 'none')).toBe(true);
  });
});

/* -------------------------------- approval --------------------------------- */

describe('human-in-the-loop approval', () => {
  it('gates exactly the two section 5 tools', () => {
    expect([...APPROVAL_TOOLS].sort()).toEqual(['log_cooked', 'update_profile']);
  });

  it('marks those two, and only those two, on the definitions the SDK reads', () => {
    const tools = buildTools({} as never);
    const gated = Object.entries(tools)
      .filter(([, t]) => (t as { needsApproval?: boolean }).needsApproval)
      .map(([name]) => name)
      .sort();
    expect(gated).toEqual(['log_cooked', 'update_profile']);
  });

  it('does not run log_cooked before the user approves', async () => {
    const result = await withAgent(
      mockModel(calls('log_cooked', { recipe_title: 'Palak paneer' }), says('ok?')),
      async (agent) => {
        await agent.addPantryItems('1kg paneer');
        await agent.saveMessages(userMessage('made palak paneer'));
        return { items: await agent.listPantry(), history: await agent.cookingHistory() };
      },
    );

    // The SDK paused the call. Nothing moved.
    expect(result.items[0]?.quantity).toBe(1);
    expect(result.history).toHaveLength(0);
  });

  it('persists the paused call so a reconnecting tab can still answer it', async () => {
    const messages = await withAgent(
      mockModel(calls('log_cooked', { recipe_title: 'Palak paneer' }), says('ok?')),
      async (agent) => {
        await agent.addPantryItems('1kg paneer');
        await agent.saveMessages(userMessage('made palak paneer'));
        return agent.messages;
      },
    );
    expect(JSON.stringify(messages)).toContain('approval');
  });

  it('shows the deduction on the card, computed at render time', async () => {
    const summary = await withAgent(mockModel(says('ok')), async (agent) => {
      await agent.addPantryItems('1kg paneer');
      return agent.previewApproval('log_cooked', { recipe_title: 'Palak paneer' });
    });
    expect(summary.join(' ')).toContain('paneer');
  });

  it('says plainly when a profile change would drop an allergen', async () => {
    const summary = await withAgent(mockModel(says('ok')), async (agent) => {
      await agent.setProfile({
        diets: [],
        allergens: ['peanuts'],
        exclusions: [],
        cuisines: [],
        maxCookMinutes: 45,
        servings: 2,
        spiceLevel: 'medium',
        timeZone: 'UTC',
      });
      return agent.previewApproval('update_profile', { allergens: [] });
    });
    expect(summary.join(' ')).toContain('removes peanuts from your allergy list');
  });

  it('refuses to preview arguments that do not validate', async () => {
    const summary = await withAgent(mockModel(says('ok')), (agent) =>
      agent.previewApproval('log_cooked', { recipe_title: '' }),
    );
    expect(summary.join(' ')).toContain('Could not read');
  });
});

/* ------------------------------- synced state ------------------------------ */

describe('the synced state', () => {
  it('is pushed after a turn', async () => {
    const state = await withAgent(
      mockModel(calls('add_pantry_items', { text: '1kg paneer' }), says('done')),
      async (agent) => {
        await agent.saveMessages(userMessage('bought paneer'));
        return agent.state;
      },
    );
    expect(state).toMatchObject({ pantryCount: 1 });
  });

  it('carries the section 5 badge counts', async () => {
    const state = await withAgent(mockModel(says('ok')), async (agent) => {
      // paneer is 3 days in the seed, outside the 2-day nudge window.
      await agent.addPantryItems('500g paneer');
      await agent.saveMessages(userMessage('hi'));
      return agent.state;
    });
    expect(state).toMatchObject({ expiringSoonCount: 0, unreadInbox: 0 });
  });
});
