import { type ErrorCode, ERROR_STATUS } from '@cooked/shared';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './env.js';

/**
 * What the cookie helpers actually need. Hono's `Context` is invariant in its
 * `Variables` parameter, so a helper typed `Context<{ Bindings: Env }>` cannot
 * be called from an app that declares variables. Structural typing sidesteps
 * that without an `any`.
 */
interface CookieCtx {
  req: { url: string };
  header(name: string, value: string, options?: { append?: boolean }): void;
}

/**
 * Session and cookie primitives for section 9.
 *
 * Two different cookies with two different security models, which is easy to
 * confuse:
 *
 *   wsc_session  a bearer token. 32 random bytes; D1 stores only its SHA-256.
 *                Nothing is signed — possession of the token is the proof, and
 *                the hash means a database leak does not yield usable tokens.
 *   wsc_state    an HMAC-signed value with a 10-minute lifetime. Signed rather
 *                than hashed because the callback has to read the value back
 *                out and compare it, not just recognise it.
 */

export const SESSION_COOKIE = 'wsc_session';
export const STATE_COOKIE = 'wsc_state';

const SESSION_DAYS = 30;
const STATE_MINUTES = 10;

export interface SessionUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isDemo: boolean;
  createdAt: string;
}

/* --------------------------------- crypto -------------------------------- */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, hex encoded. Used for session tokens and OAuth state. */
export function randomToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

/** What D1 stores in place of the session token itself. */
export async function sha256(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

/**
 * Salted hash of a client IP for the demo rate limiter. Salting with the
 * signing key matters: the IPv4 space is small enough to enumerate, so an
 * unsalted SHA-256 of an address is reversible in seconds.
 */
export async function hashIp(ip: string, key: string): Promise<string> {
  return sha256(`${key}:ip:${ip}`);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function sign(value: string, secret: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value)));
}

/** Constant-time compare, so a bad signature cannot be guessed byte by byte. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------- cookies -------------------------------- */

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * `Secure` is omitted on plain-HTTP localhost, because a browser silently drops
 * a Secure cookie there and local sign-in would fail with no visible reason.
 * Everywhere else it is set.
 */
function cookieAttrs(url: URL, maxAgeSeconds: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function setSessionCookie(c: CookieCtx, token: string): void {
  const url = new URL(c.req.url);
  c.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; ${cookieAttrs(url, SESSION_DAYS * 24 * 60 * 60)}`,
    { append: true },
  );
}

export function clearSessionCookie(c: CookieCtx): void {
  const url = new URL(c.req.url);
  c.header('set-cookie', `${SESSION_COOKIE}=; ${cookieAttrs(url, 0)}`, { append: true });
}

export async function setStateCookie(c: CookieCtx, state: string, secret: string): Promise<void> {
  const url = new URL(c.req.url);
  const signature = await sign(state, secret);
  c.header(
    'set-cookie',
    `${STATE_COOKIE}=${state}.${signature}; ${cookieAttrs(url, STATE_MINUTES * 60)}`,
    { append: true },
  );
}

export function clearStateCookie(c: CookieCtx): void {
  const url = new URL(c.req.url);
  c.header('set-cookie', `${STATE_COOKIE}=; ${cookieAttrs(url, 0)}`, { append: true });
}

/** @returns the state value if the cookie is present and correctly signed. */
export async function readSignedState(req: Request, secret: string): Promise<string | null> {
  const raw = readCookie(req, STATE_COOKIE);
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = raw.slice(0, idx);
  const signature = raw.slice(idx + 1);
  const expected = await sign(value, secret);
  return timingSafeEqual(signature, expected) ? value : null;
}

/* --------------------------------- sessions ------------------------------- */

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await env.DB.prepare(
    'INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256(token), userId, expires.toISOString(), now.toISOString())
    .run();
  return token;
}

/**
 * Resolves the session cookie to a user, or null.
 *
 * The expiry is filtered in SQL rather than compared afterwards so an expired
 * row can never produce a user, even if a later refactor forgets the check.
 */
export async function getSessionUser(req: Request, env: Env): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.login, u.name, u.avatar_url, u.is_demo, u.created_at, u.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<{
      id: string;
      login: string;
      name: string | null;
      avatar_url: string | null;
      is_demo: number;
      created_at: string;
      expires_at: string | null;
    }>();

  if (!row) return null;
  // A demo account past its 24 hours is gone even if the nightly cron has not
  // run yet. The cron reclaims storage; this makes the account unusable on time.
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;

  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
  };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(token)).run();
}

export function sessionTokenFrom(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

/* -------------------------------- responses ------------------------------- */

/**
 * Section 11's code list and status map, taken from `packages/shared` rather
 * than restated here.
 *
 * This file used to carry its own narrower copy, which silently omitted
 * `budget_exhausted` (429) and `upstream_error` (502) — two codes section 11
 * requires and that the worker therefore could not return at all. Importing
 * the shared one means a code added to the table cannot be missed here.
 */
export type { ErrorCode };

/** The one error shape from section 11. */
export function fail(code: ErrorCode, message: string, requestId = 'unknown'): Response {
  return Response.json({ error: { code, message, requestId } }, { status: ERROR_STATUS[code] });
}

/* ------------------------------- middleware ------------------------------- */

/**
 * Section 9: state-changing routes accept only JSON POST/PUT/DELETE and check
 * the Origin header.
 *
 * A missing Origin is allowed. Browsers always send it on cross-origin
 * state-changing requests, which is the attack this defends against; curl and
 * server-to-server callers send nothing, and rejecting them would break the
 * smoke tests without closing any hole.
 */
export const originCheck: MiddlewareHandler<{
  Bindings: Env;
  Variables: { requestId: string };
}> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const origin = c.req.header('origin');
  if (origin && new URL(origin).host !== new URL(c.req.url).host) {
    return fail('forbidden', 'Cross-origin state-changing requests are rejected.', c.get('requestId'));
  }
  return next();
};

/** Attaches the session user, or 401s. */
export const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: SessionUser; requestId: string };
}> = async (c, next) => {
  const user = await getSessionUser(c.req.raw, c.env);
  if (!user) return fail('unauthorized', 'Sign in first.', c.get('requestId'));
  c.set('user', user);
  return next();
};
