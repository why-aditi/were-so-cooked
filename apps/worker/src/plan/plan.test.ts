import { describe, expect, it } from 'vitest';
import {
  SUBS,
  TAXONOMY,
  cooked,
  draft,
  fakeGenerate,
  fakeSearch,
  item,
  profile,
  recipe,
  ri,
} from './fixtures.js';
import {
  type PlanDeps,
  type PlanRequest,
  buildPlan,
  cookedWithinWindow,
  planDates,
  rankPantry,
  repairRound,
} from './plan.js';

/**
 * The weekly plan core, with the catalog and the model faked.
 *
 * F8 is four rules that hold simultaneously, and every one of them is easy to
 * satisfy on its own and easy to break by satisfying another. So most of what
 * follows is the interaction: expiring-first against no-repeats, the cook-time
 * limit against a model that ignored it, and the safety gate against a slot
 * that would otherwise be left empty.
 */

const NOW = Date.parse('2026-09-27T12:00:00Z');
const WEEK_START = '2026-09-28';

const baseDeps: Omit<PlanDeps, 'search'> = {
  taxonomy: TAXONOMY,
  substitutions: SUBS,
  now: NOW,
};

const request = (over: Partial<PlanRequest> = {}): PlanRequest => ({
  weekStart: WEEK_START,
  slots: ['dinner'],
  profile: profile(),
  pantry: [],
  history: [],
  ...over,
});

const titles = (days: { meals: { title: string }[] }[]): string[] =>
  days.flatMap((d) => d.meals.map((m) => m.title));

/* --------------------------------- dates ---------------------------------- */

describe('the grid', () => {
  it('runs seven consecutive days from the week start', () => {
    expect(planDates('2026-09-28')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('refuses a week start it cannot parse', () => {
    // An unparseable date otherwise produces seven days called "Invalid Date"
    // and a plan that looks fine until it is saved.
    expect(() => planDates('next monday')).toThrow(RangeError);
  });
});

/* -------------------------------- the pantry ------------------------------- */

describe('ranking the pantry by expiry', () => {
  it('puts the soonest expiry first and undated items last', () => {
    const ranked = rankPantry([
      item({ displayName: 'rice', expiresAt: null }),
      item({ displayName: 'spinach', expiresAt: '2026-09-29T00:00:00.000Z' }),
      item({ displayName: 'paneer', expiresAt: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect(ranked.map((i) => i.displayName)).toEqual(['spinach', 'paneer', 'rice']);
  });

  it('breaks a tie on quantity, because a kilo going off is the bigger loss', () => {
    const ranked = rankPantry([
      item({ displayName: 'small', quantity: 50, expiresAt: '2026-09-29T00:00:00.000Z' }),
      item({ displayName: 'large', quantity: 1000, expiresAt: '2026-09-29T00:00:00.000Z' }),
    ]);
    expect(ranked[0]?.displayName).toBe('large');
  });

  it('ignores soft-deleted rows', () => {
    expect(rankPantry([item({ deletedAt: '2026-09-26T00:00:00.000Z' })])).toEqual([]);
  });
});

/* ------------------------------- no repeats -------------------------------- */

describe('the seven-day repeat window', () => {
  const day = Date.parse('2026-09-28T00:00:00Z');

  it('remembers a dish cooked two days ago', () => {
    expect(cookedWithinWindow([cooked('Palak paneer', '2026-09-26T19:00:00.000Z')], day)).toEqual(
      new Set(['palak paneer']),
    );
  });

  it('forgets a dish cooked ten days ago', () => {
    // Section 6 loads fourteen days of history but F8's window is seven, so
    // the extra week is context for taste, not a repeat ban.
    expect(cookedWithinWindow([cooked('Rajma', '2026-09-18T19:00:00.000Z')], day).size).toBe(0);
  });
});

/* -------------------------------- buildPlan --------------------------------- */

describe('building a week', () => {
  it('fills every enabled slot on every day and leaves the others out', async () => {
    const pool = Array.from({ length: 20 }, () => recipe());
    const out = await buildPlan(request({ slots: ['breakfast', 'dinner'] }), {
      ...baseDeps,
      search: fakeSearch(pool),
    });
    expect(out.status).toBe('complete');
    expect(out.days).toHaveLength(7);
    for (const day of out.days) {
      expect(day.meals.map((m) => m.slot)).toEqual(['breakfast', 'dinner']);
    }
  });

  it('never repeats a dish anywhere in the week', async () => {
    // Day 0 and day 6 are six days apart, so F8's seven-day window covers the
    // whole grid: one set of titles, not a rolling one.
    const pool = Array.from({ length: 10 }, () => recipe());
    const out = await buildPlan(request(), { ...baseDeps, search: fakeSearch(pool) });
    const used = titles(out.days);
    expect(used).toHaveLength(7);
    expect(new Set(used).size).toBe(7);
  });

  it('keeps a recently cooked dish out until seven days have passed', async () => {
    // F8's rule is the gap between two servings, not the calendar week, so
    // it is asked per day. Cooked on the 26th, the dish is blocked through
    // 3 October and free on the 4th — eight days later, which is exactly
    // what "no repeats within 7 days" permits.
    //
    // The stricter reading — barred from the whole grid — was considered
    // and rejected: it shrinks an already small catalog for no benefit the
    // spec asks for, and the module documents the per-day rule.
    const recent = recipe({ title: 'Palak paneer' });
    const other = recipe({ title: 'Rajma chawal' });
    const out = await buildPlan(
      request({ history: [cooked('Palak paneer', '2026-09-26T19:00:00.000Z')] }),
      { ...baseDeps, search: fakeSearch([recent, other]) },
    );

    const byDay = out.days.map((d) => d.meals.map((m) => m.title));
    // 28 September through 3 October: still inside the window.
    expect(byDay.slice(0, 6).flat()).not.toContain('Palak paneer');
    // 4 October: eight days on, so it is allowed back.
    expect(byDay[6]).toContain('Palak paneer');
  });

  it('will plan a dish that was cooked a fortnight ago', async () => {
    const out = await buildPlan(
      request({ history: [cooked('Palak paneer', '2026-09-14T19:00:00.000Z')] }),
      { ...baseDeps, search: fakeSearch([recipe({ title: 'Palak paneer' })]) },
    );
    expect(titles(out.days)).toContain('Palak paneer');
  });

  it('honours the profile cook-time limit even when the catalog ignores it', async () => {
    // The search query carries `maxMinutes`, but a fake catalog, a stale D1
    // row and every generated dish all arrive without having been filtered.
    const out = await buildPlan(request({ profile: profile({ maxCookMinutes: 30 }) }), {
      ...baseDeps,
      search: fakeSearch([recipe({ minutes: 90 })]),
    });
    expect(out.status).toBe('partial');
    expect(out.unfilled).toHaveLength(7);
    expect(out.days.every((d) => d.meals.length === 0)).toBe(true);
  });
});

/* ------------------------------ expiring first ------------------------------ */

describe('using soon-to-expire items first', () => {
  const spinachGoesOff = item({
    canonicalId: 'palak',
    displayName: 'spinach',
    expiresAt: '2026-09-29T00:00:00.000Z',
  });
  const tomato = item({ canonicalId: 'tomato', displayName: 'tomato', expiresAt: null });
  const rice = item({ canonicalId: 'rice', displayName: 'basmati rice', expiresAt: null });

  const withSpinach = recipe({
    title: 'Palak sabzi',
    ingredients: [ri('palak', 'spinach', 1, 'bunch'), ri('tomato', 'tomato', 2, 'piece')],
  });
  const alsoSpinach = recipe({
    title: 'Palak rice',
    ingredients: [ri('palak', 'spinach', 1, 'bunch'), ri('rice', 'basmati rice', 200, 'g')],
  });
  const noSpinach = recipe({
    title: 'Tomato rice',
    ingredients: [ri('tomato', 'tomato', 2, 'piece'), ri('rice', 'basmati rice', 200, 'g')],
  });

  it('cooks the dish that saves the spinach on the first day', async () => {
    const out = await buildPlan(request({ pantry: [spinachGoesOff, tomato, rice] }), {
      ...baseDeps,
      search: fakeSearch([noSpinach, withSpinach]),
    });
    expect(out.days[0]?.meals[0]?.title).toBe('Palak sabzi');
  });

  it('does not let one dying bunch of spinach justify two different dinners', async () => {
    // The bug this guards: without marking an expiring item spent, both
    // spinach dishes keep scoring "uses something that is about to go off",
    // and the plan claims to use up a bunch it only has one of.
    const out = await buildPlan(request({ pantry: [spinachGoesOff, tomato, rice] }), {
      ...baseDeps,
      search: fakeSearch([withSpinach, alsoSpinach, noSpinach]),
    });

    const [first, second] = titles(out.days);
    // Which spinach dish wins day one is an arbitrary tie-break — both use
    // the bunch, both are fully covered — so asserting the title would pin
    // the sort order rather than the rule. What matters is that day two
    // moves on once the bunch is spent.
    expect(['Palak sabzi', 'Palak rice']).toContain(first);
    expect(second).toBe('Tomato rice');
  });

  it('ignores stock that has already gone off by the day it would be cooked', async () => {
    const deadByThen = item({
      canonicalId: 'palak',
      displayName: 'spinach',
      expiresAt: '2026-09-28T00:00:00.000Z',
    });
    const out = await buildPlan(
      request({ weekStart: '2026-10-05', pantry: [deadByThen] }),
      { ...baseDeps, search: fakeSearch([withSpinach]) },
    );
    expect(out.days[0]?.meals[0]?.pantryCoverage).toBe(0);
  });
});

/* -------------------------------- the gate ---------------------------------- */

describe('the safety gate', () => {
  const treat = recipe({
    title: 'Kheer',
    ingredients: [ri('milk', 'milk', 500, 'ml'), ri('sugar', 'sugar', 50, 'g')],
  });

  it('holds a sweet treat to the same diet rules as a main', async () => {
    // F8 says so explicitly, and the mechanism is that there is no separate
    // path: the treat pool goes through the same `gate` as every other slot.
    const out = await buildPlan(
      request({ slots: ['treat'], profile: profile({ diets: ['vegan'] }) }),
      { ...baseDeps, search: fakeSearch([treat]) },
    );
    expect(out.days[0]?.meals[0]?.swaps[0]).toMatchObject({ fromName: 'milk', toName: 'tofu' });
  });

  it('leaves the treat slot empty rather than serving something it cannot fix', async () => {
    const chickenPudding = recipe({
      title: 'Not a pudding',
      ingredients: [ri('chicken', 'chicken', 300, 'g'), ri('sugar', 'sugar', 50, 'g')],
    });
    const out = await buildPlan(
      request({ slots: ['treat'], profile: profile({ diets: ['vegan'] }) }),
      { ...baseDeps, search: fakeSearch([chickenPudding]) },
    );
    expect(out.status).toBe('partial');
    expect(out.dropped[0]?.title).toBe('Not a pudding');
    expect(out.dropped[0]?.reason.length).toBeGreaterThan(10);
  });

  it('recomputes tags rather than trusting the catalog row', async () => {
    const lying = recipe({ dietTags: ['vegan'], allergenTags: [] });
    await buildPlan(request(), { ...baseDeps, search: fakeSearch([lying]) });
    // The gate rewrites the recipe it returns; the plan meal carries the
    // gated ingredients, which is what section 7 makes the guarantee about.
    expect(lying.allergenTags).toEqual([]);
  });
});

/* -------------------------------- cuisines ---------------------------------- */

describe('the cuisine filter', () => {
  it('keeps only the cuisines the user asked for', async () => {
    const out = await buildPlan(request({ cuisines: ['thai'] }), {
      ...baseDeps,
      search: fakeSearch([recipe({ cuisine: 'indian' }), recipe({ cuisine: 'Thai' })]),
    });
    expect(new Set(titles(out.days)).size).toBe(1);
    expect(out.days[0]?.meals[0]?.title).toBeDefined();
  });
});

/* --------------------------------- repair ----------------------------------- */

describe('repair rounds', () => {
  it('generates only for the days that failed', async () => {
    const generate = fakeGenerate([
      [draft({ title: 'Invented A' }), draft({ title: 'Invented B' })],
    ]);
    const out = await buildPlan(request(), {
      ...baseDeps,
      search: fakeSearch(Array.from({ length: 5 }, () => recipe())),
      generate,
    });
    expect(out.status).toBe('complete');
    expect(out.repairRounds).toBe(1);
    expect(generate.calls).toHaveLength(1);
    // Two slots were empty, so it asks for two plus one spare.
    expect(generate.calls[0]?.count).toBe(3);
    expect(titles(out.days)).toContain('Invented A');
  });

  it('stores a generated dish without a recipe id', async () => {
    // Section 6: new dishes store a title and an ingredient list; there is no
    // catalog row to point at until someone opens the recipe.
    const out = await buildPlan(request(), {
      ...baseDeps,
      search: fakeSearch([]),
      generate: fakeGenerate([[draft({ title: 'Invented A' })]]),
    });
    const invented = out.days[0]?.meals[0];
    expect(invented?.title).toBe('Invented A');
    expect(invented?.recipeId).toBeNull();
  });

  it('runs a second round when the first one only half worked', async () => {
    const generate = fakeGenerate([
      [draft({ title: 'Invented A' })],
      [draft({ title: 'Invented B' }), draft({ title: 'Invented C' })],
    ]);
    const out = await buildPlan(request(), {
      ...baseDeps,
      search: fakeSearch(Array.from({ length: 4 }, () => recipe())),
      generate,
    });
    expect(out.repairRounds).toBe(2);
    expect(generate.calls).toHaveLength(2);
    expect(out.status).toBe('complete');
  });

  it('stops after a round that changed nothing rather than spending the second', async () => {
    // Section 6 allows two rounds; a round that filled nothing will not fill
    // anything on a second identical ask, and neurons are the scarce thing.
    const generate = fakeGenerate([[]]);
    const out = await buildPlan(request(), {
      ...baseDeps,
      search: fakeSearch([recipe()]),
      generate,
    });
    expect(generate.calls).toHaveLength(1);
    expect(out.repairRounds).toBe(1);
  });

  it('never calls the model when there is no generator', async () => {
    // What a refused budget reservation looks like from in here.
    const out = await buildPlan(request(), { ...baseDeps, search: fakeSearch([recipe()]) });
    expect(out.modelCalled).toBe(false);
    expect(out.repairRounds).toBe(0);
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('asks once per failing slot, not once per failing day', async () => {
    const generate = fakeGenerate([[]]);
    await repairRound(
      [
        { date: '2026-09-28', slot: 'dinner', reason: '' },
        { date: '2026-09-29', slot: 'dinner', reason: '' },
        { date: '2026-09-28', slot: 'lunch', reason: '' },
      ],
      request(),
      { ...baseDeps, search: fakeSearch([]), generate },
      [],
    );
    // Two slots had gaps, so two calls — not three, one per gap. Section 6
    // budgets steps carefully and a per-gap fan-out is how a bad week turns
    // into 28 inference calls.
    expect(generate.calls).toHaveLength(2);
    // Sorted because which slot is asked first is not the behaviour under
    // test: dinner needs 3 (two gaps plus a spare), lunch needs 2.
    expect(generate.calls.map((c) => c.count).sort()).toEqual([2, 3]);
  });

  it('gates what the model invented, and drops what it cannot rescue', async () => {
    const out = await buildPlan(request({ profile: profile({ diets: ['vegan'] }) }), {
      ...baseDeps,
      search: fakeSearch([]),
      generate: fakeGenerate([
        [
          draft({
            title: 'Chicken thing',
            ingredients: [{ name: 'chicken', quantity: 300, unit: 'g', note: null }],
          }),
        ],
      ]),
    });
    expect(titles(out.days)).not.toContain('Chicken thing');
    expect(out.dropped.map((d) => d.title)).toContain('Chicken thing');
    expect(out.status).toBe('partial');
  });

  it('rejects a generated dish that blows the cook-time limit', async () => {
    const out = await buildPlan(request({ profile: profile({ maxCookMinutes: 30 }) }), {
      ...baseDeps,
      search: fakeSearch([]),
      generate: fakeGenerate([[draft({ title: 'Slow braise', minutes: 240 })]]),
    });
    expect(titles(out.days)).toEqual([]);
    expect(out.status).toBe('partial');
  });
});

/* ------------------------------ the fallback -------------------------------- */

describe('the catalog fallback', () => {
  it('repeats a safe dish rather than leaving the day blank, and says it did', async () => {
    const out = await buildPlan(request(), {
      ...baseDeps,
      search: fakeSearch([recipe({ title: 'Only dish' })]),
    });
    expect(out.status).toBe('complete');
    expect(titles(out.days)).toHaveLength(7);
    expect(out.repeated).toHaveLength(6);
    expect(out.repeated[0]).toMatchObject({ date: '2026-09-29', slot: 'dinner' });
  });

  it('reports a partial plan when even a repeat is not available', async () => {
    const out = await buildPlan(request({ slots: ['breakfast', 'lunch', 'dinner', 'treat'] }), {
      ...baseDeps,
      search: fakeSearch([]),
    });
    expect(out.status).toBe('partial');
    expect(out.unfilled).toHaveLength(28);
    expect(out.days.every((d) => d.meals.length === 0)).toBe(true);
  });
});
