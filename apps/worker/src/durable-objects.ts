import { DurableObject } from 'cloudflare:workers';
import {
  type BudgetStatus,
  type DenyReason,
  type LedgerEntry,
  type Pool,
  RESERVATION_TTL_MS,
  decide,
  expired,
  statusFor,
} from './budget/policy.js';
import { type TokenUsage, neuronsFor, rateFor } from './budget/rates.js';
import type { Env } from './env.js';

/**
 * The two Durable Object classes from section 3.
 *
 * `KitchenAgent` is re-exported from ./agent/kitchen-agent.ts, which owns the
 * per-user SQLite and the section 5 pantry tools. It lives in its own file
 * because it is the largest class in the app; wrangler.jsonc binds the name,
 * not the location.
 */
export { KitchenAgent } from './agent/kitchen-agent.js';

export type ReserveResult =
  | { ok: true; reservationId: string; estimate: number }
  | { ok: false; reason: DenyReason; message: string; left: number };

interface LedgerRow {
  id: string;
  user_id: string;
  pool: string;
  neurons: number;
  state: string;
  created_at: number;
  expires_at: number | null;
}

/**
 * Single global instance. The Workers AI ledger from section 12.
 *
 * One instance for the whole account is the design, not an oversight: the
 * account limit is global, so the ledger must be too. A Durable Object gives
 * single-threaded access to it, which is what makes reserve-then-commit
 * race-free — two callers cannot both read "room for 900" and both proceed.
 *
 * All policy lives in `budget/policy.ts` as pure functions. This class is
 * storage and plumbing, so the arithmetic is testable without workerd.
 */
export class BudgetKeeper extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Blocking so no request can observe a half-built schema.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS ledger (' +
          'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pool TEXT NOT NULL, ' +
          'neurons REAL NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
          'expires_at INTEGER)',
      );
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger (created_at)');
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, created_at)',
      );
    });
  }

  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * Rows that can still affect a decision: anything inside the rolling window
   * or today, whichever reaches back further. Older rows are dropped here so
   * the table cannot grow without bound.
   */
  private load(now: number): LedgerEntry[] {
    const horizon = now - 25 * 60 * 60 * 1000;
    this.ctx.storage.sql.exec('DELETE FROM ledger WHERE created_at < ?', horizon);
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM ledger WHERE created_at >= ?', horizon)
      .toArray() as unknown as LedgerRow[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      pool: r.pool as Pool,
      neurons: r.neurons,
      state: r.state as LedgerEntry['state'],
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  /**
   * Expiry is lazy: reservations are swept whenever the ledger is read, not by
   * an alarm. Nothing can observe a stale reservation without first going
   * through a read, so an alarm would add a moving part and change no outcome.
   */
  private sweep(entries: LedgerEntry[], now: number): LedgerEntry[] {
    const dead = expired(entries, now);
    for (const e of dead) this.ctx.storage.sql.exec('DELETE FROM ledger WHERE id = ?', e.id);
    const dropped = new Set(dead.map((e) => e.id));
    return entries.filter((e) => !dropped.has(e.id));
  }

  /** Reserve an estimate before making the AI call. */
  async reserve(req: {
    userId: string;
    pool?: Pool;
    estimate: number;
    isDemo?: boolean;
  }): Promise<ReserveResult> {
    const now = Date.now();
    const entries = this.sweep(this.load(now), now);
    const request = {
      userId: req.userId,
      pool: req.pool ?? ('user' as Pool),
      estimate: req.estimate,
      isDemo: req.isDemo ?? false,
    };

    const decision = decide(request, entries, now);
    if (!decision.ok) return decision;

    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO ledger (id, user_id, pool, neurons, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      request.userId,
      request.pool,
      request.estimate,
      'reserved',
      now,
      now + RESERVATION_TTL_MS,
    );
    return { ok: true, reservationId: id, estimate: request.estimate };
  }

  /**
   * Replace the estimate with the real cost, from the token counts the model
   * returned.
   *
   * A commit against an expired or unknown reservation is still recorded, as a
   * committed row. The neurons were spent either way; dropping them because the
   * bookkeeping lapsed would understate the ledger and let the account overrun,
   * which is the one thing it exists to prevent.
   */
  async commit(
    reservationId: string,
    call: { model: string; usage: TokenUsage; userId?: string; pool?: Pool },
  ): Promise<{ neurons: number; reservationFound: boolean }> {
    const now = Date.now();
    const neurons = neuronsFor(call.model, call.usage);

    const found = this.ctx.storage.sql
      .exec('SELECT user_id FROM ledger WHERE id = ?', reservationId)
      .toArray();

    if (found.length > 0) {
      this.ctx.storage.sql.exec(
        "UPDATE ledger SET neurons = ?, state = 'committed', expires_at = NULL WHERE id = ?",
        neurons,
        reservationId,
      );
      return { neurons, reservationFound: true };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO ledger (id, user_id, pool, neurons, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'committed', ?, NULL)",
      crypto.randomUUID(),
      call.userId ?? 'unknown',
      call.pool ?? 'user',
      neurons,
      now,
    );
    return { neurons, reservationFound: false };
  }

  /** Give back a reservation whose call never happened. */
  async release(reservationId: string): Promise<{ released: boolean }> {
    const before = this.ctx.storage.sql
      .exec("SELECT id FROM ledger WHERE id = ? AND state = 'reserved'", reservationId)
      .toArray();
    this.ctx.storage.sql.exec(
      "DELETE FROM ledger WHERE id = ? AND state = 'reserved'",
      reservationId,
    );
    return { released: before.length > 0 };
  }

  /** Backs `GET /api/budget` (section 11). */
  async status(userId: string, isDemo = false): Promise<BudgetStatus> {
    const now = Date.now();
    const entries = this.sweep(this.load(now), now);
    return statusFor(entries, now, userId, isDemo);
  }

  /** What a call would cost, without spending anything. */
  async quote(model: string, usage: TokenUsage): Promise<{ neurons: number; source: string }> {
    return { neurons: neuronsFor(model, usage), source: rateFor(model).source };
  }
}
