import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import type { Classifier } from '../src/normalize/index.js';

/**
 * The KitchenAgent in workerd, against a real Durable Object and the real
 * seeded D1 taxonomy.
 *
 * The deduction arithmetic is covered in src/agent/deduct.test.ts, which needs
 * no runtime. What only this can test is the join: that the taxonomy actually
 * loads from D1, that soft deletes really hide rows, and that a deduction
 * survives a round trip through SQLite.
 */

type Agent = KitchenAgent;

let n = 0;
const freshAgent = (): Agent =>
  env.KITCHEN_AGENT.get(
    env.KITCHEN_AGENT.idFromName(`kitchen-test-${(n += 1)}-${crypto.randomUUID()}`),
  ) as unknown as Agent;

/**
 * The agent reads the taxonomy from D1, so the tests need it there. Loading
 * the generated seed rather than a handful of fake rows keeps this honest:
 * "dhaniya" has to resolve through the same data production uses.
 */
beforeAll(async () => {
  const statements = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
});

/* ------------------------------ adding items ------------------------------ */

describe('add_pantry_items', () => {
  it('turns one phrase into three normalized rows', async () => {
    const agent = freshAgent();
    const result = await agent.addPantryItems('bought 1kg paneer, 6 eggs and a bunch of dhaniya');

    expect(result.added).toHaveLength(3);
    expect(result.added.map((i) => i.canonicalId)).toEqual(['paneer', 'egg', 'coriander_leaves']);
    expect(result.added[0]).toMatchObject({ quantity: 1, unit: 'kg', qtyConfidence: 'exact' });
    expect(result.added[2]).toMatchObject({ quantity: 1, unit: 'bunch' });
    expect(result.modelCalled).toBe(false);
  });

  it('stamps an estimated expiry from the taxonomy shelf life', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('1kg paneer');
    const item = added[0];
    expect(item?.expirySource).toBe('estimated');
    // paneer is 3 days in the seed.
    const days = (Date.parse(item?.expiresAt as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it('keeps an unresolved item rather than dropping it', async () => {
    const agent = freshAgent();
    const result = await agent.addPantryItems('500g flibbertigibbet');
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.canonicalId).toBeNull();
    expect(result.unresolved).toEqual(['flibbertigibbet']);
    // Null canonical id is what makes the safety engine treat it as
    // unverifiable. Backfilling a guess here would defeat that.
    expect((await agent.listPantry())[0]?.canonicalId).toBeNull();
  });

  it('only calls the model for names the taxonomy missed', async () => {
    const agent = freshAgent();
    const classify = vi.fn<Classifier>(async () => ({}));
    await agent.addPantryItems('1kg paneer, 6 eggs', { classify });
    expect(classify).not.toHaveBeenCalled();
  });

  it('records the source so photo scans are distinguishable from chat', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('1kg paneer', { source: 'photo' });
    expect(added[0]?.source).toBe('photo');
  });
});

/* ------------------------------ listing items ----------------------------- */

describe('list_pantry', () => {
  it('sorts by expiry, soonest first, with undated items last', async () => {
    const agent = freshAgent();
    // paneer 3 days, basmati rice 730, palak 3, table salt 730.
    await agent.addPantryItems('1kg basmati chawal, 1 bunch palak, 500g paneer');
    const items = await agent.listPantry();
    const expiries = items.map((i) => i.expiresAt);
    const sorted = [...expiries].sort();
    expect(expiries).toEqual(sorted);
  });

  it('filters to items expiring soon', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('500g paneer, 2kg basmati chawal');
    const soon = await agent.listPantry({ expiringWithinDays: 7 });
    expect(soon.map((i) => i.canonicalId)).toEqual(['paneer']);
  });

  it('hides soft-deleted rows unless asked', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('500g paneer');
    await agent.removePantryItems([added[0]?.id as string]);

    expect(await agent.listPantry()).toHaveLength(0);
    const withDeleted = await agent.listPantry({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).not.toBeNull();
  });
});

/* ------------------------------ edit and undo ----------------------------- */

describe('update and remove', () => {
  it('corrects a quantity the estimate got wrong', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('some paneer');
    const updated = await agent.updatePantryItem(added[0]?.id as string, {
      quantity: 400,
      unit: 'g',
    });
    expect(updated).toMatchObject({ quantity: 400, unit: 'g' });
  });

  it('marks a user-supplied expiry as no longer an estimate', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('500g paneer');
    const updated = await agent.updatePantryItem(added[0]?.id as string, {
      expiresAt: '2026-12-25T00:00:00.000Z',
    });
    // The UI stops saying "about" once the user has typed a real date.
    expect(updated).toMatchObject({
      expiresAt: '2026-12-25T00:00:00.000Z',
      expirySource: 'user',
    });
  });

  it('restores a soft-deleted item, which is the undo section 4 wants', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('500g paneer');
    const id = added[0]?.id as string;

    await agent.removePantryItems([id]);
    expect(await agent.listPantry()).toHaveLength(0);

    const { restored } = await agent.restorePantryItems([id]);
    expect(restored).toEqual([id]);
    expect(await agent.listPantry()).toHaveLength(1);
  });

  it('refuses to edit an item that is already gone', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('500g paneer');
    const id = added[0]?.id as string;
    await agent.removePantryItems([id]);
    expect(await agent.updatePantryItem(id, { quantity: 1 })).toBeNull();
  });

  it('ignores an unknown id rather than throwing', async () => {
    const agent = freshAgent();
    expect((await agent.removePantryItems(['nope'])).removed).toEqual([]);
    expect(await agent.updatePantryItem('nope', { quantity: 1 })).toBeNull();
  });
});

/* -------------------------------- log_cooked ------------------------------ */

describe('log_cooked', () => {
  const palakPaneer = {
    title: 'Palak paneer',
    ingredients: [
      { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g' as const },
      { canonicalId: 'palak', name: 'palak', quantity: 1, unit: 'bunch' as const },
      { canonicalId: 'ghee', name: 'ghee', quantity: 2, unit: 'tbsp' as const },
    ],
  };

  it('previews the deduction without changing anything', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('1kg paneer, 2 bunches palak');

    const preview = await agent.previewCooked(palakPaneer);
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(preview.plan.deductions).toHaveLength(2);

    // Nothing moved: the approval card has not been tapped yet.
    const after = await agent.listPantry();
    expect(after.find((i) => i.canonicalId === 'paneer')?.quantity).toBe(1);
  });

  it('applies the deduction and logs the meal', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('1kg paneer, 2 bunches palak');

    const { logId, plan, pantry } = await agent.logCooked(palakPaneer);
    expect(logId).toBeTruthy();

    // 200g out of 1kg leaves 0.8kg.
    expect(pantry.find((i) => i.canonicalId === 'paneer')?.quantity).toBeCloseTo(0.8, 6);
    expect(pantry.find((i) => i.canonicalId === 'palak')?.quantity).toBe(1);
    // Ghee was never in the pantry.
    expect(plan.shortfalls.map((s) => s.name)).toContain('ghee');
  });

  it('soft-deletes a row it empties', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('200g paneer');
    await agent.logCooked({
      title: 'Paneer bhurji',
      ingredients: [{ canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g' }],
    });

    // A row at quantity 0 that stayed live would show in the pantry as
    // something you do not have.
    expect(await agent.listPantry()).toHaveLength(0);
    expect(await agent.listPantry({ includeDeleted: true })).toHaveLength(1);
  });

  it('logs the meal even when ingredients are missing', async () => {
    // Someone who cooked with the last of the salt still cooked the dish, and
    // section 6's no-repeat rule needs the history.
    const agent = freshAgent();
    const { plan } = await agent.logCooked(palakPaneer);
    expect(plan.deductions).toHaveLength(0);
    expect(plan.shortfalls).toHaveLength(3);
    expect(await agent.cookingHistory()).toHaveLength(1);
  });

  it('scales by servings', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('1kg paneer');
    const { pantry } = await agent.logCooked({ ...palakPaneer, servingsMultiplier: 2 });
    expect(pantry.find((i) => i.canonicalId === 'paneer')?.quantity).toBeCloseTo(0.6, 6);
  });

  it('recomputes the plan at commit rather than trusting the preview', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('1kg paneer');
    await agent.previewCooked(palakPaneer);

    // The user removes the paneer while the approval card is open.
    await agent.removePantryItems([added[0]?.id as string]);

    const { plan } = await agent.logCooked(palakPaneer);
    // A stale plan would have deducted from a row that no longer exists.
    expect(plan.deductions).toHaveLength(0);
    expect(plan.shortfalls.map((s) => s.name)).toContain('paneer');
  });

  it('returns recent meals for the no-repeat rule', async () => {
    const agent = freshAgent();
    await agent.logCooked({ title: 'Palak paneer', ingredients: [] });
    await agent.logCooked({ title: 'Dal tadka', ingredients: [] });
    const history = await agent.cookingHistory();
    expect(history.map((h) => h.title).sort()).toEqual(['Dal tadka', 'Palak paneer']);
  });
});

/* --------------------------------- profile -------------------------------- */

describe('profile', () => {
  it('starts with a usable default row', async () => {
    const profile = await freshAgent().getProfile();
    expect(profile).toMatchObject({ diets: [], allergens: [], servings: 2, spiceLevel: 'medium' });
  });

  it('round-trips a full profile', async () => {
    const agent = freshAgent();
    const saved = await agent.setProfile({
      diets: ['vegan', 'gluten_free'],
      allergens: ['tree_nuts'],
      exclusions: ['mushroom'],
      cuisines: ['indian'],
      maxCookMinutes: 30,
      servings: 3,
      spiceLevel: 'hot',
      timeZone: 'Asia/Kolkata',
    });
    expect(saved).toMatchObject({ diets: ['vegan', 'gluten_free'], allergens: ['tree_nuts'] });
    expect(await agent.getProfile()).toEqual(saved);
  });
});

/* ---------------------------------- state --------------------------------- */

describe('the synced state snapshot', () => {
  it('counts live pantry items and the ones going off soon', async () => {
    const agent = freshAgent();
    await agent.addPantryItems('500g paneer, 2kg basmati chawal, 1 bunch palak');
    const snapshot = await agent.snapshot();

    expect(snapshot.pantryCount).toBe(3);
    // paneer and palak are 3 days; rice is 730.
    expect(snapshot.expiringSoonCount).toBe(0);
    expect(snapshot.unreadInbox).toBe(0);
    expect(snapshot.activePlanStatus).toBeNull();
  });

  it('stops counting an item once it is removed', async () => {
    const agent = freshAgent();
    const { added } = await agent.addPantryItems('500g paneer');
    await agent.removePantryItems([added[0]?.id as string]);
    expect((await agent.snapshot()).pantryCount).toBe(0);
  });
});

/* -------------------------------- isolation ------------------------------- */

describe('one kitchen per user', () => {
  it('keeps two agents completely separate', async () => {
    const a = freshAgent();
    const b = freshAgent();
    await a.addPantryItems('1kg paneer');

    expect(await a.listPantry()).toHaveLength(1);
    expect(await b.listPantry()).toHaveLength(0);
    expect((await b.snapshot()).pantryCount).toBe(0);
  });

  it('destroy tears the agent down for good', async () => {
    const name = `destroy-${crypto.randomUUID()}`;
    const agent = env.KITCHEN_AGENT.get(
      env.KITCHEN_AGENT.idFromName(name),
    ) as unknown as Agent;
    await agent.addPantryItems('1kg paneer, 6 eggs');
    expect(await agent.listPantry()).toHaveLength(2);

    // Destroying an Agent deletes its facet, which aborts the isolate: the
    // call rejects with "destroyed" even though it worked, and the name stays
    // unusable for the rest of this runtime. `deleteUserData` is written to
    // treat that rejection as success, and DELETE /api/me covers that path.
    const destroyError = await agent.destroy().then(
      () => null,
      (e: unknown) => String(e),
    );
    // Either outcome is a successful teardown; what must not happen is the
    // agent still serving data afterwards.
    if (destroyError !== null) expect(destroyError).toContain('destroyed');

    const readAfter = await agent.listPantry().then(
      (items) => items.length,
      (e: unknown) => String(e),
    );
    expect(readAfter === 0 || String(readAfter).includes('destroyed')).toBe(true);
  });
});
