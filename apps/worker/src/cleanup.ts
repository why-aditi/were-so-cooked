import type { Env } from './env.js';

/**
 * Deleting a user's data, used by both `DELETE /api/me` and the nightly cron.
 *
 * A user's data lives in three places (section 9), and only one of them is
 * D1. Deleting the row and stopping there would leave the agent's SQLite and
 * any uploaded photos behind, still addressable by user ID — so a recycled or
 * guessed ID would surface someone else's kitchen.
 *
 * Order matters. D1 goes last: while its row exists the account is still
 * reachable and a retry can finish the job, whereas deleting D1 first would
 * orphan the agent and R2 objects with nothing left pointing at them.
 */
export async function deleteUserData(env: Env, userId: string): Promise<{
  agent: boolean;
  r2Objects: number;
  d1: boolean;
}> {
  let agent = false;
  let r2Objects = 0;

  try {
    const stub = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(userId)) as unknown as {
      destroy(): Promise<void>;
    };
    await stub.destroy();
    agent = true;
  } catch (e) {
    // Destroying an Agent deletes its facet, which aborts the isolate — so a
    // successful wipe frequently rejects with "destroyed" rather than
    // returning. Treating that as failure would make every account deletion
    // log an error and report `agent: false` while having worked.
    const destroyed = String(e).includes('destroyed');
    agent = destroyed;
    if (!destroyed) {
      console.error(JSON.stringify({ event: 'cleanup', step: 'agent', userId, error: String(e) }));
    }
  }

  try {
    // Keys follow uploads/{userId}/{uuid}.{ext} (section 4). Listing is
    // paginated; a user with more than 1,000 objects would otherwise be
    // partially cleaned and look finished.
    let cursor: string | undefined;
    do {
      const listed = await env.UPLOADS.list(
        cursor ? { prefix: `uploads/${userId}/`, cursor } : { prefix: `uploads/${userId}/` },
      );
      if (listed.objects.length > 0) {
        await env.UPLOADS.delete(listed.objects.map((o) => o.key));
        r2Objects += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error(JSON.stringify({ event: 'cleanup', step: 'r2', userId, error: String(e) }));
  }

  // Sessions are deleted explicitly rather than relying on ON DELETE CASCADE:
  // a live session for a deleted user is the difference between "logged out"
  // and "authenticated as a ghost".
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  return { agent, r2Objects, d1: true };
}

/**
 * The 00:15 UTC cron from section 3: delete expired demo accounts and their
 * data.
 *
 * Bounded per run. A backlog is better than a cron that runs past the Workers
 * CPU limit and dies halfway, leaving some users half-deleted with no record
 * of which.
 */
const MAX_PER_RUN = 200;

export async function deleteExpiredDemoAccounts(env: Env): Promise<{
  found: number;
  deleted: number;
  failed: string[];
}> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    'SELECT id FROM users WHERE is_demo = 1 AND expires_at IS NOT NULL AND expires_at <= ? LIMIT ?',
  )
    .bind(now, MAX_PER_RUN)
    .all<{ id: string }>();

  const found = results?.length ?? 0;
  let deleted = 0;
  const failed: string[] = [];

  for (const row of results ?? []) {
    try {
      await deleteUserData(env, row.id);
      deleted += 1;
    } catch (e) {
      failed.push(row.id);
      console.error(
        JSON.stringify({ event: 'cleanup', step: 'user', userId: row.id, error: String(e) }),
      );
    }
  }

  // Expired sessions belonging to accounts that still exist are dead weight;
  // sweeping them here keeps the sessions table from growing without bound.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();

  // Rate-limit rows older than the widest window (24 hours) can never affect a
  // decision again.
  await env.DB.prepare('DELETE FROM demo_signups WHERE created_at <= ?')
    .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())
    .run();

  return { found, deleted, failed };
}
