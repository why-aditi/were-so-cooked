/**
 * Budget policy from section 12, as pure functions over a ledger.
 *
 * No Durable Object, no storage, no clock — `now` is always a parameter. The
 * whole point is that the arithmetic and the expiry rules are testable without
 * workerd, because they are the part that has to be right.
 *
 * ── Two windows, deliberately ────────────────────────────────────────────
 *
 * The account ceiling uses a **rolling 24 hours**. Section 12 records why:
 * Cloudflare enforces a rolling window, not a calendar day. A UTC-midnight
 * counter would tell a user they had budget while every call returned
 * AiError 4006 — measured on 2026-09-23, when 50,583 neurons billed in one
 * hour still blocked calls the following morning after the "daily" reset.
 *
 * The per-user and per-pool caps use the **UTC day**, resetting at 00:00 UTC.
 * Those are our own fairness policy, not Cloudflare's limiter, and section 12
 * states them as "per day". A user who spends their 2,000 gets a fresh
 * allowance at midnight even though the account's rolling total has not moved.
 *
 * Mixing the two is not an inconsistency: one mirrors an external limiter we
 * do not control, the other is an internal allocation we do.
 */

export const ACCOUNT_LIMIT = 10_000;
/** Never allocated to anyone (section 12). */
export const SAFETY_MARGIN = 1_000;
/** Reserved before the day's user traffic, Sundays only. */
export const VIRAL_POOL = 2_500;
export const SIGNED_IN_USER_CAP = 2_000;
export const DEMO_USER_CAP = 800;

/**
 * Section 12 states these explicitly as 8,500 and 6,000. The arithmetic does
 * not quite close — 10,000 less the 1,000 margin is 9,000, less 2,500 on a
 * Sunday is 6,500 — so the spec's figures are 500 more conservative than the
 * subtraction implies. Using the spec's numbers: a lower cap can only refuse a
 * call that would have fit, which is the safe direction to be wrong in.
 */
export const COMBINED_USERS_WEEKDAY = 8_500;
export const COMBINED_USERS_SUNDAY = 6_000;

/** Section 12: uncommitted reservations expire after 5 minutes. */
export const RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * The longest a caller may ask a reservation to live. A viral run holds its
 * pool across thirty extraction steps; two hours covers that with retries and
 * still lets go of the pool the same day if the run dies.
 */
export const MAX_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

export const VIRAL_USER_ID = 'system:viral';

export type Pool = 'user' | 'viral';
export type EntryState = 'reserved' | 'committed';

export interface LedgerEntry {
  id: string;
  userId: string;
  pool: Pool;
  neurons: number;
  state: EntryState;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; only set while `state` is `reserved`. */
  expiresAt: number | null;
}

export interface ReserveRequest {
  userId: string;
  pool: Pool;
  /** Best estimate of the call's cost, in neurons. */
  estimate: number;
  isDemo: boolean;
}

export type DenyReason =
  | 'account_rolling'
  | 'combined_users'
  | 'user_cap'
  | 'viral_not_sunday'
  | 'viral_pool'
  | 'invalid_estimate';

export type Decision =
  | { ok: true; estimate: number }
  | { ok: false; reason: DenyReason; message: string; left: number };

/* --------------------------------- windows -------------------------------- */

export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function nextUtcMidnight(now: number): number {
  return utcDayStart(now) + 24 * 60 * 60 * 1000;
}

export function rollingWindowStart(now: number): number {
  return now - 24 * 60 * 60 * 1000;
}

/** Sunday in UTC, which is when section 3's `30 0 * * 0` cron fires. */
export function isSundayUtc(now: number): boolean {
  return new Date(now).getUTCDay() === 0;
}

/* --------------------------------- ledger --------------------------------- */

/**
 * A reservation past its TTL never happened: the caller either crashed or the
 * AI call never completed, and holding its neurons hostage for the rest of the
 * day would strand budget nobody spent.
 */
export function isLive(entry: LedgerEntry, now: number): boolean {
  if (entry.state === 'committed') return true;
  return entry.expiresAt !== null && entry.expiresAt > now;
}

export function expired(entries: LedgerEntry[], now: number): LedgerEntry[] {
  return entries.filter((e) => !isLive(e, now));
}

export function live(entries: LedgerEntry[], now: number): LedgerEntry[] {
  return entries.filter((e) => isLive(e, now));
}

export interface Usage {
  /** What Cloudflare would count against the 10,000 limit right now. */
  accountRolling: number;
  /** Spend since 00:00 UTC, which is what the per-day caps measure. */
  accountToday: number;
  userToday: number;
  viralToday: number;
  /** Combined user-pool spend today, excluding the viral pipeline. */
  usersToday: number;
}

/**
 * Reservations count as spent. An optimistic ledger that only counted
 * committed entries would let a burst of concurrent callers each see room and
 * collectively blow the cap — the exact race reserve-then-commit exists to
 * prevent.
 */
export function summarise(entries: LedgerEntry[], now: number, userId: string): Usage {
  const active = live(entries, now);
  const dayStart = utcDayStart(now);
  const windowStart = rollingWindowStart(now);

  let accountRolling = 0;
  let accountToday = 0;
  let userToday = 0;
  let viralToday = 0;
  let usersToday = 0;

  for (const e of active) {
    if (e.createdAt > windowStart) accountRolling += e.neurons;
    if (e.createdAt >= dayStart) {
      accountToday += e.neurons;
      if (e.pool === 'viral') viralToday += e.neurons;
      else usersToday += e.neurons;
      if (e.userId === userId) userToday += e.neurons;
    }
  }

  return { accountRolling, accountToday, userToday, viralToday, usersToday };
}

/* -------------------------------- decision -------------------------------- */

export function userCap(isDemo: boolean): number {
  return isDemo ? DEMO_USER_CAP : SIGNED_IN_USER_CAP;
}

export function combinedUsersCap(now: number): number {
  return isSundayUtc(now) ? COMBINED_USERS_SUNDAY : COMBINED_USERS_WEEKDAY;
}

/** Everything the account may hand out, margin already removed. */
export function allocatableAccount(): number {
  return ACCOUNT_LIMIT - SAFETY_MARGIN;
}

/**
 * The whole gate. Checks run cheapest and most-binding first, and the first
 * failure is returned rather than a list — a caller only needs to know it
 * cannot spend, and which limit to report.
 */
export function decide(req: ReserveRequest, entries: LedgerEntry[], now: number): Decision {
  if (!Number.isFinite(req.estimate) || req.estimate <= 0) {
    return {
      ok: false,
      reason: 'invalid_estimate',
      message: 'A reservation needs a positive, finite estimate.',
      left: 0,
    };
  }

  const usage = summarise(entries, now, req.userId);

  // 1. The external limiter. Nothing below matters if Cloudflare will refuse.
  const accountLeft = allocatableAccount() - usage.accountRolling;
  if (req.estimate > accountLeft) {
    return {
      ok: false,
      reason: 'account_rolling',
      message: `The account has ${Math.max(0, Math.round(accountLeft))} neurons left in the rolling 24-hour window.`,
      left: Math.max(0, accountLeft),
    };
  }

  if (req.pool === 'viral') {
    // Section 12: 2,500 on Sundays only.
    if (!isSundayUtc(now)) {
      return {
        ok: false,
        reason: 'viral_not_sunday',
        message: 'The viral pipeline pool is only available on Sundays (UTC).',
        left: 0,
      };
    }
    const viralLeft = VIRAL_POOL - usage.viralToday;
    if (req.estimate > viralLeft) {
      return {
        ok: false,
        reason: 'viral_pool',
        message: `The viral pool has ${Math.max(0, Math.round(viralLeft))} neurons left today.`,
        left: Math.max(0, viralLeft),
      };
    }
    return { ok: true, estimate: req.estimate };
  }

  // 3. Per-user fairness, reset at 00:00 UTC.
  const perUserLeft = userCap(req.isDemo) - usage.userToday;
  if (req.estimate > perUserLeft) {
    return {
      ok: false,
      reason: 'user_cap',
      message: `You have ${Math.max(0, Math.round(perUserLeft))} neurons left today.`,
      left: Math.max(0, perUserLeft),
    };
  }

  // 4. All users combined, so one user cannot starve the rest on a Sunday.
  const combinedLeft = combinedUsersCap(now) - usage.usersToday;
  if (req.estimate > combinedLeft) {
    return {
      ok: false,
      reason: 'combined_users',
      message: `The shared user pool has ${Math.max(0, Math.round(combinedLeft))} neurons left today.`,
      left: Math.max(0, combinedLeft),
    };
  }

  return { ok: true, estimate: req.estimate };
}

/* --------------------------------- status --------------------------------- */

export interface BudgetStatus {
  user: { used: number; limit: number; left: number };
  account: { used: number; limit: number; left: number };
  resetsAt: string;
}

/**
 * Shapes section 11's `GET /api/budget`.
 *
 * `user` is the UTC-day cap; `account` is the rolling window, because that is
 * what actually refuses a call. The two therefore reset at different moments,
 * which is intentional and documented at the top of this file.
 */
export function statusFor(
  entries: LedgerEntry[],
  now: number,
  userId: string,
  isDemo: boolean,
): BudgetStatus {
  const usage = summarise(entries, now, userId);
  const uCap = userCap(isDemo);
  const aCap = allocatableAccount();
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    user: {
      used: round(usage.userToday),
      limit: uCap,
      left: round(Math.max(0, uCap - usage.userToday)),
    },
    account: {
      used: round(usage.accountRolling),
      limit: aCap,
      left: round(Math.max(0, aCap - usage.accountRolling)),
    },
    resetsAt: new Date(nextUtcMidnight(now)).toISOString(),
  };
}
