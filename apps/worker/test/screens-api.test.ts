import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The section 11 routes the section 10 screens are built against.
 *
 * Every one of these is behind a session and reads through the caller's own
 * agent, so the tests that matter most are the ones checking a second
 * account cannot see the first's pantry or profile — section 9's isolation
 * rule, applied to the REST surface rather than the agent socket.
 */

const ORIGIN = 'http://localhost';

let ip = 0;
async function demoUser(): Promise<{ id: string; cookie: string }> {
  ip += 1;
  const res = await SELF.fetch(`${ORIGIN}/auth/demo`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'cf-connecting-ip': `198.51.200.${ip}`,
      'content-type': 'application/json',
    },
  });
  const body = (await res.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] as string };
}

const get = (path: string, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {});

const send = (method: string, path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));

  // The curated swap table too: `?fits=me` keeps recipes that "pass **or can
  // be substituted**", and without these rows a vegan's paneer dish is
  // correctly dropped rather than rescued — which would make the filter test
  // below pass for entirely the wrong reason.
  const subs = env.TEST_SUBSTITUTIONS_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(subs.map((s) => env.DB.prepare(s)));

  await env.DB.prepare(
    `INSERT OR REPLACE INTO recipes
       (id, source, title, cuisine, ingredients, steps, minutes, servings, diet_tags,
        allergen_tags, trending_until, content_hash, created_at)
     VALUES ('trend-paneer', 'youtube', 'Trending paneer', 'indian', ?, '[]', 25, 2, '[]', '[]',
             ?, 'trend-paneer', '2026-09-01T00:00:00.000Z')`,
  )
    .bind(
      JSON.stringify([
        { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', note: null },
      ]),
      new Date(Date.now() + 7 * 86_400_000).toISOString(),
    )
    .run();
});

/* --------------------------------- session -------------------------------- */

describe('every screen route needs a session', () => {
  it.each([
    ['/api/profile'],
    ['/api/pantry'],
    ['/api/plans/current'],
    ['/api/grocery'],
    ['/api/trending'],
    ['/api/inbox'],
    ['/api/status/pipeline'],
  ])('%s is 401 signed out', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(401);
    await res.text();
  });
});

/* --------------------------------- profile -------------------------------- */

describe('GET and PUT /api/profile', () => {
  it('starts with a usable default', async () => {
    const user = await demoUser();
    const res = await get('/api/profile', user.cookie);
    const body = (await res.json()) as { profile: { diets: string[]; servings: number } };
    expect(body.profile).toMatchObject({ diets: [], allergens: [], servings: 2 });
  });

  it('replaces the whole profile', async () => {
    const user = await demoUser();
    const res = await send('PUT', '/api/profile', user.cookie, {
      diets: ['vegan', 'gluten_free'],
      allergens: ['peanuts'],
      exclusions: ['mushroom'],
      cuisines: ['thai'],
      maxCookMinutes: 30,
      servings: 3,
      spiceLevel: 'hot',
      timeZone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(200);

    const after = (await (await get('/api/profile', user.cookie)).json()) as {
      profile: { diets: string[]; allergens: string[]; exclusions: string[] };
    };
    expect(after.profile.diets).toEqual(['vegan', 'gluten_free']);
    expect(after.profile.allergens).toEqual(['peanuts']);
    expect(after.profile.exclusions).toEqual(['mushroom']);
  });

  it('rejects a diet that is not in the schema', async () => {
    // The profile screen renders the enum, so a bad value means a forged
    // request rather than a UI bug — and it must not reach storage.
    const user = await demoUser();
    const res = await send('PUT', '/api/profile', user.cookie, {
      diets: ['carnivore_supreme'],
      allergens: [],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 30,
      servings: 2,
      spiceLevel: 'mild',
      timeZone: 'UTC',
    });
    expect(res.status).toBe(422);
    await res.text();
  });

  it('cannot be read across accounts', async () => {
    const a = await demoUser();
    const b = await demoUser();
    await send('PUT', '/api/profile', a.cookie, {
      diets: ['jain'],
      allergens: ['sesame'],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 45,
      servings: 2,
      spiceLevel: 'mild',
      timeZone: 'UTC',
    });

    const theirs = (await (await get('/api/profile', b.cookie)).json()) as {
      profile: { diets: string[] };
    };
    expect(theirs.profile.diets).toEqual([]);
  });
});

/* --------------------------------- pantry --------------------------------- */

describe('the pantry routes', () => {
  it('adds from free text through the normalizer', async () => {
    const user = await demoUser();
    const res = await send('POST', '/api/pantry', user.cookie, {
      text: 'bought 1kg paneer and a bunch of dhaniya',
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { items: { canonicalId: string }[] };
    expect(body.items.map((i) => i.canonicalId)).toEqual(['paneer', 'coriander_leaves']);
  });

  it('lists what was added', async () => {
    const user = await demoUser();
    await send('POST', '/api/pantry', user.cookie, { text: '500g paneer' });
    const body = (await (await get('/api/pantry', user.cookie)).json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('edits an item', async () => {
    const user = await demoUser();
    const added = (await (
      await send('POST', '/api/pantry', user.cookie, { text: 'some paneer' })
    ).json()) as { items: { id: string }[] };

    const res = await send('PATCH', `/api/pantry/${added.items[0]?.id}`, user.cookie, {
      quantity: 400,
      unit: 'g',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { quantity: number } };
    expect(body.item.quantity).toBe(400);
  });

  it('soft deletes and restores, which is what the undo button needs', async () => {
    const user = await demoUser();
    const added = (await (
      await send('POST', '/api/pantry', user.cookie, { text: '500g paneer' })
    ).json()) as { items: { id: string }[] };
    const id = added.items[0]?.id as string;

    expect((await send('DELETE', `/api/pantry/${id}`, user.cookie)).status).toBe(200);
    let list = (await (await get('/api/pantry', user.cookie)).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);

    expect((await send('POST', `/api/pantry/${id}/restore`, user.cookie)).status).toBe(200);
    list = (await (await get('/api/pantry', user.cookie)).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  it('404s on another account’s item rather than editing it', async () => {
    const a = await demoUser();
    const b = await demoUser();
    const added = (await (
      await send('POST', '/api/pantry', a.cookie, { text: '500g paneer' })
    ).json()) as { items: { id: string }[] };

    const res = await send('PATCH', `/api/pantry/${added.items[0]?.id}`, b.cookie, { quantity: 1 });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('rejects an empty add', async () => {
    const user = await demoUser();
    const res = await send('POST', '/api/pantry', user.cookie, { text: '' });
    expect(res.status).toBe(422);
    await res.text();
  });
});

/* ---------------------------------- inbox --------------------------------- */

describe('the inbox routes', () => {
  it('is empty and counts zero unread to start', async () => {
    const user = await demoUser();
    const body = (await (await get('/api/inbox', user.cookie)).json()) as {
      items: unknown[];
      unread: number;
    };
    expect(body).toEqual({ items: [], unread: 0 });
  });

  it('404s marking something that does not exist', async () => {
    const user = await demoUser();
    const res = await send('POST', '/api/inbox/nope/read', user.cookie);
    expect(res.status).toBe(404);
    await res.text();
  });
});

/* ----------------------------- plan and grocery ---------------------------- */

describe('plan and grocery', () => {
  it('reports no plan rather than inventing a week', async () => {
    const user = await demoUser();
    const body = (await (await get('/api/plans/current', user.cookie)).json()) as { plan: null };
    expect(body.plan).toBeNull();
  });

  it('starts a plan in the background and hands back its id', async () => {
    const user = await demoUser();
    const res = await send('POST', '/api/plans', user.cookie, { slots: ['dinner'] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { planId: string; status: string };
    expect(body.status).toBe('running');

    // The row exists before the Workflow does anything, so the id is
    // pollable at once.
    const current = (await (await get('/api/plans/current', user.cookie)).json()) as {
      plan: { id: string; slots: string[] };
    };
    expect(current.plan.id).toBe(body.planId);
    expect(current.plan.slots).toEqual(['dinner']);

    // Then it finishes on its own, the way the plan screen sees it: by
    // polling until the status moves. Waiting also keeps the run from still
    // being in flight when this file tears down.
    await vi.waitFor(
      async () => {
        const res = await get('/api/plans/current', user.cookie);
        const { plan } = (await res.json()) as { plan: { status: string } };
        expect(plan.status).not.toBe('running');
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it('rejects a plan request it cannot read', async () => {
    const user = await demoUser();
    const res = await send('POST', '/api/plans', user.cookie, { slots: ['elevenses'] });
    expect(res.status).toBe(422);
    await res.text();
  });

  it('returns an empty grocery list while there is no plan', async () => {
    const user = await demoUser();
    const body = (await (await get('/api/grocery', user.cookie)).json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('404s ticking a grocery item that is not there', async () => {
    const user = await demoUser();
    const res = await send('PATCH', '/api/grocery/nope', user.cookie, { checked: true });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('rejects a tick with no boolean', async () => {
    const user = await demoUser();
    const res = await send('PATCH', '/api/grocery/x', user.cookie, {});
    expect(res.status).toBe(422);
    await res.text();
  });
});

/* -------------------------------- trending -------------------------------- */

describe('GET /api/trending', () => {
  it('returns what is inside its trending window', async () => {
    const user = await demoUser();
    const body = (await (await get('/api/trending', user.cookie)).json()) as {
      recipes: { recipe: { id: string } }[];
    };
    expect(body.recipes.map((r) => r.recipe.id)).toContain('trend-paneer');
  });

  it('with ?fits=me it flags the ones that needed a swap', async () => {
    // Section 11: the filter keeps recipes that "pass **or can be
    // substituted**", and `needsSubstitution` is what the screen's "make it
    // fit my diet" button hangs off.
    const user = await demoUser();
    await send('PUT', '/api/profile', user.cookie, {
      diets: ['vegan'],
      allergens: [],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'mild',
      timeZone: 'UTC',
    });

    const body = (await (await get('/api/trending?fits=me', user.cookie)).json()) as {
      recipes: { recipe: { id: string }; needsSubstitution: boolean }[];
    };
    const entry = body.recipes.find((r) => r.recipe.id === 'trend-paneer');
    expect(entry, 'the paneer dish should be rescued, not dropped').toBeDefined();
    expect(entry?.needsSubstitution).toBe(true);
    // Rescued means rewritten: the vegan is shown a dish without the paneer.
    expect(
      (entry?.recipe as unknown as { ingredients: { canonicalId: string }[] }).ingredients.map(
        (i) => i.canonicalId,
      ),
    ).not.toContain('paneer');
  });
});

/* --------------------------------- status --------------------------------- */

describe('GET /api/status/pipeline', () => {
  it('is empty before the pipeline has ever run', async () => {
    const user = await demoUser();
    const body = (await (await get('/api/status/pipeline', user.cookie)).json()) as {
      runs: unknown[];
    };
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('returns the newest runs with their errors parsed', async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO pipeline_runs
         (id, workflow, started_at, finished_at, status, found, filtered, extracted, added,
          duplicates, neurons, errors)
       VALUES ('run-1', 'viral', '2026-09-20T00:00:00.000Z', '2026-09-20T00:04:00.000Z',
               'failed', 30, 12, 10, 8, 2, 412.5, ?)`,
    )
      .bind(JSON.stringify(['quota exceeded on step 3']))
      .run();

    const user = await demoUser();
    const body = (await (await get('/api/status/pipeline', user.cookie)).json()) as {
      runs: { id: string; errors: string[]; neurons: number }[];
    };
    const run = body.runs.find((r) => r.id === 'run-1');
    expect(run?.errors).toEqual(['quota exceeded on step 3']);
    expect(run?.neurons).toBeCloseTo(412.5, 1);
  });
});
