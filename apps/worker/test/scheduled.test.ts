import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import { mockModel, says } from './fixtures/model.js';

/**
 * Section 5's scheduled work and taste memory, against real Durable Object
 * SQLite.
 *
 * The taste embeddings are the interesting half: Workers AI is unbound in
 * this suite, so every embedding call fails. That is deliberate — it is the
 * exact production failure mode (a model hiccup, or the budget gone), and
 * the memory must still be saved and still be usable as a hard-matched
 * dislike even when semantic search cannot see it.
 */

let n = 0;
async function withAgent<T>(body: (agent: KitchenAgent) => Promise<T>): Promise<T> {
  const userId = `sched-${(n += 1)}-${crypto.randomUUID()}`;
  const stub = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(userId));
  return runInDurableObject(stub, async (agent: KitchenAgent) => {
    agent.identify(userId, false);
    agent.useModel(mockModel(says('ok')) as never);
    return body(agent);
  });
}

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));
});

/* ------------------------------ taste memory ------------------------------ */

describe('remember_taste', () => {
  it('saves a memory and reads it back', async () => {
    const memories = await withAgent(async (agent) => {
      await agent.rememberTaste({ text: 'loves paneer', kind: 'like', subject: 'paneer' });
      return agent.listTaste();
    });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ text: 'loves paneer', kind: 'like', subject: 'paneer' });
  });

  it('resolves the subject through the taxonomy', async () => {
    // "dhaniya" is stored as `coriander_leaves`, so a dislike matches a
    // recipe that lists it in English.
    const memories = await withAgent(async (agent) => {
      await agent.rememberTaste({ text: 'not a fan of dhaniya', kind: 'dislike', subject: 'dhaniya' });
      return agent.listTaste();
    });
    expect(memories[0]?.subject).toBe('coriander_leaves');
  });

  it('keeps a subject the taxonomy has never heard of, rather than dropping it', async () => {
    const memories = await withAgent(async (agent) => {
      await agent.rememberTaste({ text: 'hates nani special', kind: 'dislike', subject: 'nani special' });
      return agent.listTaste();
    });
    expect(memories[0]?.subject).toBe('nani special');
  });

  it('saves the memory even when the embedding call fails', async () => {
    // Workers AI is unbound here, so this is the failure path. Losing the
    // note because an inference call hiccuped is the worse trade.
    const memories = await withAgent(async (agent) => {
      await agent.rememberTaste({ text: 'too spicy last time', kind: 'note' });
      return agent.listTaste();
    });
    expect(memories).toHaveLength(1);
  });

  it('accepts a memory with no subject', async () => {
    const memories = await withAgent(async (agent) => {
      await agent.rememberTaste({ text: 'prefers one-pot meals', kind: 'note' });
      return agent.listTaste();
    });
    expect(memories[0]?.subject).toBeNull();
  });

  it('evicts the oldest past the section 4 ceiling', async () => {
    // 300 is the cap. Writing 305 must leave 300, not 305.
    const count = await withAgent(async (agent) => {
      for (let i = 0; i < 305; i += 1) {
        await agent.rememberTaste({ text: `memory ${i}`, kind: 'note' });
      }
      return (await agent.listTaste()).length;
    });
    expect(count).toBe(300);
  });

  it('keeps the newest when it evicts', async () => {
    const memories = await withAgent(async (agent) => {
      for (let i = 0; i < 302; i += 1) {
        await agent.rememberTaste({ text: `memory ${i}`, kind: 'note' });
      }
      return agent.listTaste();
    });
    expect(memories[0]?.text).toBe('memory 301');
  });
});

/* -------------------------------- 09:00 job ------------------------------- */

describe('the daily expiry check', () => {
  it('nudges about items going off within two days', async () => {
    const result = await withAgent(async (agent) => {
      // palak is 3 days in the seed; a user-set date brings it inside the
      // 2-day window.
      const { added } = await agent.addPantryItems('1 bunch palak');
      await agent.updatePantryItem(added[0]?.id as string, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const run = await agent.runExpiryCheck();
      return { run, inbox: await agent.listInbox() };
    });

    expect(result.run.nudged).toBe(1);
    expect(result.inbox[0]?.kind).toBe('expiry');
    // Section 10's voice: the joke roasts the fridge, never the user.
    expect(result.inbox[0]?.body).toContain('last seen');
  });

  it('spends no neurons, because section 5 says template copy', async () => {
    // Workers AI is unbound in this suite, so a job that tried to call a
    // model would throw rather than return a count.
    const run = await withAgent(async (agent) => {
      const { added } = await agent.addPantryItems('1 bunch palak');
      await agent.updatePantryItem(added[0]?.id as string, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      return agent.runExpiryCheck();
    });
    expect(run.nudged).toBe(1);
  });

  it('says nothing about items that are fine', async () => {
    const result = await withAgent(async (agent) => {
      // Basmati rice is 730 days.
      await agent.addPantryItems('2kg basmati chawal');
      const run = await agent.runExpiryCheck();
      return { run, inbox: await agent.listInbox() };
    });
    expect(result.run.nudged).toBe(0);
    expect(result.inbox).toHaveLength(0);
  });

  it('does not nudge twice about the same item on the same day', async () => {
    // The dedupe key carries the date, so tomorrow can nudge again about the
    // same still-unused spinach — but today cannot.
    const result = await withAgent(async (agent) => {
      const { added } = await agent.addPantryItems('1 bunch palak');
      await agent.updatePantryItem(added[0]?.id as string, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const first = await agent.runExpiryCheck();
      const second = await agent.runExpiryCheck();
      return { first, second, inbox: await agent.listInbox() };
    });

    expect(result.first.nudged).toBe(1);
    expect(result.second.nudged).toBe(0);
    expect(result.inbox).toHaveLength(1);
  });

  it('shows up in the synced state as unread', async () => {
    const state = await withAgent(async (agent) => {
      const { added } = await agent.addPantryItems('1 bunch palak');
      await agent.updatePantryItem(added[0]?.id as string, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await agent.runExpiryCheck();
      return agent.snapshot();
    });
    expect(state.unreadInbox).toBe(1);
  });

  it('can be marked read, once', async () => {
    const result = await withAgent(async (agent) => {
      const { added } = await agent.addPantryItems('1 bunch palak');
      await agent.updatePantryItem(added[0]?.id as string, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await agent.runExpiryCheck();
      const id = (await agent.listInbox())[0]?.id as string;
      return {
        first: await agent.markInboxRead(id),
        second: await agent.markInboxRead(id),
        unread: (await agent.snapshot()).unreadInbox,
      };
    });
    expect(result.first.ok).toBe(true);
    expect(result.second.ok).toBe(false);
    expect(result.unread).toBe(0);
  });
});

/* -------------------------------- 17:00 job ------------------------------- */

describe('the tonight suggestion', () => {
  it('says nothing when the pantry is empty', async () => {
    const result = await withAgent(async (agent) => {
      const run = await agent.runTonightSuggestion();
      return { run, inbox: await agent.listInbox() };
    });
    expect(result.run.suggested).toBeNull();
    expect(result.inbox).toHaveLength(0);
  });

  it('degrades quietly when no dish can be found', async () => {
    // The catalog is empty in this suite and Workers AI is unbound, so
    // generation cannot rescue it. No nudge beats a broken one, and
    // tomorrow's run tries again.
    const result = await withAgent(async (agent) => {
      await agent.addPantryItems('500g paneer');
      const run = await agent.runTonightSuggestion();
      return { run, inbox: await agent.listInbox() };
    });
    expect(result.run.suggested).toBeNull();
    expect(result.inbox).toHaveLength(0);
  });

  it('writes an inbox line when the catalog has a match', async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO recipes
         (id, source, title, cuisine, ingredients, steps, minutes, servings,
          diet_tags, allergen_tags, content_hash, created_at)
       VALUES ('tonight-bhurji', 'seed', 'Paneer bhurji', 'indian', ?, '[]', 20, 2,
               '[]', '[]', 'tonight-bhurji', '2026-09-01T00:00:00.000Z')`,
    )
      .bind(
        JSON.stringify([
          { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', note: null },
        ]),
      )
      .run();

    const result = await withAgent(async (agent) => {
      await agent.addPantryItems('500g paneer');
      const run = await agent.runTonightSuggestion();
      return { run, inbox: await agent.listInbox() };
    });

    expect(result.run.suggested).toBe('Paneer bhurji');
    expect(result.inbox[0]?.kind).toBe('tonight');
    expect(result.inbox[0]?.title).toContain('Paneer bhurji');
  });

  it('does not repeat itself the same day', async () => {
    const result = await withAgent(async (agent) => {
      await agent.addPantryItems('500g paneer');
      await agent.runTonightSuggestion();
      await agent.runTonightSuggestion();
      return agent.listInbox();
    });
    expect(result.filter((i) => i.kind === 'tonight')).toHaveLength(1);
  });
});

/* ------------------------------- the alarms -------------------------------- */

describe('arming the jobs', () => {
  it('registers both daily jobs', async () => {
    const schedules = await withAgent(async (agent) => agent.listSchedules());
    const callbacks = (schedules as { callback: string }[]).map((s) => s.callback).sort();
    expect(callbacks).toEqual(['runExpiryCheck', 'runTonightSuggestion']);
  });

  it('does not accumulate a row per wake', async () => {
    // `schedule` with a Date is not idempotent by default, and `onStart`
    // runs on every wake — without the flag this grows without bound and the
    // 09:00 nudge fires once per restart.
    const count = await withAgent(async (agent) => {
      await agent.runExpiryCheck();
      await agent.runExpiryCheck();
      return (await agent.listSchedules()).length;
    });
    expect(count).toBe(2);
  });

  it('schedules them in the profile time zone', async () => {
    const times = await withAgent(async (agent) => {
      await agent.setProfile({
        diets: [],
        allergens: [],
        exclusions: [],
        cuisines: [],
        maxCookMinutes: 45,
        servings: 2,
        spiceLevel: 'medium',
        timeZone: 'Asia/Kolkata',
      });
      await agent.runExpiryCheck();
      return (await agent.listSchedules()) as { callback: string; time: number }[];
    });

    const expiry = times.find((s) => s.callback === 'runExpiryCheck');
    expect(expiry).toBeDefined();
    // 09:00 IST is 03:30 UTC. A whole-hours assumption fails here.
    const when = new Date((expiry as { time: number }).time * 1000);
    expect(when.getUTCMinutes()).toBe(30);
    expect(when.getUTCHours()).toBe(3);
  });
});
