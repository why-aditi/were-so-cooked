import type { HealthCheck, HealthzResponse } from '@cooked/shared';
import { Hono } from 'hono';
import { fail, originCheck } from './auth.js';
import { deleteExpiredDemoAccounts } from './cleanup.js';
import type { Env } from './env.js';
import { adminRoutes } from './routes/admin-routes.js';
import { apiRoutes } from './routes/api-routes.js';
import { authRoutes } from './routes/auth-routes.js';

export { BudgetKeeper, KitchenAgent } from './durable-objects.js';
export { PhotoScanWorkflow, ViralRecipesWorkflow, WeeklyPlanWorkflow } from './workflows.js';

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

/* ------------------------------ observability ---------------------------- */

/**
 * Section 13: one structured JSON line per request with requestId, route,
 * latency and outcome. The user ID is hashed wherever it is known — it is not
 * yet, because no route here reads a session.
 *
 * Errors always log; everything else is sampled at 20% to stay inside the
 * 200,000 events/day Workers Logs allowance (section 12).
 */
const SAMPLE_RATE = 0.2;

app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const started = Date.now();
  let outcome = 'ok';
  try {
    await next();
    if (c.res.status >= 500) outcome = 'error';
  } catch (e) {
    outcome = 'error';
    console.error(
      JSON.stringify({
        requestId,
        route: new URL(c.req.url).pathname,
        method: c.req.method,
        latencyMs: Date.now() - started,
        outcome,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }),
    );
    throw e;
  }

  if (outcome === 'error' || Math.random() < SAMPLE_RATE) {
    console.log(
      JSON.stringify({
        requestId,
        route: new URL(c.req.url).pathname,
        method: c.req.method,
        status: c.res.status,
        latencyMs: Date.now() - started,
        outcome,
      }),
    );
  }
});

/* --------------------------------- routes -------------------------------- */

// Section 9: state-changing routes check Origin. Mounted before the route
// tables so a new POST route cannot be added without the check.
app.use('*', originCheck);
app.route('/', authRoutes);
app.route('/', apiRoutes);
app.route('/', adminRoutes);

/**
 * Section 11: "Errors always return `{ error: { code, message, requestId } }`."
 *
 * Always means always, including the ones nobody wrote a handler for.
 * Without this, an unexpected throw falls through to Hono's default and the
 * client gets `Internal Server Error` as plain text — a different shape,
 * without the request ID that makes the log searchable. An E2E run caught
 * exactly that: a missing D1 table surfaced as an unparseable body, and the
 * SPA showed its generic fallback instead of anything actionable.
 *
 * The thrown message is logged, never returned. It is the one place likely
 * to carry a query, a key name or a binding path.
 */
app.onError((error, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      requestId,
      route: new URL(c.req.url).pathname,
      method: c.req.method,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  );
  return fail('internal_error', "we're cooked 💀 (the server, not you). try again?", requestId);
});

/* --------------------------------- health -------------------------------- */

async function timed(fn: () => Promise<unknown>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

/**
 * Section 11: public, checks D1, a KitchenAgent ping and the AI binding.
 * Returns 200, or 503 with the same body.
 *
 * The AI check does not run inference by default. Section 13 schedules this
 * hourly, and Workers AI is the one budget that actually binds (section 12) —
 * spending neurons 24 times a day to learn the binding is present is a poor
 * trade. `?deep=1` runs a real single-token call for a manual, deliberate
 * check. The response says which mode ran, so a green shallow check is never
 * mistaken for a proven model round-trip.
 */
app.get('/healthz', async (c) => {
  const deep = c.req.query('deep') === '1';

  const [d1, agent, ai] = await Promise.all([
    timed(() => c.env.DB.prepare('SELECT 1').first()),
    timed(async () => {
      const id = c.env.KITCHEN_AGENT.idFromName('healthz-probe');
      const stub = c.env.KITCHEN_AGENT.get(id) as unknown as { ping(): Promise<unknown> };
      return stub.ping();
    }),
    timed(async () => {
      if (typeof c.env.AI?.run !== 'function') throw new Error('AI binding missing');
      if (!deep) return { mode: 'shallow' };
      return c.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        prompt: 'ok',
        max_tokens: 1,
      });
    }),
  ]);

  const body: HealthzResponse & { aiCheck: 'shallow' | 'deep' } = {
    status: d1.ok && agent.ok && ai.ok ? 'ok' : 'degraded',
    checks: { d1, agent, ai },
    aiCheck: deep ? 'deep' : 'shallow',
  };

  return c.json(body, body.status === 'ok' ? 200 : 503);
});

/* --------------------------------- assets -------------------------------- */

/**
 * Paths listed in `run_worker_first` reach the Worker; everything else is
 * served from the static assets binding before this code runs. This fallback
 * covers the rest: an unmatched /api path is a real 404 in the API's error
 * shape (section 11), and anything else hands off to the SPA.
 */
app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/admin/')) {
    return c.json(
      {
        error: {
          code: 'not_found',
          message: `No route for ${c.req.method} ${path}.`,
          requestId: c.get('requestId'),
        },
      },
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

/* -------------------------------- handlers ------------------------------- */

export default {
  fetch: app.fetch,

  /** Section 3's two crons. */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === '15 0 * * *') {
      const result = await deleteExpiredDemoAccounts(env);
      console.log(
        JSON.stringify({
          event: 'cron',
          cron: event.cron,
          job: 'delete-expired-demo-accounts',
          environment: env.ENVIRONMENT,
          outcome: result.failed.length === 0 ? 'ok' : 'partial',
          ...result,
        }),
      );
      return;
    }

    if (event.cron === '30 0 * * 0') {
      // Just after the daily budget turns over, as section 3 schedules it.
      // The Workflow records its own outcome in `pipeline_runs`.
      const instance = await env.VIRAL_RECIPES.create({ params: {} });
      console.log(
        JSON.stringify({
          event: 'cron',
          cron: event.cron,
          job: 'start-viral-recipes',
          environment: env.ENVIRONMENT,
          outcome: 'started',
          runId: instance.id,
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        event: 'cron',
        cron: event.cron,
        job: 'unknown',
        environment: env.ENVIRONMENT,
        outcome: 'ignored',
      }),
    );
  },
} satisfies ExportedHandler<Env>;
