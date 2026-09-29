import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_LIMIT,
  COMBINED_USERS_SUNDAY,
  COMBINED_USERS_WEEKDAY,
  DEMO_USER_CAP,
  type LedgerEntry,
  RESERVATION_TTL_MS,
  SAFETY_MARGIN,
  SIGNED_IN_USER_CAP,
  VIRAL_POOL,
  VIRAL_USER_ID,
  allocatableAccount,
  decide,
  expired,
  isSundayUtc,
  live,
  nextUtcMidnight,
  statusFor,
  summarise,
  utcDayStart,
} from './policy.js';

/**
 * Pure-function tests for section 12. No Durable Object and no clock: `now` is
 * a parameter everywhere, so every window boundary can be tested exactly
 * rather than approximately.
 */

// 2026-09-23T12:00:00Z is a Wednesday. 2026-09-27T12:00:00Z is a Sunday.
const WED = Date.parse('2026-09-23T12:00:00Z');
const SUN = Date.parse('2026-09-27T12:00:00Z');

let seq = 0;
function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: 'u1',
    pool: 'user',
    neurons: 100,
    state: 'committed',
    createdAt: WED,
    expiresAt: null,
    ...over,
  };
}

const req = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  userId: 'u1',
  pool: 'user' as const,
  estimate: 100,
  isDemo: false,
  ...over,
});

/* --------------------------------- windows -------------------------------- */

describe('windows', () => {
  it('starts the UTC day at midnight regardless of local time', () => {
    expect(new Date(utcDayStart(WED)).toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(new Date(nextUtcMidnight(WED)).toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('identifies Sunday in UTC, not locally', () => {
    expect(isSundayUtc(SUN)).toBe(true);
    expect(isSundayUtc(WED)).toBe(false);
    // 23:30 Saturday UTC is still Saturday even where it is already Sunday.
    expect(isSundayUtc(Date.parse('2026-09-26T23:30:00Z'))).toBe(false);
    expect(isSundayUtc(Date.parse('2026-09-27T00:00:00Z'))).toBe(true);
  });
});

/* -------------------------------- expiry ---------------------------------- */

describe('reservation expiry', () => {
  it('treats a reservation as live until exactly its TTL', () => {
    const made = WED;
    const r = entry({ state: 'reserved', createdAt: made, expiresAt: made + RESERVATION_TTL_MS });

    expect(live([r], made).length).toBe(1);
    expect(live([r], made + RESERVATION_TTL_MS - 1).length).toBe(1);
    // Boundary: expiresAt is not in the future any more.
    expect(live([r], made + RESERVATION_TTL_MS).length).toBe(0);
    expect(expired([r], made + RESERVATION_TTL_MS).length).toBe(1);
  });

  it('never expires a committed entry', () => {
    const c = entry({ state: 'committed', createdAt: WED, expiresAt: null });
    expect(live([c], WED + 10 * RESERVATION_TTL_MS).length).toBe(1);
  });

  it('frees the budget an expired reservation was holding', () => {
    const made = WED;
    const hog = entry({
      neurons: SIGNED_IN_USER_CAP,
      state: 'reserved',
      createdAt: made,
      expiresAt: made + RESERVATION_TTL_MS,
    });

    // While it is live the user has nothing left.
    expect(decide(req({ estimate: 1 }), [hog], made).ok).toBe(false);
    // Five minutes later the caller is presumed dead and the budget returns.
    expect(decide(req({ estimate: 1 }), [hog], made + RESERVATION_TTL_MS).ok).toBe(true);
  });

  it('counts a live reservation against the cap, not just committed spend', () => {
    // The race reserve-then-commit exists to prevent: two callers each seeing
    // room because neither has committed yet.
    const pending = entry({
      neurons: 1_950,
      state: 'reserved',
      createdAt: WED,
      expiresAt: WED + RESERVATION_TTL_MS,
    });
    const d = decide(req({ estimate: 100 }), [pending], WED);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('user_cap');
  });
});

/* --------------------------------- maths ---------------------------------- */

describe('usage arithmetic', () => {
  it('separates the rolling window from the UTC day', () => {
    const entries = [
      // 20 hours ago: inside the rolling window, but yesterday.
      entry({ neurons: 500, createdAt: WED - 20 * 3_600_000 }),
      // Today.
      entry({ neurons: 300, createdAt: WED - 1 * 3_600_000 }),
    ];
    const u = summarise(entries, WED, 'u1');
    expect(u.accountRolling).toBe(800);
    expect(u.accountToday).toBe(300);
    expect(u.userToday).toBe(300);
  });

  it('drops spend older than 24 hours from the rolling total', () => {
    const old = entry({ neurons: 9_000, createdAt: WED - 25 * 3_600_000 });
    expect(summarise([old], WED, 'u1').accountRolling).toBe(0);
  });

  it('attributes per-user spend only to that user', () => {
    const entries = [entry({ userId: 'u1', neurons: 100 }), entry({ userId: 'u2', neurons: 700 })];
    expect(summarise(entries, WED, 'u1').userToday).toBe(100);
    expect(summarise(entries, WED, 'u2').userToday).toBe(700);
    expect(summarise(entries, WED, 'u1').usersToday).toBe(800);
  });

  it('keeps viral spend out of the combined user pool', () => {
    const entries = [
      entry({ userId: VIRAL_USER_ID, pool: 'viral', neurons: 2_500, createdAt: SUN }),
      entry({ userId: 'u1', neurons: 100, createdAt: SUN }),
    ];
    const u = summarise(entries, SUN, 'u1');
    expect(u.viralToday).toBe(2_500);
    expect(u.usersToday).toBe(100);
    expect(u.accountToday).toBe(2_600);
  });
});

/* ------------------------------- account cap ------------------------------ */

describe('account ceiling', () => {
  it('never allocates the safety margin', () => {
    expect(allocatableAccount()).toBe(ACCOUNT_LIMIT - SAFETY_MARGIN);
    expect(allocatableAccount()).toBe(9_000);
  });

  it('refuses once the rolling window is full, even on a fresh UTC day', () => {
    // The failure measured on 2026-09-23: spend from yesterday afternoon still
    // blocks this morning, because Cloudflare's window is rolling.
    const yesterdayAfternoon = entry({
      userId: 'u9',
      neurons: 9_000,
      createdAt: Date.parse('2026-09-23T15:00:00Z'),
    });
    const nextMorning = Date.parse('2026-09-24T05:00:00Z');

    // A UTC-day counter would say zero spent today and wave this through.
    expect(summarise([yesterdayAfternoon], nextMorning, 'u1').accountToday).toBe(0);

    const d = decide(req({ estimate: 100 }), [yesterdayAfternoon], nextMorning);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('account_rolling');
  });

  it('lets the same spend through once it ages out of the window', () => {
    const old = entry({ userId: 'u9', neurons: 9_000, createdAt: Date.parse('2026-09-23T15:00:00Z') });
    const afterAging = Date.parse('2026-09-24T15:01:00Z');
    expect(decide(req({ estimate: 100 }), [old], afterAging).ok).toBe(true);
  });
});

/* -------------------------------- user caps ------------------------------- */

describe('per-user caps', () => {
  it('allows a signed-in user up to 2,000 and refuses the next neuron', () => {
    const spent = entry({ neurons: SIGNED_IN_USER_CAP - 50 });
    expect(decide(req({ estimate: 50 }), [spent], WED).ok).toBe(true);
    expect(decide(req({ estimate: 51 }), [spent], WED).ok).toBe(false);
  });

  it('holds demo users to 800', () => {
    const spent = entry({ neurons: DEMO_USER_CAP - 10 });
    expect(decide(req({ estimate: 10, isDemo: true }), [spent], WED).ok).toBe(true);
    expect(decide(req({ estimate: 11, isDemo: true }), [spent], WED).ok).toBe(false);
    // The same spend is fine for a signed-in user.
    expect(decide(req({ estimate: 11, isDemo: false }), [spent], WED).ok).toBe(true);
  });

  it('resets the user cap at 00:00 UTC', () => {
    const spent = entry({ neurons: SIGNED_IN_USER_CAP, createdAt: Date.parse('2026-09-23T23:00:00Z') });
    const beforeMidnight = Date.parse('2026-09-23T23:59:00Z');
    const afterMidnight = Date.parse('2026-09-24T00:01:00Z');

    expect(decide(req({ estimate: 10 }), [spent], beforeMidnight).ok).toBe(false);
    // The account's rolling total still counts it; the user's daily cap does not.
    expect(decide(req({ estimate: 10 }), [spent], afterMidnight).ok).toBe(true);
    expect(summarise([spent], afterMidnight, 'u1').accountRolling).toBe(SIGNED_IN_USER_CAP);
  });

  it('stops one user starving the rest through the combined pool', () => {
    const others = [
      entry({ userId: 'a', neurons: COMBINED_USERS_WEEKDAY - 20 }),
    ];
    const d = decide(req({ userId: 'fresh', estimate: 100 }), others, WED);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('combined_users');
  });
});

/* -------------------------- Sunday viral pipeline ------------------------- */

describe('viral pipeline pool', () => {
  const viralReq = (estimate: number) =>
    req({ userId: VIRAL_USER_ID, pool: 'viral' as const, estimate });

  it('reserves the full 2,500 on a Sunday', () => {
    const d = decide(viralReq(VIRAL_POOL), [], SUN);
    expect(d.ok).toBe(true);
  });

  it('refuses the pipeline on any other day', () => {
    const d = decide(viralReq(VIRAL_POOL), [], WED);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('viral_not_sunday');
  });

  it('refuses a second run once the Sunday pool is spent', () => {
    const firstRun = entry({
      userId: VIRAL_USER_ID,
      pool: 'viral',
      neurons: VIRAL_POOL,
      createdAt: SUN,
    });
    const d = decide(viralReq(1), [firstRun], SUN);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('viral_pool');
  });

  it('is not charged against the per-user or combined caps', () => {
    const pipeline = entry({
      userId: VIRAL_USER_ID,
      pool: 'viral',
      neurons: VIRAL_POOL,
      createdAt: SUN,
    });
    // A normal user is unaffected by the pipeline having run.
    expect(decide(req({ estimate: 100 }), [pipeline], SUN).ok).toBe(true);
  });

  it('still cannot exceed the account ceiling on a Sunday', () => {
    // 2,500 viral + 6,000 combined = 8,500, inside the 9,000 allocatable.
    // Push the rolling window to the ceiling and the pipeline is refused too.
    const nearlyFull = entry({ userId: 'u9', neurons: 8_950, createdAt: SUN });
    const d = decide(viralReq(VIRAL_POOL), [nearlyFull], SUN);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('account_rolling');
  });

  it('leaves the documented Sunday headroom for users', () => {
    expect(COMBINED_USERS_SUNDAY + VIRAL_POOL).toBeLessThanOrEqual(allocatableAccount());
  });
});

/* -------------------------------- bad input ------------------------------- */

describe('rejects nonsense estimates', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (estimate) => {
    const d = decide(req({ estimate }), [], WED);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe('invalid_estimate');
  });
});

/* --------------------------------- status --------------------------------- */

describe('status for GET /api/budget', () => {
  it('reports the user against the day and the account against the window', () => {
    const entries = [
      entry({ userId: 'u1', neurons: 300, createdAt: WED - 1 * 3_600_000 }),
      entry({ userId: 'u2', neurons: 500, createdAt: WED - 20 * 3_600_000 }),
    ];
    const s = statusFor(entries, WED, 'u1', false);

    expect(s.user).toEqual({ used: 300, limit: SIGNED_IN_USER_CAP, left: 1_700 });
    // u2's spend is yesterday, so it counts against the rolling account total
    // but not against today.
    expect(s.account).toEqual({ used: 800, limit: 9_000, left: 8_200 });
    expect(s.resetsAt).toBe('2026-09-24T00:00:00.000Z');
  });

  it('never reports a negative remainder', () => {
    const over = entry({ userId: 'u1', neurons: 99_999, createdAt: WED });
    const s = statusFor([over], WED, 'u1', false);
    expect(s.user.left).toBe(0);
    expect(s.account.left).toBe(0);
  });
});
