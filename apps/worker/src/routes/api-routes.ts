import { getAgentByName, routeAgentRequest } from 'agents';
import {
  GetPantryQuery,
  PatchPantryItemRequest,
  PostPantryRequest,
  PostPlanRequest,
  PostScanConfirmRequest,
  PutProfileRequest,
} from '@cooked/shared';
import { type Context, Hono } from 'hono';
import type { KitchenAgent } from '../agent/kitchen-agent.js';
import type { BudgetStatus } from '../budget/policy.js';
import { uploadKey, validateUpload } from '../photo/validate.js';
import { d1RecipeSearch } from '../recipes/store.js';

/** Section 9: every agent is addressed by its user ID, never by anything else. */
const kitchenAgent = (env: Env, userId: string): DurableObjectStub<KitchenAgent> =>
  env.KITCHEN_AGENT.get(
    env.KITCHEN_AGENT.idFromName(userId),
  ) as unknown as DurableObjectStub<KitchenAgent>;
import { fail, getSessionUser, requireSession, type SessionUser } from '../auth.js';
import { deleteUserData } from '../cleanup.js';
import type { Env } from '../env.js';

type App = { Bindings: Env; Variables: { requestId: string; user: SessionUser } };

export const apiRoutes = new Hono<App>();

/* ----------------------------------- me ----------------------------------- */

apiRoutes.get('/api/me', requireSession, (c) => {
  return c.json({ user: c.get('user') });
});

/** Section 9: deletes the account and all its data, everywhere it lives. */
apiRoutes.delete('/api/me', requireSession, async (c) => {
  const user = c.get('user');
  const result = await deleteUserData(c.env, user.id);
  console.log(
    JSON.stringify({ event: 'account_deleted', userId: user.id, isDemo: user.isDemo, ...result }),
  );
  // The session rows are gone, so the cookie is already dead; clearing it too
  // stops the browser sending a token that can never resolve again.
  c.header('set-cookie', 'wsc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', {
    append: true,
  });
  return c.json({ ok: true as const });
});

/* --------------------------------- budget --------------------------------- */

/**
 * Section 11: "Neurons left today for this user and for the account."
 *
 * The two halves measure different windows on purpose. `user` is the UTC-day
 * fairness cap; `account` is the rolling 24-hour total, because that is what
 * Cloudflare actually refuses on (section 12). They reset at different moments
 * and `resetsAt` refers to the user cap.
 */
apiRoutes.get('/api/budget', requireSession, async (c) => {
  const user = c.get('user');
  const keeper = c.env.BUDGET_KEEPER.get(
    c.env.BUDGET_KEEPER.idFromName('global'),
  ) as unknown as { status(userId: string, isDemo: boolean): Promise<BudgetStatus> };
  return c.json(await keeper.status(user.id, user.isDemo));
});

/* --------------------------------- profile -------------------------------- */

/** Section 11: "Read or replace diet profile." */
apiRoutes.get('/api/profile', requireSession, async (c) => {
  const profile = await kitchenAgent(c.env, c.get('user').id).getProfile();
  return c.json({ profile });
});

/**
 * A full replace, not a patch — section 11 says "replace", and the profile
 * screen sends the whole object back.
 *
 * That is the safer shape for this particular resource: a patch that omits
 * `allergens` is ambiguous between "leave them" and "clear them", and one
 * of those readings loses an allergy. The chat tool patches instead, because
 * there the model only ever names what changed.
 */
apiRoutes.put('/api/profile', requireSession, async (c) => {
  const parsed = PutProfileRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail('validation_failed', 'That profile did not make sense.', c.get('requestId'));
  }
  const profile = await kitchenAgent(c.env, c.get('user').id).setProfile(parsed.data);
  return c.json({ profile });
});

/**
 * The browser's time zone, adopted only while the profile still holds the
 * UTC default. Its own route rather than a profile PUT, because a full
 * replace from the client could undo a change made in the meantime.
 */
apiRoutes.put('/api/profile/time-zone', requireSession, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { timeZone?: unknown } | null;
  const zone = typeof body?.timeZone === 'string' ? body.timeZone : '';
  let valid = zone.length > 0 && zone.length <= 64;
  try {
    if (valid) new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    valid = false;
  }
  if (!valid) return fail('validation_failed', 'That is not a time zone.', c.get('requestId'));
  const profile = await kitchenAgent(c.env, c.get('user').id).adoptTimeZone(zone);
  return c.json({ profile });
});

/* --------------------------------- pantry --------------------------------- */

apiRoutes.get('/api/pantry', requireSession, async (c) => {
  const query = GetPantryQuery.safeParse(c.req.query());
  const agent = kitchenAgent(c.env, c.get('user').id);
  // `exactOptionalPropertyTypes` distinguishes an absent key from one set to
  // undefined, and Zod's optionals produce the second — so the keys are
  // rebuilt rather than spread.
  const options = query.success ? query.data : {};
  const items = await agent.listPantry({
    ...(options.expiringWithinDays !== undefined
      ? { expiringWithinDays: options.expiringWithinDays }
      : {}),
    ...(options.includeDeleted !== undefined ? { includeDeleted: options.includeDeleted } : {}),
  });
  return c.json({ items });
});

/** Free text or already-structured items (section 11). */
apiRoutes.post('/api/pantry', requireSession, async (c) => {
  const parsed = PostPantryRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail('validation_failed', 'Nothing to add.', c.get('requestId'));
  }

  const agent = kitchenAgent(c.env, c.get('user').id);

  if ('text' in parsed.data) {
    const { added } = await agent.addPantryItems(parsed.data.text, { source: 'manual' });
    return c.json({ items: added }, 201);
  }

  // Structured items still go through the normalizer, one phrase at a time,
  // so a row added from a form gets the same expiry estimate and taxonomy
  // match as one typed into chat. Two code paths producing different pantry
  // rows for the same food is the bug this avoids.
  const items = [];
  for (const item of parsed.data.items) {
    const phrase = [item.quantity, item.unit, item.displayName].filter(Boolean).join(' ');
    const { added } = await agent.addPantryItems(phrase, { source: 'manual' });
    if (added[0]) items.push(added[0]);
  }
  return c.json({ items }, 201);
});

apiRoutes.patch('/api/pantry/:id', requireSession, async (c) => {
  const parsed = PatchPantryItemRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail('validation_failed', 'That edit did not make sense.', c.get('requestId'));
  }
  const patch = parsed.data;
  const item = await kitchenAgent(c.env, c.get('user').id).updatePantryItem(c.req.param('id'), {
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
    ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    ...(patch.canonicalId !== undefined ? { canonicalId: patch.canonicalId } : {}),
  });
  if (!item) return fail('not_found', 'No such pantry item.', c.get('requestId'));
  return c.json({ item });
});

/** Soft delete, so section 4's undo stays possible. */
apiRoutes.delete('/api/pantry/:id', requireSession, async (c) => {
  const { removed } = await kitchenAgent(c.env, c.get('user').id).removePantryItems([
    c.req.param('id'),
  ]);
  if (removed.length === 0) return fail('not_found', 'No such pantry item.', c.get('requestId'));
  return c.json({ ok: true as const });
});

/** Undo. Not in section 11's table, but the soft delete is pointless without it. */
apiRoutes.post('/api/pantry/:id/restore', requireSession, async (c) => {
  const { restored } = await kitchenAgent(c.env, c.get('user').id).restorePantryItems([
    c.req.param('id'),
  ]);
  if (restored.length === 0) return fail('not_found', 'Nothing to restore.', c.get('requestId'));
  return c.json({ ok: true as const });
});

/* ---------------------------------- inbox --------------------------------- */

apiRoutes.get('/api/inbox', requireSession, async (c) => {
  const agent = kitchenAgent(c.env, c.get('user').id);
  const unreadOnly = c.req.query('unreadOnly') === 'true';
  const items = await agent.listInbox(unreadOnly ? { unreadOnly: true } : {});
  const { unreadInbox } = await agent.snapshot();
  return c.json({ items, unread: unreadInbox });
});

apiRoutes.post('/api/inbox/:id/read', requireSession, async (c) => {
  const { ok } = await kitchenAgent(c.env, c.get('user').id).markInboxRead(c.req.param('id'));
  if (!ok) return fail('not_found', 'No such inbox item, or it was already read.', c.get('requestId'));
  return c.json({ ok: true as const });
});

/* --------------------------------- trending -------------------------------- */

/**
 * Section 11: "Trending recipes; `?fits=me` keeps only ones that pass or can
 * be substituted."
 *
 * The filter runs through the same safety gate the chat tool uses, so a
 * recipe that reaches this screen has been checked against the caller's
 * profile rather than merely tagged. `needsSubstitution` is what powers the
 * "make it fit my diet" button section 10 asks for.
 */
apiRoutes.get('/api/trending', requireSession, async (c) => {
  const limit = Number(c.req.query('limit') ?? 20);
  const fitsMe = c.req.query('fits') === 'me';
  const agent = kitchenAgent(c.env, c.get('user').id);

  const recipes = await d1RecipeSearch(c.env.DB).find({
    trendingOnly: true,
    limit: Number.isFinite(limit) ? Math.min(50, Math.max(1, limit)) : 20,
  });

  if (!fitsMe) {
    return c.json({
      recipes: recipes.map((recipe) => ({
        recipe,
        check: { ok: true, violations: [], unknowns: [] },
        needsSubstitution: false,
      })),
    });
  }

  const entries = [];
  for (const recipe of recipes) {
    const outcome = await agent.substituteRecipe({ recipeId: recipe.id, recipeTitle: recipe.title });
    if (outcome.status !== 'ok') continue;
    entries.push({
      recipe: outcome.recipe,
      check: { ok: true, violations: [], unknowns: [] },
      needsSubstitution: outcome.swaps.length > 0,
    });
  }
  return c.json({ recipes: entries });
});

/* ----------------------------------- plan ---------------------------------- */

/** Section 11: "Current plan with status." Null until a plan has been started. */
apiRoutes.get('/api/plans/current', requireSession, async (c) => {
  const plan = await kitchenAgent(c.env, c.get('user').id).currentPlan();
  return c.json({ plan });
});

/**
 * Section 11: "Start a weekly plan; returns `planId`."
 *
 * 202, because the plan is built by `WeeklyPlanWorkflow` in the background;
 * the screen polls `/api/plans/current` until the status moves. Starting
 * again while one is generating returns the running plan's id rather than a
 * second run.
 */
apiRoutes.post('/api/plans', requireSession, async (c) => {
  const parsed = PostPlanRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return fail('validation_failed', 'Could not read that plan request.', c.get('requestId'));
  }

  try {
    const started = await kitchenAgent(c.env, c.get('user').id).startWeeklyPlan(parsed.data);
    return c.json({ planId: started.planId, status: 'running' as const }, 202);
  } catch (e) {
    console.error(JSON.stringify({ event: 'plan_start_failed', error: String(e) }));
    return fail(
      'upstream_error',
      "we're cooked 💀 (the server, not you). try again?",
      c.get('requestId'),
    );
  }
});

/* --------------------------------- grocery --------------------------------- */

/** Derived from the current plan minus the pantry, so it is empty until a plan exists. */
apiRoutes.get('/api/grocery', requireSession, async (c) => {
  const items = await kitchenAgent(c.env, c.get('user').id).groceryItems();
  return c.json({ items });
});

apiRoutes.patch('/api/grocery/:itemId', requireSession, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { checked?: boolean } | null;
  if (typeof body?.checked !== 'boolean') {
    return fail('validation_failed', 'Send { checked: true | false }.', c.get('requestId'));
  }
  const item = await kitchenAgent(c.env, c.get('user').id).checkGroceryItem(
    c.req.param('itemId'),
    body.checked,
  );
  if (!item) return fail('not_found', 'No such grocery item.', c.get('requestId'));
  return c.json({ item });
});

/* ----------------------------- pipeline status ----------------------------- */

/** Section 11: "Signed in: recent viral-recipe runs (D1, no agent)." */
apiRoutes.get('/api/status/pipeline', requireSession, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, workflow, started_at, finished_at, status, found, filtered, extracted,
            added, duplicates, neurons, errors
     FROM pipeline_runs ORDER BY started_at DESC LIMIT 10`,
  ).all<{
    id: string;
    workflow: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    found: number;
    filtered: number;
    extracted: number;
    added: number;
    duplicates: number;
    neurons: number;
    errors: string;
  }>();

  return c.json({
    runs: (results ?? []).map((r) => ({
      id: r.id,
      workflow: r.workflow,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      found: r.found,
      filtered: r.filtered,
      extracted: r.extracted,
      added: r.added,
      duplicates: r.duplicates,
      neurons: r.neurons,
      errors: JSON.parse(r.errors) as string[],
    })),
  });
});

/* --------------------------------- uploads -------------------------------- */

/**
 * Section 11: "Upload a photo (5 MB max) to R2 and start a scan; returns
 * `scanId`."
 *
 * The body is read whole before anything else happens, because the size
 * limit has to be enforced on bytes actually received rather than on a
 * `Content-Length` the client wrote. The type is then read from the leading
 * bytes for the same reason.
 *
 * The scan row is created before the Workflow, so the 202 points at
 * something the client can poll immediately — a Workflow takes a moment to
 * start, and a `scanId` that 404s for the first second is a race the UI
 * would have to work around.
 */
apiRoutes.post('/api/uploads', requireSession, async (c) => {
  const user = c.get('user');

  const body = await c.req.arrayBuffer();
  const bytes = new Uint8Array(body);
  const check = validateUpload(bytes);
  if (!check.ok) {
    return fail('validation_failed', check.reason, c.get('requestId'));
  }

  const scanId = crypto.randomUUID();
  const key = uploadKey(user.id, check.extension);

  await c.env.UPLOADS.put(key, body, {
    httpMetadata: { contentType: check.type },
    // Read back by the cleanup path and by anything auditing the bucket.
    customMetadata: { userId: user.id, scanId },
  });

  const agent = kitchenAgent(c.env, user.id);
  await agent.createScan(scanId, key, null);

  try {
    const instance = await c.env.PHOTO_SCAN.create({ params: { userId: user.id, scanId, r2Key: key } });
    await agent.attachScanWorkflow(scanId, instance.id);
  } catch (e) {
    // The object is already in R2 and the row already says `processing`, so
    // failing here would strand both. Mark it failed and delete the upload
    // now rather than waiting on the one-day lifecycle rule.
    await agent.failScan(scanId, `Could not start the scan: ${String(e)}`);
    await c.env.UPLOADS.delete(key);
    return fail('upstream_error', "we're cooked 💀 (the server, not you). try again?", c.get('requestId'));
  }

  console.log(
    JSON.stringify({ event: 'upload', userId: user.id, scanId, bytes: check.bytes, type: check.type }),
  );
  return c.json({ scanId, status: 'processing' as const }, 202);
});

/** Section 11: "Scan status and extracted items." */
apiRoutes.get('/api/scans/:id', requireSession, async (c) => {
  const user = c.get('user');
  // Read from that user's own agent, so a scan id from another account
  // simply is not there — no cross-user lookup to get wrong.
  const scan = await kitchenAgent(c.env, user.id).getScan(c.req.param('id'));
  if (!scan) return fail('not_found', 'No such scan.', c.get('requestId'));
  return c.json({ scan });
});

/**
 * Section 11: "Confirm edited items; sends the Workflow its confirm event."
 *
 * The client sends the list back edited — unticked rows, corrected names,
 * fixed quantities. It is re-validated here rather than trusted, then the
 * Workflow is woken and does the committing, so the whole scan has one
 * owner from start to finish.
 */
apiRoutes.post('/api/scans/:id/confirm', requireSession, async (c) => {
  const user = c.get('user');
  const scanId = c.req.param('id');
  const agent = kitchenAgent(c.env, user.id);

  const scan = await agent.getScan(scanId);
  if (!scan) return fail('not_found', 'No such scan.', c.get('requestId'));
  if (scan.status !== 'awaiting_confirm') {
    return fail(
      'validation_failed',
      `That scan is ${scan.status}, not waiting to be confirmed.`,
      c.get('requestId'),
    );
  }

  const parsed = PostScanConfirmRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail('validation_failed', 'Could not read the confirmed items.', c.get('requestId'));
  }

  if (!scan.workflowId) {
    // No Workflow to wake — commit directly so the user is not stuck with a
    // confirm list that does nothing.
    const { added } = await agent.commitScan(scanId, parsed.data.items);
    return c.json({ added, status: 'done' as const });
  }

  const instance = await c.env.PHOTO_SCAN.get(scan.workflowId);
  await instance.sendEvent({ type: 'confirm', payload: { items: parsed.data.items } });
  return c.json({ status: 'confirming' as const, items: parsed.data.items.length }, 202);
});

/* ------------------------------ agent routing ----------------------------- */

/**
 * Section 9's isolation rule, and the single most important check in the app:
 *
 *   "Every agent instance is named after its user ID. The Worker checks the
 *    session on every HTTP request and WebSocket upgrade, and rejects any
 *    request where the agent name in the URL is not the session's user ID."
 *
 * The agent name comes from the URL, which is client-controlled. Without this
 * comparison any signed-in user could open a WebSocket to
 * /agents/kitchen-agent/<someone-else> and read that person's pantry, profile
 * and chat history. 401 when there is no session, 403 when there is one and it
 * names a different user — the distinction matters to a client deciding
 * whether to re-authenticate or give up.
 *
 * Registered for the sub-paths too, not only the bare agent URL. The SDK
 * serves several plain HTTP endpoints under this prefix — fetching the
 * transcript, resuming a dropped stream — and section 9 says the check runs
 * on *every* HTTP request, not just the upgrade. A Hono `:param` does not
 * match across slashes, so without the wildcard those endpoints would skip
 * the guard entirely and 404 before the SDK ever saw them.
 */
const agentRoute = (isRoot: boolean) => async (c: Context<App>): Promise<Response> => {
  const user = await getSessionUser(c.req.raw, c.env);
  if (!user) return fail('unauthorized', 'Sign in first.', c.get('requestId'));

  const requested = c.req.param('userId');
  if (requested !== user.id) {
    console.warn(
      JSON.stringify({
        event: 'isolation_violation',
        sessionUserId: user.id,
        requestedUserId: requested,
        route: new URL(c.req.url).pathname,
      }),
    );
    return fail('forbidden', 'That agent belongs to another account.', c.get('requestId'));
  }

  if (c.req.param('agent') !== 'kitchen-agent') {
    return fail('not_found', 'Unknown agent.', c.get('requestId'));
  }

  // Past the guard. The agent is addressed by the session's user ID, never
  // by the one in the URL — the two are equal by the check above, and using
  // the session's makes that impossible to regress.
  const agent = (await getAgentByName(
    c.env.KITCHEN_AGENT as unknown as DurableObjectNamespace<KitchenAgent>,
    user.id,
  )) as unknown as DurableObjectStub<KitchenAgent>;

  // The name carries the user ID, but not whether this is a demo account,
  // and the budget caps differ. Told once per connection, by the only party
  // that has checked the session.
  await agent.identify(user.id, user.isDemo);

  // Section 11 defines the bare agent URL as a WebSocket. Answering a plain
  // GET there with 426 rather than the SDK's 404 matters: the route exists
  // and this caller is allowed to use it, so 404 would send them hunting for
  // a typo. The sub-paths are ordinary HTTP and fall through to the SDK.
  if (isRoot && c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade.', { status: 426 });
  }

  // From here the `@cloudflare/ai-chat` protocol is the SDK's: the upgrade,
  // the message frames, resumable streaming, the state sync and the tool
  // approval round trip. This Worker's job was the isolation check.
  const routed = await routeAgentRequest(c.req.raw, c.env);
  return routed ?? fail('not_found', 'Unknown agent.', c.get('requestId'));
};

apiRoutes.all('/agents/:agent/:userId', agentRoute(true));
apiRoutes.all('/agents/:agent/:userId/*', agentRoute(false));
