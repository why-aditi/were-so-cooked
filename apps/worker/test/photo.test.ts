import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import { mockModel, says } from './fixtures/model.js';

/**
 * The photo pipeline against real storage: the R2 upload route, the scan
 * row in the agent's own SQLite, the confirm route, and the two paths
 * section 6 calls out — the 24-hour timeout and the low-confidence list.
 *
 * `step.waitForEvent` with a 24-hour timeout cannot be exercised inside a
 * test, so the timeout is driven through `expireScan`, which is the exact
 * method the Workflow's timeout branch calls. What that proves is what
 * matters: that a scan nobody confirmed ends up closed, the user is told,
 * and nothing reaches the pantry.
 */

const ORIGIN = 'http://localhost';

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];

function jpeg(bytes = 2_048): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set(JPEG_HEADER);
  return data;
}

let n = 0;
async function withAgent<T>(body: (agent: KitchenAgent) => Promise<T>): Promise<T> {
  const userId = `photo-${(n += 1)}-${crypto.randomUUID()}`;
  const stub = env.KITCHEN_AGENT.get(env.KITCHEN_AGENT.idFromName(userId));
  return runInDurableObject(stub, async (agent: KitchenAgent) => {
    agent.identify(userId, false);
    agent.useModel(mockModel(says('ok')) as never);
    return body(agent);
  });
}

const scanItem = (over: Record<string, unknown> = {}) => ({
  name: 'paneer',
  canonicalId: 'paneer',
  quantity: 200,
  unit: 'g' as const,
  confidence: 0.9,
  expiresAt: null,
  selected: true,
  ...over,
});

async function demoUser(ip: string): Promise<{ id: string; cookie: string }> {
  const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': ip, 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { user: { id: string } };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  return { id: body.user.id, cookie };
}

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));
});

/* ------------------------------ upload route ------------------------------ */

describe('POST /api/uploads', () => {
  it('needs a session', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it('stores the photo and returns a scan id', async () => {
    const user = await demoUser('203.0.113.10');
    const res = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: jpeg(),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { scanId: string; status: string };
    expect(body.status).toBe('processing');

    // Section 4: uploads/{userId}/{uuid}.{ext}
    const listed = await env.UPLOADS.list({ prefix: `uploads/${user.id}/` });
    expect(listed.objects).toHaveLength(1);
    expect(listed.objects[0]?.key).toMatch(/\.jpg$/);
  });

  it('opens the scan row before returning, so the id is pollable at once', async () => {
    const user = await demoUser('203.0.113.11');
    const res = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
    const { scanId } = (await res.json()) as { scanId: string };

    const scan = await SELF.fetch(`${ORIGIN}/api/scans/${scanId}`, {
      headers: { cookie: user.cookie },
    });
    expect(scan.status).toBe(200);
    const body = (await scan.json()) as { scan: { id: string; r2Key: string } };
    expect(body.scan.id).toBe(scanId);
    expect(body.scan.r2Key).toContain(user.id);
  });

  it('refuses a file that is not an image, whatever the header says', async () => {
    const user = await demoUser('203.0.113.12');
    const res = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_failed');
  });

  it('refuses a file over 5 MB', async () => {
    const user = await demoUser('203.0.113.13');
    const res = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: jpeg(5 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('5 MB');
  });

  it('writes nothing to R2 when validation fails', async () => {
    const user = await demoUser('203.0.113.14');
    await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array([0x00, 0x01, 0x02]),
    });
    const listed = await env.UPLOADS.list({ prefix: `uploads/${user.id}/` });
    expect(listed.objects).toHaveLength(0);
  });
});

/* ------------------------------- scan reads ------------------------------- */

describe('GET /api/scans/:id', () => {
  it('404s for a scan that does not exist', async () => {
    const user = await demoUser('203.0.113.20');
    const res = await SELF.fetch(`${ORIGIN}/api/scans/nope`, { headers: { cookie: user.cookie } });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('cannot see another user’s scan', async () => {
    // The lookup goes through the caller's own agent, so there is no
    // cross-user read to get wrong — another account's id simply is not there.
    const a = await demoUser('203.0.113.21');
    const b = await demoUser('203.0.113.22');

    const upload = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: a.cookie, 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
    const { scanId } = (await upload.json()) as { scanId: string };

    const res = await SELF.fetch(`${ORIGIN}/api/scans/${scanId}`, {
      headers: { cookie: b.cookie },
    });
    expect(res.status).toBe(404);
    await res.text();
  });
});

/* ------------------------------ confirm route ----------------------------- */

describe('POST /api/scans/:id/confirm', () => {
  it('refuses a scan that is not awaiting confirmation', async () => {
    const user = await demoUser('203.0.113.30');
    const upload = await SELF.fetch(`${ORIGIN}/api/uploads`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
    const { scanId } = (await upload.json()) as { scanId: string };

    const res = await SELF.fetch(`${ORIGIN}/api/scans/${scanId}/confirm`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(422);
    await res.text();
  });
});

/* -------------------------------- the commit ------------------------------ */

describe('committing a confirmed scan', () => {
  it('adds only the ticked items', async () => {
    const pantry = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.setScanItems('s1', [
        scanItem({ name: 'paneer', canonicalId: 'paneer', selected: true }),
        scanItem({ name: 'egg', canonicalId: 'egg', quantity: 6, unit: null, selected: false }),
      ]);
      await agent.commitScan('s1', [
        scanItem({ name: 'paneer', canonicalId: 'paneer', selected: true }),
        scanItem({ name: 'egg', canonicalId: 'egg', quantity: 6, unit: null, selected: false }),
      ]);
      return agent.listPantry();
    });

    expect(pantry.map((i) => i.canonicalId)).toEqual(['paneer']);
    expect(pantry[0]?.source).toBe('photo');
  });

  it('marks the scan done', async () => {
    const scan = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.setScanItems('s1', [scanItem()]);
      await agent.commitScan('s1', [scanItem()]);
      return agent.getScan('s1');
    });
    expect(scan?.status).toBe('done');
  });

  it('marks a printed expiry as a label, not an estimate', async () => {
    // The UI stops saying "about" for a date read off the packet.
    const pantry = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.setScanItems('s1', []);
      await agent.commitScan('s1', [scanItem({ expiresAt: '2026-12-25T00:00:00.000Z' })]);
      return agent.listPantry();
    });
    expect(pantry[0]).toMatchObject({
      expiresAt: '2026-12-25T00:00:00.000Z',
      expirySource: 'label',
    });
  });

  it('keeps the scan’s taxonomy match where it disagrees with a re-parse', async () => {
    const pantry = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.setScanItems('s1', []);
      await agent.commitScan('s1', [
        scanItem({ name: 'amul taaza', canonicalId: 'milk', quantity: 1, unit: 'l' }),
      ]);
      return agent.listPantry();
    });
    expect(pantry[0]?.canonicalId).toBe('milk');
  });

  it('accepts a scan where nothing was ticked', async () => {
    const result = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.setScanItems('s1', [scanItem({ selected: false })]);
      const committed = await agent.commitScan('s1', [scanItem({ selected: false })]);
      return { added: committed.added, pantry: await agent.listPantry() };
    });
    expect(result.added).toBe(0);
    expect(result.pantry).toHaveLength(0);
  });
});

/* ------------------------------ the timeout path -------------------------- */

describe('the 24-hour timeout', () => {
  it('closes the scan and tells the user', async () => {
    const result = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.setScanItems('s1', [scanItem()]);

      const expired = await agent.expireScan('s1');
      return { expired, scan: await agent.getScan('s1'), inbox: await agent.listInbox() };
    });

    expect(result.expired.expired).toBe(true);
    expect(result.scan?.status).toBe('failed');
    expect(result.scan?.error).toContain('24 hours');
    expect(result.inbox[0]?.title).toContain('timed out');
  });

  it('adds nothing to the pantry', async () => {
    // The whole point: a scan nobody confirmed must not quietly become
    // pantry rows a day later.
    const pantry = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.setScanItems('s1', [scanItem(), scanItem({ name: 'egg', canonicalId: 'egg' })]);
      await agent.expireScan('s1');
      return agent.listPantry();
    });
    expect(pantry).toHaveLength(0);
  });

  it('does nothing to a scan that was already confirmed', async () => {
    // A timeout firing after a late confirm must not undo it or re-notify.
    const result = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.setScanItems('s1', [scanItem()]);
      await agent.commitScan('s1', [scanItem()]);

      const expired = await agent.expireScan('s1');
      return { expired, scan: await agent.getScan('s1'), pantry: await agent.listPantry() };
    });

    expect(result.expired.expired).toBe(false);
    expect(result.scan?.status).toBe('done');
    expect(result.pantry).toHaveLength(1);
  });

  it('is idempotent, so a retried timeout step does not re-notify', async () => {
    const inbox = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.setScanItems('s1', [scanItem()]);
      await agent.expireScan('s1');
      await agent.expireScan('s1');
      return agent.listInbox();
    });
    expect(inbox).toHaveLength(1);
  });

  it('shows up as unread in the synced state', async () => {
    const state = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.setScanItems('s1', [scanItem()]);
      await agent.expireScan('s1');
      return agent.snapshot();
    });
    expect(state.unreadInbox).toBe(1);
  });
});

/* ------------------------------- deferred run ----------------------------- */

describe('a run the budget refused', () => {
  it('tells the user and closes the scan', async () => {
    // Section 6: "the run ends as `deferred` and the user gets an inbox
    // message."
    const result = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', 'wf-1');
      await agent.notifyScanDeferred('s1', 'account_exhausted');
      await agent.failScan('s1', 'deferred: account_exhausted');
      return { scan: await agent.getScan('s1'), inbox: await agent.listInbox() };
    });

    expect(result.scan?.status).toBe('failed');
    expect(result.inbox[0]?.body).toContain('account_exhausted');
  });
});

/* ------------------------------- scan status ------------------------------ */

describe('the scan status column', () => {
  it('moves processing to awaiting_confirm when the items land', async () => {
    // Section 6: a parked Workflow reports `running`, never `waiting`, so
    // this column is the only thing that knows a confirm list is ready.
    const statuses = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      const before = (await agent.getScan('s1'))?.status;
      await agent.setScanItems('s1', [scanItem()]);
      return { before, after: (await agent.getScan('s1'))?.status };
    });
    expect(statuses).toEqual({ before: 'processing', after: 'awaiting_confirm' });
  });

  it('records a failure with its reason', async () => {
    const scan = await withAgent(async (agent) => {
      await agent.createScan('s1', 'uploads/u/s1.jpg', null);
      await agent.failScan('s1', 'The upload is gone.');
      return agent.getScan('s1');
    });
    expect(scan).toMatchObject({ status: 'failed', error: 'The upload is gone.' });
  });
});
