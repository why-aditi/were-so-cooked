import { Hono } from 'hono';
import { fail, timingSafeEqual } from '../auth.js';
import type { Env } from '../env.js';

type App = { Bindings: Env; Variables: { requestId: string } };

export const adminRoutes = new Hono<App>();

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * Both sides are hashed before the constant-time compare, so neither the
 * token's bytes nor its length can be probed by timing. An unset token
 * locks the route rather than opening it.
 */
async function isAdmin(header: string | undefined, token: string | undefined): Promise<boolean> {
  if (!token || !header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(await sha256(header.slice('Bearer '.length)), await sha256(token));
}

/**
 * Section 11: "Start the viral Workflow manually; needs `ADMIN_TOKEN`."
 *
 * The run still goes through the budget like the Sunday cron's: the viral
 * pool is Sunday-only (section 12), so a manual run on any other day is
 * recorded as deferred rather than spending user budget.
 */
adminRoutes.post('/admin/pipeline/run', async (c) => {
  if (!(await isAdmin(c.req.header('authorization'), c.env.ADMIN_TOKEN))) {
    return fail('unauthorized', 'Admin token required.', c.get('requestId'));
  }
  const instance = await c.env.VIRAL_RECIPES.create({ params: { manual: true } });
  console.log(JSON.stringify({ event: 'viral_run_started', runId: instance.id, manual: true }));
  // The instance id is the `pipeline_runs.id`, so the two are the same handle.
  return c.json({ runId: instance.id, workflowId: instance.id }, 202);
});
