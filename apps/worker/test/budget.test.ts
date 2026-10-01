import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BudgetStatus } from '../src/budget/policy.js';
import type { ReserveResult } from '../src/durable-objects.js';

/**
 * Durable Object tests for BudgetKeeper.
 *
 * The arithmetic, the window boundaries and the expiry rules are covered
 * exhaustively in src/budget/policy.test.ts, which needs no runtime. What can
 * only be tested here is the part the pure functions cannot see: that the
 * ledger actually persists across calls, that reserve-then-commit replaces the
 * estimate rather than adding to it, and that the route is behind a session.
 */

const ORIGIN = 'http://example.com';
const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface Keeper {
  reserve(req: {
    userId: string;
    pool?: 'user' | 'viral';
    estimate: number;
    isDemo?: boolean;
    ttlMs?: number;
  }): Promise<ReserveResult>;
  commit(
    id: string,
    call: { model: string; usage: { promptTokens: number; completionTokens: number } },
  ): Promise<{ neurons: number; reservationFound: boolean }>;
  release(id: string): Promise<{ released: boolean }>;
  status(userId: string, isDemo?: boolean): Promise<BudgetStatus>;
}

/** A fresh instance per test, so one test's ledger cannot decide another's. */
function keeper(name: string): Keeper {
  return env.BUDGET_KEEPER.get(env.BUDGET_KEEPER.idFromName(name)) as unknown as Keeper;
}

let n = 0;
const freshName = () => `budget-test-${(n += 1)}-${crypto.randomUUID()}`;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM demo_signups'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('reserve then commit', () => {
  it('persists a reservation and counts it before any call is made', async () => {
    const k = keeper(freshName());
    const res = await k.reserve({ userId: 'u1', estimate: 500 });
    expect(res.ok).toBe(true);

    const status = await k.status('u1');
    // The estimate is held immediately — that is the whole point of reserving.
    expect(status.user.used).toBe(500);
    expect(status.user.left).toBe(1_500);
  });

  it('replaces the estimate with the real cost on commit, rather than adding', async () => {
    const k = keeper(freshName());
    const res = (await k.reserve({ userId: 'u1', estimate: 500 })) as {
      ok: true;
      reservationId: string;
    };

    // One chat turn's real usage, measured in spike 4: ~71.6 neurons.
    const committed = await k.commit(res.reservationId, {
      model: LLAMA,
      usage: { promptTokens: 2_392, completionTokens: 40 },
    });
    expect(committed.reservationFound).toBe(true);
    expect(committed.neurons).toBeGreaterThan(70);
    expect(committed.neurons).toBeLessThan(74);

    const status = await k.status('u1');
    // 71.6, not 571.6. A ledger that added would double-charge every call.
    expect(status.user.used).toBeGreaterThan(70);
    expect(status.user.used).toBeLessThan(74);
  });

  it('records a commit whose reservation is unknown, rather than losing the spend', async () => {
    const k = keeper(freshName());
    const committed = await k.commit('never-existed', {
      model: LLAMA,
      usage: { promptTokens: 2_392, completionTokens: 40 },
    });
    expect(committed.reservationFound).toBe(false);

    // The neurons left Cloudflare's side either way, so the ledger must show
    // them. Dropping them is how an account quietly overruns.
    const status = await k.status('unknown');
    expect(status.account.used).toBeGreaterThan(70);
  });

  it('charges a retried commit once, not twice', async () => {
    // A Workflow step that commits and then fails is retried, and commits
    // again under the same id. The second must update, not add.
    const k = keeper(freshName());
    const usage = { promptTokens: 2_392, completionTokens: 40 };
    await k.commit('run-1:filter', { model: LLAMA, usage });
    const again = await k.commit('run-1:filter', { model: LLAMA, usage });
    expect(again.reservationFound).toBe(true);

    const used = (await k.status('unknown')).account.used;
    expect(used).toBeGreaterThan(70);
    expect(used).toBeLessThan(74);
  });

  it('lets a long run hold its reservation longer, but not indefinitely', async () => {
    const name = freshName();
    const k = keeper(name);
    const before = Date.now();
    const held = (await k.reserve({ userId: 'u1', estimate: 100, ttlMs: 30 * 60 * 1000 })) as {
      ok: true;
      reservationId: string;
    };
    const forever = (await k.reserve({ userId: 'u1', estimate: 100, ttlMs: 7 * 86_400_000 })) as {
      ok: true;
      reservationId: string;
    };

    const stub = env.BUDGET_KEEPER.get(env.BUDGET_KEEPER.idFromName(name));
    await runInDurableObject(stub, async (_instance, state) => {
      const expiry = (id: string) =>
        (state.storage.sql.exec('SELECT expires_at FROM ledger WHERE id = ?', id).toArray()[0] as {
          expires_at: number;
        }).expires_at;
      expect(expiry(held.reservationId) - before).toBeGreaterThanOrEqual(30 * 60 * 1000);
      // Capped at two hours, so a run that died still lets go of the pool.
      expect(expiry(forever.reservationId) - before).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5_000);
    });
  });

  it('release gives the budget back', async () => {
    const k = keeper(freshName());
    const res = (await k.reserve({ userId: 'u1', estimate: 900 })) as {
      ok: true;
      reservationId: string;
    };
    expect((await k.status('u1')).user.used).toBe(900);

    expect((await k.release(res.reservationId)).released).toBe(true);
    expect((await k.status('u1')).user.used).toBe(0);

    // Releasing twice is not an error, but only the first does anything.
    expect((await k.release(res.reservationId)).released).toBe(false);
  });

  it('refuses once a user is at their cap, and says which limit bit', async () => {
    const k = keeper(freshName());
    await k.reserve({ userId: 'u1', estimate: 2_000 });

    const denied = await k.reserve({ userId: 'u1', estimate: 1 });
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe('user_cap');

    // Another user is unaffected.
    expect((await k.reserve({ userId: 'u2', estimate: 100 })).ok).toBe(true);
  });

  it('holds demo users to the smaller cap', async () => {
    const k = keeper(freshName());
    expect((await k.reserve({ userId: 'd1', estimate: 1_500, isDemo: true })).ok).toBe(true);
    const denied = await k.reserve({ userId: 'd1', estimate: 1, isDemo: true });
    expect(denied.ok === false && denied.reason).toBe('user_cap');
  });

  it('keeps a ledger across separate calls to the same instance', async () => {
    const name = freshName();
    await keeper(name).reserve({ userId: 'u1', estimate: 300 });
    await keeper(name).reserve({ userId: 'u1', estimate: 200 });
    // Fetched fresh each time, so this only passes if storage persisted.
    expect((await keeper(name).status('u1')).user.used).toBe(500);
  });

  it('isolates one instance from another', async () => {
    const a = keeper(freshName());
    const b = keeper(freshName());
    await a.reserve({ userId: 'u1', estimate: 700 });
    expect((await b.status('u1')).user.used).toBe(0);
  });
});

describe('viral pool through the Durable Object', () => {
  it('follows the Sunday rule the policy defines', async () => {
    const k = keeper(freshName());
    const res = await k.reserve({ userId: 'system:viral', pool: 'viral', estimate: 2_500 });

    // The pool is Sundays only, and the test cannot move the clock across the
    // RPC boundary — so assert the two possible outcomes rather than guessing.
    // The day-dependent branches themselves are covered exhaustively in
    // policy.test.ts, where `now` is an argument.
    if (new Date().getUTCDay() === 0) {
      expect(res.ok).toBe(true);
    } else {
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.reason).toBe('viral_not_sunday');
    }
  });
});

describe('GET /api/budget', () => {
  it('401s without a session', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/budget`)).status).toBe(401);
  });

  it('reports the caller and the account in the section 11 shape', async () => {
    const demo = await SELF.fetch(`${ORIGIN}/auth/demo`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-connecting-ip': '198.51.100.90' },
    });
    const cookie = demo.headers
      .getSetCookie()
      .find((h) => h.startsWith('wsc_session='))
      ?.split(';')[0] as string;

    const res = await SELF.fetch(`${ORIGIN}/api/budget`, { headers: { cookie } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as BudgetStatus;
    expect(body.user.limit).toBe(1_500); // demo cap
    expect(body.account.limit).toBe(9_000); // 10,000 less the safety margin
    expect(body.user.left).toBe(1_500);
    expect(Date.parse(body.resetsAt)).toBeGreaterThan(Date.now());
    // resetsAt is the next UTC midnight, which is when the user cap resets.
    expect(body.resetsAt).toMatch(/T00:00:00\.000Z$/);
  });
});
