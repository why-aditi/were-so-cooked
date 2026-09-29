import { describe, expect, it } from 'vitest';
import {
  type PantryRow,
  type RequiredIngredient,
  convert,
  convertible,
  describePlan,
  planDeduction,
} from './deduct.js';

/**
 * The arithmetic behind `log_cooked`.
 *
 * Section 5 shows this deduction to the user for approval before anything
 * changes, so a wrong number here is a wrong number on the approval card —
 * which someone will tap without reading.
 */

let seq = 0;
const row = (over: Partial<PantryRow> = {}): PantryRow => {
  seq += 1;
  return {
    id: `p${seq}`,
    canonicalId: 'paneer',
    displayName: 'paneer',
    quantity: 1000,
    unit: 'g',
    expiresAt: null,
    ...over,
  };
};
const need = (over: Partial<RequiredIngredient> = {}): RequiredIngredient => ({
  canonicalId: 'paneer',
  name: 'paneer',
  quantity: 200,
  unit: 'g',
  ...over,
});

/* ------------------------------- conversion ------------------------------- */

describe('unit conversion', () => {
  it.each([
    [1, 'kg', 'g', 1000],
    [500, 'g', 'kg', 0.5],
    [1, 'l', 'ml', 1000],
    [250, 'ml', 'l', 0.25],
    [1, 'tbsp', 'ml', 15],
    [1, 'cup', 'ml', 240],
    [3, 'tsp', 'tbsp', 1],
    [2, 'piece', 'piece', 2],
  ])('%s %s -> %s = %s', (qty, from, to, expected) => {
    expect(convert(qty, from as never, to as never)).toBeCloseTo(expected, 6);
  });

  it('refuses to convert across dimensions', () => {
    // 200g of milk is not 200ml of milk, and pretending otherwise is how a
    // pantry ends up with negative quantities.
    expect(convert(200, 'g', 'ml')).toBeNull();
    expect(convert(1, 'kg', 'piece')).toBeNull();
    expect(convertible('l', 'g')).toBe(false);
  });

  it('treats bunch, packet and pinch as convertible only to themselves', () => {
    // A bunch of coriander is not a reliable number of grams. Inventing a
    // factor would turn a rough pantry into confidently wrong arithmetic.
    for (const unit of ['bunch', 'packet', 'pinch'] as const) {
      expect(convert(1, unit, 'g')).toBeNull();
      expect(convert(1, 'g', unit)).toBeNull();
      expect(convert(2, unit, unit)).toBe(2);
    }
  });
});

/* -------------------------------- planning -------------------------------- */

describe('planning a deduction', () => {
  it('takes the recipe amount out of a single matching row', () => {
    const plan = planDeduction([need({ quantity: 200 })], [row({ quantity: 1000, unit: 'g' })]);
    expect(plan.deductions).toHaveLength(1);
    expect(plan.deductions[0]).toMatchObject({ quantity: 200, unit: 'g', emptied: false });
    expect(plan.shortfalls).toHaveLength(0);
  });

  it('converts into the pantry row unit before deducting', () => {
    // Recipe in grams, pantry in kilos: the row must be decremented in kg.
    const plan = planDeduction([need({ quantity: 200, unit: 'g' })], [row({ quantity: 1, unit: 'kg' })]);
    expect(plan.deductions[0]).toMatchObject({ quantity: 0.2, unit: 'kg' });
  });

  it('marks a row emptied when it is fully consumed', () => {
    const plan = planDeduction([need({ quantity: 1000 })], [row({ quantity: 1000 })]);
    expect(plan.deductions[0]?.emptied).toBe(true);
    expect(plan.shortfalls).toHaveLength(0);
  });

  it('spreads across rows, oldest expiry first', () => {
    // Section 8 plans around using soon-to-expire items first, so cooking
    // should consume the same ones.
    const older = row({ id: 'old', quantity: 150, expiresAt: '2026-09-27T00:00:00Z' });
    const newer = row({ id: 'new', quantity: 500, expiresAt: '2026-10-05T00:00:00Z' });
    const plan = planDeduction([need({ quantity: 300 })], [newer, older]);

    expect(plan.deductions.map((d) => d.pantryItemId)).toEqual(['old', 'new']);
    expect(plan.deductions[0]).toMatchObject({ quantity: 150, emptied: true });
    expect(plan.deductions[1]).toMatchObject({ quantity: 150, emptied: false });
  });

  it('puts rows with no expiry last', () => {
    const dated = row({ id: 'dated', quantity: 100, expiresAt: '2026-10-01T00:00:00Z' });
    const undated = row({ id: 'undated', quantity: 100, expiresAt: null });
    const plan = planDeduction([need({ quantity: 150 })], [undated, dated]);
    expect(plan.deductions[0]?.pantryItemId).toBe('dated');
  });

  it('never lets two recipe lines spend the same jar twice', () => {
    // Two lines for the same ingredient, one row with enough for only one.
    const plan = planDeduction(
      [need({ quantity: 600 }), need({ quantity: 600 })],
      [row({ quantity: 1000 })],
    );
    const total = plan.deductions.reduce((n, d) => n + d.quantity, 0);
    expect(total).toBe(1000);
    expect(plan.shortfalls).toHaveLength(1);
    expect(plan.shortfalls[0]).toMatchObject({ quantity: 200, reason: 'not_enough' });
  });
});

/* ------------------------------- shortfalls ------------------------------- */

describe('what it refuses to invent', () => {
  it('reports an ingredient the pantry does not have', () => {
    const plan = planDeduction([need({ canonicalId: 'ghee', name: 'ghee' })], [row()]);
    expect(plan.deductions).toHaveLength(0);
    expect(plan.shortfalls[0]).toMatchObject({ name: 'ghee', reason: 'not_in_pantry' });
  });

  it('never produces a negative quantity', () => {
    const plan = planDeduction([need({ quantity: 5000 })], [row({ quantity: 100 })]);
    expect(plan.deductions[0]?.quantity).toBe(100);
    expect(plan.shortfalls[0]?.quantity).toBe(4900);
  });

  it('flags an incompatible unit rather than guessing a conversion', () => {
    // Recipe wants 20g of coriander; the pantry has one bunch.
    const plan = planDeduction(
      [{ canonicalId: 'coriander_leaves', name: 'coriander', quantity: 20, unit: 'g' }],
      [row({ canonicalId: 'coriander_leaves', displayName: 'coriander', quantity: 1, unit: 'bunch' })],
    );
    expect(plan.deductions).toHaveLength(0);
    expect(plan.shortfalls[0]?.reason).toBe('incompatible_unit');
  });

  it('skips a line with no amount instead of deducting nothing silently', () => {
    const plan = planDeduction(
      [{ canonicalId: 'table_salt', name: 'salt', quantity: null, unit: null }],
      [row()],
    );
    expect(plan.skipped).toEqual(['salt']);
    expect(plan.deductions).toHaveLength(0);
    expect(plan.shortfalls).toHaveLength(0);
  });

  it('skips to_taste, which is an instruction rather than an amount', () => {
    const plan = planDeduction(
      [{ canonicalId: 'table_salt', name: 'salt', quantity: 1, unit: 'to_taste' }],
      [row({ canonicalId: 'table_salt', displayName: 'salt', unit: 'to_taste' })],
    );
    expect(plan.skipped).toEqual(['salt']);
  });

  it('matches on name when the recipe line has no canonical id', () => {
    const plan = planDeduction(
      [{ canonicalId: null, name: 'Paneer', quantity: 100, unit: 'g' }],
      [row({ canonicalId: null, displayName: 'paneer' })],
    );
    expect(plan.deductions).toHaveLength(1);
  });
});

/* -------------------------------- servings -------------------------------- */

describe('scaling by servings', () => {
  it('multiplies every line', () => {
    const plan = planDeduction([need({ quantity: 200 })], [row({ quantity: 1000 })], 2);
    expect(plan.deductions[0]?.quantity).toBe(400);
  });

  it('handles a fractional multiplier without floating point crumbs', () => {
    const plan = planDeduction([need({ quantity: 100 })], [row({ quantity: 1000 })], 0.5);
    expect(plan.deductions[0]?.quantity).toBe(50);
    // 0.1 + 0.2 style residue must not survive into the database.
    const third = planDeduction([need({ quantity: 10 })], [row({ quantity: 100 })], 1 / 3);
    expect(String(third.deductions[0]?.quantity).length).toBeLessThan(10);
  });
});

/* ------------------------------ approval card ----------------------------- */

describe('the text shown before approval', () => {
  it('names every change in plain language', () => {
    const plan = planDeduction(
      [need({ quantity: 1000 }), need({ canonicalId: 'ghee', name: 'ghee', quantity: 2, unit: 'tbsp' })],
      [row({ quantity: 1000 })],
    );
    const lines = describePlan(plan);
    expect(lines[0]).toBe('paneer: 1000 g (all of it)');
    expect(lines[1]).toContain('ghee');
    expect(lines[1]).toContain('not in your pantry');
  });

  it('explains an incompatible unit without jargon', () => {
    const plan = planDeduction(
      [{ canonicalId: 'coriander_leaves', name: 'coriander', quantity: 20, unit: 'g' }],
      [row({ canonicalId: 'coriander_leaves', displayName: 'coriander', quantity: 1, unit: 'bunch' })],
    );
    expect(describePlan(plan)[0]).toContain('measures this differently');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describePlan(planDeduction([], []))).toEqual([]);
  });
});
