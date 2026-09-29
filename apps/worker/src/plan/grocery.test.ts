import type { PlanDay } from '@cooked/shared';
import { describe, expect, it } from 'vitest';
import { TAXONOMY, item, meal, ri } from './fixtures.js';
import { groceryDiff } from './grocery.js';

/**
 * F9: "Generated from the plan as ingredients needed minus pantry; items can
 * be checked off."
 *
 * The arithmetic is where this goes wrong quietly. A unit conversion that
 * silently fails, or a pantry item that fails to cancel, sends someone to a
 * shop for something already in the fridge — or worse, leaves them without
 * an ingredient halfway through Wednesday's dinner.
 */

const day = (date: string, meals: ReturnType<typeof meal>[]): PlanDay => ({ date, meals });

const names = (diff: ReturnType<typeof groceryDiff>): string[] =>
  diff.lines.map((l) => l.name);

describe('what the plan needs', () => {
  it('lists an ingredient the pantry does not have', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })])];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.lines).toHaveLength(1);
    expect(diff.lines[0]).toMatchObject({ canonicalId: 'paneer', quantity: 200, unit: 'g' });
  });

  it('adds up the same ingredient across days', () => {
    const plan = [
      day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })]),
      day('2026-09-29', [meal({ ingredients: [ri('paneer', 'paneer', 150, 'g')] })]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.lines).toHaveLength(1);
    expect(diff.lines[0]?.quantity).toBe(350);
  });

  it('converts before adding, rather than listing the same thing twice', () => {
    const plan = [
      day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 1, 'kg')] })]),
      day('2026-09-29', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.lines).toHaveLength(1);
    // Whichever unit it settles on, the total has to be 1.2kg of paneer.
    const line = diff.lines[0];
    const grams = line?.unit === 'kg' ? (line.quantity ?? 0) * 1000 : (line?.quantity ?? 0);
    expect(grams).toBeCloseTo(1200, 6);
  });

  it('keeps units it cannot convert between as separate lines', () => {
    // A bunch of coriander is not a number of grams, and inventing a factor
    // is how a list ends up confidently wrong.
    const plan = [
      day('2026-09-28', [
        meal({
          ingredients: [ri('dhaniya', 'coriander', 1, 'bunch'), ri('dhaniya', 'coriander', 20, 'g')],
        }),
      ]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.lines).toHaveLength(2);
    expect(diff.lines.map((l) => l.unit).sort()).toEqual(['bunch', 'g']);
  });
});

describe('what the pantry already covers', () => {
  it('drops an ingredient the pantry fully covers', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })])];
    const pantry = [item({ canonicalId: 'paneer', quantity: 500, unit: 'g', expiresAt: null })];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines).toHaveLength(0);
  });

  it('asks only for the shortfall', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 500, 'g')] })])];
    const pantry = [item({ canonicalId: 'paneer', quantity: 200, unit: 'g', expiresAt: null })];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines[0]?.quantity).toBeCloseTo(300, 6);
  });

  it('cancels across units', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })])];
    const pantry = [item({ canonicalId: 'paneer', quantity: 1, unit: 'kg', expiresAt: null })];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines).toHaveLength(0);
  });

  it('ignores stock that will have gone off before the week starts', () => {
    // Counting it would be the worst kind of wrong: the list looks complete
    // and the spinach is compost by Monday.
    const plan = [day('2026-10-05', [meal({ ingredients: [ri('palak', 'spinach', 1, 'bunch')] })])];
    const pantry = [
      item({ canonicalId: 'palak', quantity: 2, unit: 'bunch', expiresAt: '2026-09-29T00:00:00.000Z' }),
    ];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines).toHaveLength(1);
  });

  it('ignores stock that was thrown away', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })])];
    const pantry = [
      item({
        canonicalId: 'paneer',
        quantity: 500,
        unit: 'g',
        expiresAt: null,
        deletedAt: '2026-09-27T00:00:00.000Z',
      }),
    ];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines).toHaveLength(1);
  });
});

describe('things that cannot be counted', () => {
  it('lists salt to taste apart rather than dropping or inventing it', () => {
    const plan = [
      day('2026-09-28', [
        meal({
          ingredients: [ri('table_salt', 'salt', 1, 'to_taste'), ri('paneer', 'paneer', 200, 'g')],
        }),
      ]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.unquantified).toContain('salt');
    expect(names(diff)).toEqual(['paneer']);
  });

  it('treats a line with no amount the same way', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('tomato', 'tomato', null, null)] })])];
    expect(groceryDiff(plan, [], TAXONOMY).unquantified).toContain('tomato');
  });

  it('does not repeat an unquantified ingredient that appears twice', () => {
    const plan = [
      day('2026-09-28', [meal({ ingredients: [ri('table_salt', 'salt', 1, 'to_taste')] })]),
      day('2026-09-29', [meal({ ingredients: [ri('table_salt', 'salt', 1, 'to_taste')] })]),
    ];
    expect(groceryDiff(plan, [], TAXONOMY).unquantified).toEqual(['salt']);
  });
});

describe('the shape the screen renders', () => {
  it('groups by aisle, produce before grains', () => {
    // F9 asks for aisle-style grouping, and the grocery screen renders the
    // order it is given rather than re-sorting.
    const plan = [
      day('2026-09-28', [
        meal({
          ingredients: [
            ri('rice', 'basmati rice', 500, 'g'),
            ri('tomato', 'tomato', 4, 'piece'),
            ri('paneer', 'paneer', 200, 'g'),
          ],
        }),
      ]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(diff.lines.map((l) => l.category)).toEqual(['produce', 'dairy', 'grains']);
  });

  it('carries the taxonomy category so the screen need not look it up', () => {
    const plan = [day('2026-09-28', [meal({ ingredients: [ri('paneer', 'paneer', 200, 'g')] })])];
    expect(groceryDiff(plan, [], TAXONOMY).lines[0]?.category).toBe('dairy');
  });

  it('resolves an ingredient named but not identified', () => {
    // A generated recipe can arrive with a null canonical id and a plain
    // name; the list should still know it is the same paneer.
    const plan = [day('2026-09-28', [meal({ ingredients: [ri(null, 'paneer', 200, 'g')] })])];
    const pantry = [item({ canonicalId: 'paneer', quantity: 500, unit: 'g', expiresAt: null })];

    expect(groceryDiff(plan, pantry, TAXONOMY).lines).toHaveLength(0);
  });

  it('keeps an unknown ingredient rather than silently dropping it', () => {
    const plan = [
      day('2026-09-28', [meal({ ingredients: [ri(null, 'house special paste', 1, 'tbsp')] })]),
    ];
    const diff = groceryDiff(plan, [], TAXONOMY);

    expect(names(diff)).toEqual(['house special paste']);
    expect(diff.lines[0]?.canonicalId).toBeNull();
  });

  it('returns nothing for an empty plan', () => {
    expect(groceryDiff([], [], TAXONOMY)).toEqual({ lines: [], unquantified: [] });
  });
});
