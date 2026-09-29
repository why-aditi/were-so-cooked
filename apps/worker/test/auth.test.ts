import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';

/**
 * Integration tests for section 9, running in workerd against real D1 and real
 * Durable Objects.
 *
 * The isolation test near the bottom is the one that matters most: it is the
 * only thing standing between a signed-in user and someone else's kitchen.
 */

const ORIGIN = 'http://example.com';

/** Extracts a Set-Cookie value so later requests can present it. */
function cookieFrom(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const [k, ...rest] = (pair ?? '').split('=');
    if (k === name && rest.join('=')) return `${name}=${rest.join('=')}`;
  }
  return null;
}

async function createDemoUser(ip = '198.51.100.1'): Promise<{ cookie: string; id: string }> {
  const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': ip },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = cookieFrom(res, 'wsc_session');
  expect(cookie).not.toBeNull();
  return { cookie: cookie as string, id: body.user.id };
}

beforeEach(async () => {
  // Isolated storage is per test file, not per test, so rate-limit rows from
  // one case would otherwise decide the outcome of the next.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM demo_signups'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

/* ------------------------------ demo accounts ----------------------------- */

describe('demo accounts', () => {
  it('creates a demo user with a 24-hour expiry and a session cookie', async () => {
    const before = Date.now();
    const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-connecting-ip': '198.51.100.2' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { user: { id: string; isDemo: boolean }; expiresAt: string };
    expect(body.user.isDemo).toBe(true);

    const ttlHours = (Date.parse(body.expiresAt) - before) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThan(24.1);

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('wsc_session='));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    // 30 days (section 9).
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);

    const row = await env.DB.prepare('SELECT is_demo, expires_at FROM users WHERE id = ?')
      .bind(body.user.id)
      .first<{ is_demo: number; expires_at: string }>();
    expect(row?.is_demo).toBe(1);
  });

  it('stores only the SHA-256 of the session token, never the token', async () => {
    const { cookie } = await createDemoUser('198.51.100.3');
    const token = cookie.split('=')[1] as string;

    const rows = await env.DB.prepare('SELECT id_hash FROM sessions').all<{ id_hash: string }>();
    expect(rows.results).toHaveLength(1);
    const stored = rows.results[0]?.id_hash as string;

    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(stored).toBe(expected);
  });

  it('allows 5 demo accounts per IP per hour and rejects the 6th', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 5; i += 1) {
      const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'cf-connecting-ip': ip },
      });
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }

    const sixth = await SELF.fetch(`${ORIGIN}/auth/demo`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-connecting-ip': ip },
    });
    expect(sixth.status).toBe(429);
    expect((await sixth.json() as { error: { code: string } }).error.code).toBe('rate_limited');

    // The limit is per IP, so a different address is unaffected.
    const other = await SELF.fetch(`${ORIGIN}/auth/demo`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.8' },
    });
    expect(other.status).toBe(200);
  });

  it('never stores the raw client IP', async () => {
    const ip = '203.0.113.99';
    await createDemoUser(ip);
    const rows = await env.DB.prepare('SELECT ip_hash FROM demo_signups').all<{ ip_hash: string }>();
    expect(rows.results[0]?.ip_hash).not.toContain(ip);
    expect(rows.results[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* --------------------------------- sessions ------------------------------- */

describe('sessions', () => {
  it('resolves a valid cookie to the signed-in user', async () => {
    const { cookie, id } = await createDemoUser('198.51.100.10');
    const res = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json() as { user: { id: string } }).user.id).toBe(id);
  });

  it('401s with no cookie, a junk cookie, or an expired session', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/me`)).status).toBe(401);
    expect(
      (await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: 'wsc_session=nonsense' } })).status,
    ).toBe(401);

    const { cookie } = await createDemoUser('198.51.100.11');
    await env.DB.prepare('UPDATE sessions SET expires_at = ?')
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('stops honouring a demo session the moment the account expires', async () => {
    const { cookie, id } = await createDemoUser('198.51.100.12');
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(200);

    // The session itself is still valid for 30 days; the account is not.
    await env.DB.prepare('UPDATE users SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('logout deletes the session row', async () => {
    const { cookie } = await createDemoUser('198.51.100.13');
    const res = await SELF.fetch(`${ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
  });
});

/* -------------------------------- isolation ------------------------------- */

describe('isolation (section 9)', () => {
  it("user A's session gets 403 on user B's agent", async () => {
    const a = await createDemoUser('198.51.100.21');
    const b = await createDemoUser('198.51.100.22');
    expect(a.id).not.toBe(b.id);

    const crossed = await SELF.fetch(`${ORIGIN}/agents/kitchen-agent/${b.id}`, {
      headers: { cookie: a.cookie },
    });
    expect(crossed.status).toBe(403);
    const body = (await crossed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');

    // And the same request with B's own cookie gets past the guard. Without
    // this half, a route that 403s unconditionally would pass the test above.
    // 426 is the agent itself answering: this path is a WebSocket, and a plain
    // GET is the wrong way to reach it.
    const own = await SELF.fetch(`${ORIGIN}/agents/kitchen-agent/${b.id}`, {
      headers: { cookie: b.cookie },
    });
    expect(own.status).not.toBe(403);
    expect(own.status).toBe(426);
    await own.text();
  });

  it('rejects an unauthenticated agent request with 401, not 403', async () => {
    const { id } = await createDemoUser('198.51.100.23');
    const res = await SELF.fetch(`${ORIGIN}/agents/kitchen-agent/${id}`);
    expect(res.status).toBe(401);
  });

  it('blocks a cross-user WebSocket upgrade too, not just plain GETs', async () => {
    const a = await createDemoUser('198.51.100.24');
    const b = await createDemoUser('198.51.100.25');
    const res = await SELF.fetch(`${ORIGIN}/agents/kitchen-agent/${b.id}`, {
      headers: { cookie: a.cookie, upgrade: 'websocket' },
    });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------- DELETE /api/me --------------------------- */

describe('DELETE /api/me', () => {
  it('removes the user, their sessions and their agent storage', async () => {
    const { cookie, id } = await createDemoUser('198.51.100.31');

    // Put something in the agent's storage so the wipe is observable.
    const stub = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(id)) as unknown as {
      ping(): Promise<{ ok: true }>;
    };
    await stub.ping();

    const res = await SELF.fetch(`${ORIGIN}/api/me`, {
      method: 'DELETE',
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(200);

    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
    expect(user).toBeNull();
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('401s without a session, so an anonymous caller cannot delete anything', async () => {
    await createDemoUser('198.51.100.32');
    const res = await SELF.fetch(`${ORIGIN}/api/me`, { method: 'DELETE', headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

/* --------------------------------- origin --------------------------------- */

describe('origin check (section 9)', () => {
  it('rejects a state-changing request from another origin', async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'cf-connecting-ip': '198.51.100.41' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a GET from another origin, which changes nothing', async () => {
    // 401 rather than 403 is the point: the request reached the session check
    // instead of being turned away by the origin guard.
    const res = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(401);
  });
});

/* -------------------------------- DEV_AUTH -------------------------------- */

describe('DEV_AUTH bypass', () => {
  it('signs in without GitHub when DEV_AUTH is true', async () => {
    expect(env.DEV_AUTH).toBe('true');
    const res = await SELF.fetch(`${ORIGIN}/auth/dev`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'aditi' }),
    });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res, 'wsc_session');
    expect(cookie).not.toBeNull();

    const me = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: cookie as string } });
    expect((await me.json() as { user: { login: string; isDemo: boolean } }).user.login).toBe('aditi');
  });

  it('is a plain 404 when DEV_AUTH is not set', async () => {
    // Calling the handler directly with a doctored env is the only way to test
    // the negative: the binding comes from wrangler.jsonc and cannot be changed
    // for a single SELF.fetch.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/auth/dev`, { method: 'POST', headers: { origin: ORIGIN } }),
      { ...env, DEV_AUTH: undefined },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });
});

/* ------------------------------- nightly cron ----------------------------- */

describe('nightly demo cleanup', () => {
  it('deletes expired demo accounts and leaves live ones alone', async () => {
    const expired = await createDemoUser('198.51.100.51');
    const live = await createDemoUser('198.51.100.52');
    await env.DB.prepare('UPDATE users SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), expired.id)
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: '15 0 * * *', scheduledTime: Date.now(), noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(expired.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(live.id).first()).not.toBeNull();
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: live.cookie } })).status).toBe(200);
  });

  it('leaves a signed-in GitHub account alone even with no expiry set', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, is_demo, expires_at, created_at)
       VALUES ('gh1', '42', 'octocat', 'Octo', NULL, 0, NULL, ?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: '15 0 * * *', scheduledTime: Date.now(), noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 'gh1'").first()).not.toBeNull();
  });
});
