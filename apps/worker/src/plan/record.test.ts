import { describe, expect, it } from 'vitest';
import { meal } from './fixtures.js';
import {
  ALL_SLOTS,
  emptyPlan,
  groceryRows,
  parseStoredPlan,
  recordFromOutcome,
  todayIn,
  viewStatus,
} from './record.js';

/**
 * The stored plan record and its two mappings. Small, but both sit on the
 * boundary between what the agent's `plans` row allows and what section 11
 * promises the screen, which is where a wrong guess goes unnoticed longest.
 */

describe('viewStatus', () => {
  it("maps the row's states onto section 11's", () => {
    expect(viewStatus('generating')).toBe('running');
    expect(viewStatus('ready')).toBe('ready');
    expect(viewStatus('failed')).toBe('failed');
  });

  it('shows a plan with a hole in it as ready, not as a fifth status', () => {
    // The hole is reported by `complete` and `unfilled`; the shared schema
    // has no `partial`, and the screen should not have to learn one.
    expect(viewStatus('partial')).toBe('ready');
  });
});

describe('parseStoredPlan', () => {
  it('round-trips a stored plan', () => {
    const plan = { ...emptyPlan(['dinner'], ['korean']), catalogOnly: true };
    expect(parseStoredPlan(JSON.stringify(plan))).toEqual(plan);
  });

  it("reads the column's default and broken JSON as an empty plan", () => {
    // `plans.plan` defaults to '{}', and a row a failed write left behind
    // must still render rather than take the screen down.
    expect(parseStoredPlan('{}')).toEqual(emptyPlan(ALL_SLOTS, []));
    expect(parseStoredPlan('not json')).toEqual(emptyPlan(ALL_SLOTS, []));
  });
});

describe('recordFromOutcome', () => {
  const base = emptyPlan(['dinner'], []);
  const days = [{ date: '2026-09-28', meals: [meal({ title: 'Dal tadka' })] }];

  it('stores a complete outcome as ready', () => {
    const r = recordFromOutcome(
      base,
      { status: 'complete', days, unfilled: [], repeated: [], dropped: [] },
      false,
    );
    expect(r.status).toBe('ready');
    expect(r.plan.days).toEqual(days);
    expect(r.plan.error).toBeNull();
  });

  it('stores a plan with open slots as partial, and keeps the slots it could not fill', () => {
    const gap = { date: '2026-09-29', slot: 'dinner' as const, reason: 'nothing safe' };
    const r = recordFromOutcome(
      base,
      { status: 'partial', days, unfilled: [gap], repeated: [], dropped: [] },
      true,
    );
    expect(r.status).toBe('partial');
    expect(r.plan.unfilled).toEqual([gap]);
    expect(r.plan.catalogOnly).toBe(true);
  });

  it('lists each removed dish once, however many slots it was offered for', () => {
    const peanut = { title: 'Peanut noodles', reason: 'Contains peanuts.' };
    const r = recordFromOutcome(
      base,
      {
        status: 'complete',
        days,
        unfilled: [],
        repeated: [],
        dropped: [peanut, { ...peanut, title: 'peanut noodles ' }],
      },
      false,
    );
    expect(r.plan.dropped).toEqual([peanut]);
  });
});

describe('groceryRows', () => {
  it('keeps uncounted lines on the list without inventing an amount', () => {
    const rows = groceryRows({
      lines: [{ canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', category: 'dairy' }],
      unquantified: ['salt'],
    });
    expect(rows).toEqual([
      { canonicalId: 'paneer', displayName: 'paneer', category: 'dairy', quantity: 200, unit: 'g' },
      { canonicalId: null, displayName: 'salt', category: 'other', quantity: null, unit: null },
    ]);
  });
});

describe('todayIn', () => {
  // 2026-09-28 20:30 UTC: already Tuesday in Sydney, still Monday in New York.
  const at = Date.parse('2026-09-28T20:30:00Z');

  it("starts the week on the user's own date, not UTC's", () => {
    expect(todayIn('Australia/Sydney', at)).toBe('2026-09-29');
    expect(todayIn('America/New_York', at)).toBe('2026-09-28');
    expect(todayIn('UTC', at)).toBe('2026-09-28');
  });

  it('falls back to the UTC date for a zone it does not know', () => {
    expect(todayIn('Mars/Olympus_Mons', at)).toBe('2026-09-28');
  });
});
