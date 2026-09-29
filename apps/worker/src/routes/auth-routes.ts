import { Hono } from 'hono';
import {
  clearSessionCookie,
  clearStateCookie,
  createSession,
  deleteSession,
  fail,
  hashIp,
  randomToken,
  readSignedState,
  sessionTokenFrom,
  setSessionCookie,
  setStateCookie,
} from '../auth.js';
import type { Env } from '../env.js';

/** Section 9 rate limits on demo account creation. */
const DEMO_PER_IP_PER_HOUR = 5;
const DEMO_PER_DAY_TOTAL = 50;
const DEMO_LIFETIME_HOURS = 24;

type App = { Bindings: Env; Variables: { requestId: string } };

export const authRoutes = new Hono<App>();

/* ------------------------------ GitHub OAuth ------------------------------ */

authRoutes.get('/auth/github', async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  const signingKey = c.env.SESSION_SIGNING_KEY;
  if (!clientId || !signingKey) {
    return fail('internal_error', 'GitHub sign-in is not configured on this deployment.', c.get('requestId'));
  }

  const state = randomToken();
  await setStateCookie(c, state, signingKey);

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', new URL('/auth/github/callback', c.req.url).toString());
  // Section 9: read:user only. The app never needs repo or email scope.
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);

  return c.redirect(authorize.toString(), 302);
});

authRoutes.get('/auth/github/callback', async (c) => {
  const signingKey = c.env.SESSION_SIGNING_KEY;
  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  if (!signingKey || !clientId || !clientSecret) {
    return fail('internal_error', 'GitHub sign-in is not configured on this deployment.', c.get('requestId'));
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = await readSignedState(c.req.raw, signingKey);
  clearStateCookie(c);

  if (!code || !state || !expected || state !== expected) {
    // Deliberately one message for all four cases. Telling a caller which part
    // failed helps only an attacker probing the CSRF defence.
    return fail('forbidden', 'Sign-in could not be verified. Start again.', c.get('requestId'));
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return fail('forbidden', 'GitHub did not issue a token.', c.get('requestId'));
  }

  const profileRes = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'were-so-cooked',
    },
  });
  if (!profileRes.ok) return fail('forbidden', 'Could not read the GitHub profile.', c.get('requestId'));
  const profile = (await profileRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string | null;
  };

  // Section 9: the access token is used once and discarded. It is never
  // written to D1, never logged, and goes out of scope here.

  const userId = await upsertGithubUser(c.env, profile);
  setSessionCookie(c, await createSession(c.env, userId));
  return c.redirect('/app', 302);
});

async function upsertGithubUser(
  env: Env,
  profile: { id: number; login: string; name?: string | null; avatar_url?: string | null },
): Promise<string> {
  const githubId = String(profile.id);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE github_id = ?')
    .bind(githubId)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare('UPDATE users SET login = ?, name = ?, avatar_url = ? WHERE id = ?')
      .bind(profile.login, profile.name ?? null, profile.avatar_url ?? null, existing.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, login, name, avatar_url, is_demo, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
  )
    .bind(id, githubId, profile.login, profile.name ?? null, profile.avatar_url ?? null, new Date().toISOString())
    .run();
  return id;
}

/* ------------------------------ demo accounts ----------------------------- */

authRoutes.post('/auth/demo', async (c) => {
  const signingKey = c.env.SESSION_SIGNING_KEY ?? 'dev-unsafe-key';
  // CF-Connecting-IP is set by the edge and cannot be spoofed by the client;
  // X-Forwarded-For can be, so it is only a local-dev fallback.
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '0.0.0.0';
  const ipHash = await hashIp(ip, signingKey);
  const now = new Date();

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const perIp = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM demo_signups WHERE ip_hash = ? AND created_at > ?',
  )
    .bind(ipHash, hourAgo)
    .first<{ n: number }>();
  if ((perIp?.n ?? 0) >= DEMO_PER_IP_PER_HOUR) {
    return fail('rate_limited', `At most ${DEMO_PER_IP_PER_HOUR} demo accounts per hour. Try later.`, c.get('requestId'));
  }

  const perDay = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM demo_signups WHERE created_at > ?',
  )
    .bind(dayAgo)
    .first<{ n: number }>();
  if ((perDay?.n ?? 0) >= DEMO_PER_DAY_TOTAL) {
    return fail('rate_limited', 'The demo is at capacity for today. Try tomorrow.', c.get('requestId'));
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + DEMO_LIFETIME_HOURS * 60 * 60 * 1000).toISOString();
  const login = `demo-${id.slice(0, 8)}`;

  // The signup row and the user are written together: if the insert of one
  // succeeded and the other did not, the rate limiter would drift out of step
  // with reality in whichever direction the failure fell.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, is_demo, expires_at, created_at)
       VALUES (?, NULL, ?, ?, NULL, 1, ?, ?)`,
    ).bind(id, login, 'Demo kitchen', expiresAt, now.toISOString()),
    c.env.DB.prepare('INSERT INTO demo_signups (id, ip_hash, created_at) VALUES (?, ?, ?)').bind(
      crypto.randomUUID(),
      ipHash,
      now.toISOString(),
    ),
  ]);

  // Section 9 also seeds a pantry, profile, taste history and a ready-made
  // plan. All of that lives in the user's KitchenAgent SQLite, which is week 2
  // (track C) — the account is real and isolated, just empty for now.

  setSessionCookie(c, await createSession(c.env, id));
  return c.json({
    user: {
      id,
      login,
      name: 'Demo kitchen',
      avatarUrl: null,
      isDemo: true,
      createdAt: now.toISOString(),
    },
    expiresAt,
  });
});

/* ----------------------------- local dev bypass --------------------------- */

/**
 * Section 9's fake login. Exists only when DEV_AUTH is exactly "true".
 *
 * The guard is inside the handler rather than at mount time so that the route
 * returns a normal 404 in every other environment — indistinguishable from a
 * path that was never defined. Both CI workflows also fail the build if
 * DEV_AUTH appears outside the dev block of wrangler.jsonc, so this is the
 * second of two independent locks.
 */
authRoutes.post('/auth/dev', async (c) => {
  if (c.env.DEV_AUTH !== 'true') {
    return fail('not_found', 'No route for POST /auth/dev.', c.get('requestId'));
  }

  const body = (await c.req.json().catch(() => ({}))) as { login?: string };
  const login = body.login ?? 'dev';

  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE login = ? AND github_id IS NULL AND is_demo = 0',
  )
    .bind(login)
    .first<{ id: string }>();

  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO users (id, github_id, login, name, avatar_url, is_demo, expires_at, created_at)
       VALUES (?, NULL, ?, ?, NULL, 0, NULL, ?)`,
    )
      .bind(id, login, `Local ${login}`, new Date().toISOString())
      .run();
  }

  setSessionCookie(c, await createSession(c.env, id));
  return c.json({ user: { id, login, isDemo: false }, devAuth: true });
});

/* --------------------------------- logout --------------------------------- */

authRoutes.post('/auth/logout', async (c) => {
  const token = sessionTokenFrom(c.req.raw);
  if (token) await deleteSession(c.env, token);
  clearSessionCookie(c);
  return c.json({ ok: true as const });
});
