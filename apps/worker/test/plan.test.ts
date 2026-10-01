import {
  type WorkflowIntrospector,
  env,
  introspectWorkflow,
  runInDurableObject,
} from 'cloudflare:test';
import type { MealSlot } from '@cooked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import { buildTools } from '../src/agent/tools.js';
import { PLAN_STEPS } from '../src/plan/record.js';

/**
 * `WeeklyPlanWorkflow` end to end: a real Workflow, the real agent SQLite,
 * the real D1 catalog, taxonomy and swap table.
 *
 * The test pool has no Workers AI binding, so these runs are catalog-only —
 * which is also exactly what production does when the budget refuses the
 * reservation. The generate and repair loop itself is covered with a faked
 * model in `src/plan/plan.test.ts`; what this file proves is the durable
 * shell: the row lifecycle, the safety gate on the way in, the grocery list,
 * the inbox, and the failure path.
 */

/**
 * Today, so pantry expiry estimates (computed from the real clock when an
 * item is added) fall inside the week rather than before it — stock that is
 * dead before the week starts rightly does not count against the list.
 */
const WEEK_START = new Date().toISOString().slice(0, 10);

/**
 * Every title says "dinner" because slot fit is, for now, a text match on
 * title and cuisine — see `SLOT_QUERY` in `src/plan/plan.ts`. Seven safe
 * dinners for seven days, plus one that must never be placed for someone
 * allergic to peanuts.
 */
const ing = (canonicalId: string, quantity: number, unit = 'g') => ({
  canonicalId,
  name: canonicalId.replace('_', ' '),
  quantity,
  unit,
  note: null,
});

const DINNERS = [
  { id: 'plan-palak', title: 'Palak dinner', ingredients: [ing('palak', 1, 'bunch'), ing('onion', 1, 'piece')] },
  { id: 'plan-dal', title: 'Toor dal dinner', ingredients: [ing('toor_dal', 200), ing('tomato', 2, 'piece')] },
  { id: 'plan-rajma', title: 'Rajma dinner', ingredients: [ing('rajma', 200), ing('onion', 1, 'piece')] },
  { id: 'plan-moong', title: 'Moong dal dinner', ingredients: [ing('moong_dal', 150)] },
  { id: 'plan-aloo', title: 'Aloo dinner', ingredients: [ing('potato', 400)] },
  { id: 'plan-paneer', title: 'Paneer dinner', ingredients: [ing('paneer', 200), ing('tomato', 2, 'piece')] },
  { id: 'plan-egg', title: 'Egg curry dinner', ingredients: [ing('egg', 4, 'piece'), ing('onion', 1, 'piece')] },
  { id: 'plan-peanut', title: 'Peanut chaat dinner', ingredients: [ing('peanut', 100), ing('onion', 1, 'piece')] },
];

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));
  const subs = env.TEST_SUBSTITUTIONS_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(subs.map((s) => env.DB.prepare(s)));

  await env.DB.batch(
    DINNERS.map((r) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO recipes
           (id, source, title, cuisine, ingredients, steps, minutes, servings,
            diet_tags, allergen_tags, content_hash, created_at)
         VALUES (?, 'seed', ?, 'indian', ?, '[]', 30, 2, '[]', '[]', ?, '2026-09-01T00:00:00.000Z')`,
      ).bind(r.id, r.title, JSON.stringify(r.ingredients), r.id),
    ),
  );
});

/** An agent addressed by its user ID, as section 9 requires everywhere. */
async function kitchen(): Promise<{ id: string; agent: DurableObjectStub<KitchenAgent> }> {
  const id = `plan-${crypto.randomUUID()}`;
  const agent = env.KITCHEN_AGENT.get(
    env.KITCHEN_AGENT.idFromName(id),
  ) as unknown as DurableObjectStub<KitchenAgent>;
  await agent.identify(id, false);
  return { id, agent };
}

async function allergicToPeanuts(agent: DurableObjectStub<KitchenAgent>): Promise<void> {
  await agent.setProfile({
    diets: [],
    allergens: ['peanuts'],
    exclusions: [],
    cuisines: [],
    maxCookMinutes: 60,
    servings: 2,
    spiceLevel: 'medium',
    timeZone: 'UTC',
  });
}

/**
 * Starts a plan through the agent and runs its Workflow to the end.
 *
 * The introspector is disposed before anything reads the agent again. In this
 * test pool, a call into a Durable Object after an introspected Workflow it
 * started has finished trips workerd's "code had hung" guard — harmless to
 * the assertions, but it is noise in the run output that would hide a real
 * one. Nothing in production introspects, so the order only matters here.
 */
async function runPlan(
  agent: DurableObjectStub<KitchenAgent>,
  options: { weekStart?: string; slots?: MealSlot[] },
  modify?: (m: Parameters<Parameters<WorkflowIntrospector['modifyAll']>[0]>[0]) => Promise<void>,
): Promise<{ planId: string; output: unknown; error: { message: string } | null }> {
  const introspector = await introspectWorkflow(env.WEEKLY_PLAN);
  try {
    if (modify) await introspector.modifyAll(modify);
    const { planId } = await agent.startWeeklyPlan(options);
    const [instance] = await introspector.get();
    if (!instance) throw new Error('No Workflow instance was created.');

    if (modify) {
      await instance.waitForStatus('errored');
      return { planId, output: null, error: await instance.getError() };
    }
    await instance.waitForStatus('complete');
    return { planId, output: await instance.getOutput(), error: null };
  } finally {
    await introspector.dispose();
  }
}

/* ------------------------------- a full run -------------------------------- */

describe('WeeklyPlanWorkflow', () => {
  it('plans the week from the catalog, safely, and writes the grocery list', async () => {
    const { agent } = await kitchen();
    await allergicToPeanuts(agent);
    await agent.addPantryItems('1kg paneer');

    const run = await runPlan(agent, { weekStart: WEEK_START, slots: ['dinner'] });
    expect(run.output).toMatchObject({
      status: 'complete',
      saved: true,
      unfilled: 0,
      // No AI binding in the pool: the run goes ahead on the catalog alone.
      catalogOnly: true,
    });

    const plan = await agent.currentPlan();
    expect(plan).toMatchObject({ id: run.planId, status: 'ready', complete: true });
    expect(plan?.days).toHaveLength(7);
    expect(plan?.days[0]?.date).toBe(WEEK_START);

    const titles = plan?.days.flatMap((d) => d.meals.map((m) => m.title)) ?? [];
    expect(titles).toHaveLength(7);
    // F8: no repeats within 7 days, which over a 7-day grid means none at all.
    expect(new Set(titles).size).toBe(7);
    // Section 7: every candidate goes through the safety engine first.
    //
    // The dish itself may come back with its peanuts swapped out — the
    // curated table can rescue it — so the property is about what is on the
    // plate, not the title: no placed meal contains peanut.
    const placed = plan?.days.flatMap((d) => d.meals.flatMap((m) => m.ingredients)) ?? [];
    expect(placed.map((i) => i.canonicalId)).not.toContain('peanut');

    // F9: what the plan needs minus the pantry. The kilo of paneer covers
    // the 200 g the paneer dinner needs, so paneer is not on the list.
    const grocery = await agent.groceryItems();
    const names = grocery.map((g) => g.canonicalId);
    expect(names).toContain('toor_dal');
    expect(names).not.toContain('paneer');
    expect(names).not.toContain('peanut');

    const inbox = await agent.listInbox();
    expect(inbox.map((i) => i.kind)).toContain('plan_ready');
    expect((await agent.snapshot()).activePlanStatus).toBe('ready');
  });

  it('leaves a slot open, and says so, rather than inventing a meal', async () => {
    const { agent } = await kitchen();
    await allergicToPeanuts(agent);

    // No breakfast in the catalog and no model to repair with.
    await runPlan(agent, { weekStart: WEEK_START, slots: ['breakfast', 'dinner'] });

    const plan = await agent.currentPlan();
    expect(plan?.status).toBe('ready');
    expect(plan?.complete).toBe(false);
    expect(plan?.unfilled.filter((g) => g.slot === 'breakfast')).toHaveLength(7);
    expect(plan?.days.flatMap((d) => d.meals).every((m) => m.slot === 'dinner')).toBe(true);

    const inbox = await agent.listInbox();
    expect(inbox.find((i) => i.kind === 'plan_ready')?.body).toContain('7 slots');
  });

  it('marks the plan failed and tells the user when a step gives up', async () => {
    const { agent } = await kitchen();

    const run = await runPlan(agent, { weekStart: WEEK_START, slots: ['dinner'] }, async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: 'build plan' }, new Error('the catalog is on fire'));
    });
    expect(run.error?.message).toContain('the catalog is on fire');

    const plan = await agent.currentPlan();
    expect(plan?.status).toBe('failed');
    expect(plan?.error).toContain('the catalog is on fire');
    expect((await agent.listInbox()).map((i) => i.kind)).toContain('system');
  });
});

/* ----------------------------- the plan row -------------------------------- */

describe('the plan row', () => {
  it('returns the running plan instead of starting a second one for the same week', async () => {
    const { agent } = await kitchen();
    const planId = crypto.randomUUID();
    // A row mid-generation, written directly so no Workflow can finish it
    // underneath the assertion.
    await runInDurableObject(agent, async (_instance: KitchenAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO plans (id, week_start, status, plan, created_at)
         VALUES (?, ?, 'generating', '{}', ?)`,
        planId,
        WEEK_START,
        new Date().toISOString(),
      );
    });

    const again = await agent.startWeeklyPlan({ weekStart: WEEK_START });
    expect(again).toEqual({ planId, weekStart: WEEK_START, alreadyRunning: true });
  });

  it('replaces a finished plan for the same week, grocery list and all', async () => {
    const { agent } = await kitchen();

    const first = await runPlan(agent, { weekStart: WEEK_START, slots: ['dinner'] });
    expect((await agent.groceryItems()).length).toBeGreaterThan(0);

    const second = await agent.startWeeklyPlan({ weekStart: WEEK_START, slots: ['dinner'] });
    expect(second.planId).not.toBe(first.planId);

    await runInDurableObject(agent, async (_instance: KitchenAgent, state) => {
      const leftover = state.storage.sql
        .exec('SELECT COUNT(*) AS n FROM grocery_items WHERE plan_id = ?', first.planId)
        .toArray()[0] as { n: number };
      expect(leftover.n).toBe(0);
    });
  });

  it('shows the plan asked for most recently, not the one for the latest week', async () => {
    const { agent } = await kitchen();
    // Next week's plan first, then one from today — what "start again" does
    // after a plan for next week was made from chat.
    await runInDurableObject(agent, async (_instance: KitchenAgent, state) => {
      const insert = (id: string, week: string, at: string, status: string) =>
        state.storage.sql.exec(
          `INSERT INTO plans (id, week_start, status, plan, created_at) VALUES (?, ?, ?, '{}', ?)`,
          id,
          week,
          status,
          at,
        );
      insert('next-week', '2026-10-12', '2026-10-01T08:00:00.000Z', 'ready');
      insert('from-today', '2026-10-05', '2026-10-01T09:00:00.000Z', 'generating');
    });

    expect((await agent.currentPlan())?.id).toBe('from-today');
    expect((await agent.snapshot()).activePlanStatus).toBe('running');
  });

  it('does not let a superseded run write over the plan that replaced it', async () => {
    const { agent } = await kitchen();
    const planId = crypto.randomUUID();
    await runInDurableObject(agent, async (_instance: KitchenAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO plans (id, week_start, status, plan, created_at)
         VALUES (?, '2026-11-02', 'generating', '{}', ?)`,
        planId,
        new Date().toISOString(),
      );
    });
    await agent.failPlan(planId, 'replaced');

    const late = await agent.savePlan(planId, {
      outcome: { status: 'complete', days: [], unfilled: [], repeated: [], dropped: [] },
      grocery: { lines: [], unquantified: [] },
      catalogOnly: false,
    });
    expect(late.saved).toBe(false);
    expect((await agent.currentPlan())?.status).toBe('failed');
  });
});

/* ---------------------------------- tools ---------------------------------- */

describe('the plan tools', () => {
  it('registers the four plan and grocery tools, none of them approval-gated', () => {
    const tools = buildTools({} as never) as Record<string, { needsApproval?: boolean }>;
    for (const name of ['start_weekly_plan', 'get_plan', 'get_grocery_list', 'check_grocery_item']) {
      expect(tools[name]).toBeDefined();
      expect(tools[name]?.needsApproval).toBeFalsy();
    }
  });

  it('hands the progress card every step, the first one already started', async () => {
    const ops = {
      startWeeklyPlan: async () => ({ planId: 'p1', weekStart: '2026-11-09', alreadyRunning: false }),
    };
    const tool = buildTools(ops as never).start_weekly_plan as unknown as {
      execute: (
        args: unknown,
        options: unknown,
      ) => Promise<{ planId: string; steps: { name: string; status: string }[] }>;
    };

    const out = await tool.execute({ week_start: '2026-11-09', slots: ['dinner'] }, {});
    expect(out.planId).toBe('p1');
    expect(out.steps.map((s) => s.name)).toEqual([...PLAN_STEPS]);
    expect(out.steps[0]?.status).toBe('started');
    expect(out.steps.slice(1).every((s) => s.status === 'pending')).toBe(true);
  });
});
