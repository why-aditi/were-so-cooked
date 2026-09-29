import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRunner } from '../src/agent/adapters.js';
import type { KitchenAgent } from '../src/agent/kitchen-agent.js';
import { d1RecipeSearch } from '../src/recipes/store.js';

/**
 * `suggest_recipes` and `substitute` against the real catalog.
 *
 * `src/recipes/*.test.ts` covers the orchestration with everything faked.
 * What only this can show is the join: that the real seeded taxonomy and the
 * real curated `substitutions` table actually produce the swaps section 7
 * promises, that the SQL filters work, and that a recipe the model invented
 * survives a round trip into D1 and back out as a catalog hit.
 */

type Agent = KitchenAgent;

let n = 0;
const agentFor = async (): Promise<Agent> => {
  const agent = env.KITCHEN_AGENT.get(
    env.KITCHEN_AGENT.idFromName(`recipes-${(n += 1)}-${crypto.randomUUID()}`),
  ) as unknown as Agent;
  await agent.identify(`user-${crypto.randomUUID()}`, false);
  return agent;
};

/** A model that returns exactly this JSON, so no neuron is ever spent. */
const returns = (text: string): ModelRunner =>
  vi.fn(async () => ({
    text,
    toolCalls: [],
    usage: { promptTokens: 800, completionTokens: 600 },
  }));

const draftJson = (
  title: string,
  ingredients: { name: string; quantity?: number; unit?: string }[],
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    recipes: [
      {
        title,
        cuisine: 'indian',
        minutes: 30,
        servings: 2,
        ingredients: ingredients.map((i) => ({
          name: i.name,
          quantity: i.quantity ?? 100,
          unit: i.unit ?? 'g',
          note: null,
        })),
        steps: ['cook it'],
        ...over,
      },
    ],
  });

const CATALOG = [
  {
    id: 'cat-palak-paneer',
    title: 'Palak paneer',
    cuisine: 'indian',
    minutes: 30,
    ingredients: [
      { canonicalId: 'paneer', name: 'paneer', quantity: 200, unit: 'g', note: null },
      { canonicalId: 'palak', name: 'spinach', quantity: 1, unit: 'bunch', note: null },
    ],
  },
  {
    id: 'cat-chicken-curry',
    title: 'Chicken curry',
    cuisine: 'indian',
    minutes: 45,
    ingredients: [
      { canonicalId: 'chicken', name: 'chicken', quantity: 500, unit: 'g', note: null },
    ],
  },
  {
    id: 'cat-dal-tadka',
    title: 'Dal tadka',
    cuisine: 'indian',
    minutes: 25,
    ingredients: [
      { canonicalId: 'toor_dal', name: 'toor dal', quantity: 200, unit: 'g', note: null },
    ],
  },
];

beforeAll(async () => {
  // The real taxonomy and the real curated swap table. Faking either would
  // make every assertion below about the fake instead of the product.
  const ingredients = env.TEST_SEED_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(ingredients.map((s) => env.DB.prepare(s)));

  const subs = env.TEST_SUBSTITUTIONS_SQL.split('\n').filter((l) => l.startsWith('INSERT'));
  await env.DB.batch(subs.map((s) => env.DB.prepare(s)));

  await env.DB.batch(
    CATALOG.map((r) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO recipes
           (id, source, title, cuisine, ingredients, steps, minutes, servings,
            diet_tags, allergen_tags, content_hash, created_at)
         VALUES (?, 'seed', ?, ?, ?, '[]', ?, 2, '[]', '[]', ?, '2026-09-01T00:00:00.000Z')`,
      ).bind(r.id, r.title, r.cuisine, JSON.stringify(r.ingredients), r.minutes, r.id),
    ),
  );
});

/* ------------------------------ catalog search ----------------------------- */

describe('the D1 catalog', () => {
  const search = () => d1RecipeSearch(env.DB);

  it('finds a recipe by id and by title, case-insensitively', async () => {
    expect((await search().byId('cat-dal-tadka'))?.title).toBe('Dal tadka');
    expect((await search().byTitle('dal TADKA'))?.id).toBe('cat-dal-tadka');
    expect(await search().byTitle('nani special')).toBeNull();
  });

  it('matches free text against title and cuisine', async () => {
    const byTitle = await search().find({ text: 'palak' });
    expect(byTitle.map((r) => r.id)).toEqual(['cat-palak-paneer']);
    expect((await search().find({ text: 'indian' })).length).toBeGreaterThanOrEqual(3);
  });

  it('honours a time limit', async () => {
    const quick = await search().find({ maxMinutes: 25 });
    expect(quick.map((r) => r.id)).toEqual(['cat-dal-tadka']);
  });

  it('parses the JSON columns back into a real recipe', async () => {
    const r = await search().byId('cat-palak-paneer');
    expect(r?.ingredients).toHaveLength(2);
    expect(r?.ingredients[0]?.canonicalId).toBe('paneer');
    expect(r?.steps).toEqual([]);
  });
});

/* ------------------------------ suggest_recipes ---------------------------- */

describe('suggest_recipes against the real taxonomy', () => {
  it('returns catalog dishes and spends nothing', async () => {
    // `limit: 1` because the catalog fills it. Ask for more than the catalog
    // holds and generation kicks in, which is the next test.
    const agent = await agentFor();
    const out = await agent.suggestRecipes({ query: 'dal', limit: 1 });
    expect(out.suggestions.map((s) => s.recipe.title)).toEqual(['Dal tadka']);
    expect(out.modelCalled).toBe(false);
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('ranks what the pantry covers first', async () => {
    const agent = await agentFor();
    await agent.addPantryItems('500g paneer, 1 bunch palak');
    const out = await agent.suggestRecipes({ query: 'indian', limit: 3 });
    expect(out.suggestions[0]?.recipe.title).toBe('Palak paneer');
    expect(out.suggestions[0]?.pantryCoverage).toBe(1);
    expect(out.suggestions[0]?.missing).toEqual([]);
  });

  it('rebuilds a meat dish for a vegan from the curated table', async () => {
    // Section 7's own table: "Chicken | Vegan | Soya chaap or extra-firm
    // tofu". The seed carries all three options, so the right outcome is a
    // rewritten dish, not a hidden one — a vegan should not be told there is
    // nothing to eat.
    const agent = await agentFor();
    await agent.setProfile({
      diets: ['vegan'],
      allergens: [],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'UTC',
    });

    const out = await agent.suggestRecipes({ query: 'chicken curry', limit: 1 });
    const curry = out.suggestions.find((s) => s.recipe.title === 'Chicken curry');
    expect(curry).toBeDefined();
    expect(curry?.recipe.ingredients.map((i) => i.canonicalId)).not.toContain('chicken');
    expect(['soya_chaap', 'tofu_firm', 'jackfruit_raw']).toContain(
      curry?.swaps[0]?.toCanonicalId,
    );
    expect(curry?.recipe.dietTags).toContain('vegan');
  });

  it('rewrites a dish rather than hiding it when the curated table has a swap', async () => {
    // Section 7's whole point: a vegan should be offered palak paneer made
    // with something else, not told there is nothing to eat.
    const agent = await agentFor();
    await agent.setProfile({
      diets: ['vegan'],
      allergens: [],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'UTC',
    });

    const out = await agent.suggestRecipes({ query: 'palak', limit: 3 });
    const palak = out.suggestions.find((s) => s.recipe.title === 'Palak paneer');
    expect(palak).toBeDefined();
    expect(palak?.swaps[0]?.fromName).toBe('paneer');
    expect(palak?.recipe.ingredients.map((i) => i.canonicalId)).not.toContain('paneer');
    // Section 7: the engine owns these, whatever the row claimed.
    expect(palak?.recipe.allergenTags).not.toContain('milk');
  });

  it('generates when the catalog has nothing and stores what survives', async () => {
    const agent = await agentFor();
    const out = await agent.suggestRecipes(
      { query: 'zzz nothing matches this', limit: 2 },
      { model: returns(draftJson('Jeera aloo', [{ name: 'aloo' }, { name: 'jeera' }])) },
    );

    expect(out.modelCalled).toBe(true);
    expect(out.suggestions.map((s) => s.recipe.title)).toContain('Jeera aloo');

    // Section 12: generated once, reused for every user. The next lookup is
    // a catalog hit, not a model call.
    expect((await d1RecipeSearch(env.DB).byTitle('Jeera aloo'))?.source).toBe('llm');
  });

  it('resolves generated ingredient names through the taxonomy', async () => {
    const agent = await agentFor();
    const out = await agent.suggestRecipes(
      { query: 'zzz also nothing', limit: 1 },
      // Hindi names the seed carries as aliases.
      { model: returns(draftJson('Aloo palak', [{ name: 'dhaniya' }, { name: 'palak' }])) },
    );
    const ids = out.suggestions[0]?.recipe.ingredients.map((i) => i.canonicalId);
    expect(ids).toContain('coriander_leaves');
    expect(ids).toContain('palak');
  });

  it('discards diet tags a generated recipe tried to claim', async () => {
    const agent = await agentFor();
    const out = await agent.suggestRecipes(
      { query: 'zzz claims', limit: 1 },
      {
        model: returns(
          draftJson('Definitely vegan paneer', [{ name: 'paneer' }], {
            dietTags: ['vegan'],
            allergenTags: [],
          }),
        ),
      },
    );
    const r = out.suggestions[0]?.recipe;
    expect(r?.dietTags).not.toContain('vegan');
    expect(r?.allergenTags).toContain('milk');
  });

  it('hides a generated recipe naming something the taxonomy cannot verify', async () => {
    // Unresolvable is indistinguishable from a hidden allergen for anyone
    // with an allergy (section 7).
    const agent = await agentFor();
    await agent.setProfile({
      diets: [],
      allergens: ['peanuts'],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'UTC',
    });

    const out = await agent.suggestRecipes(
      { query: 'zzz mystery', limit: 1 },
      { model: returns(draftJson('Mystery bowl', [{ name: 'xyzzy paste' }])) },
    );
    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped.map((d) => d.title)).toContain('Mystery bowl');
  });

  it('answers from the catalog when the model returns rubbish', async () => {
    const agent = await agentFor();
    const out = await agent.suggestRecipes(
      { query: 'dal', limit: 4 },
      { model: returns('I am a teapot') },
    );
    expect(out.suggestions.map((s) => s.recipe.title)).toContain('Dal tadka');
  });
});

/* -------------------------------- substitute ------------------------------- */

describe('substitute against the real swap table', () => {
  it('returns a fitting dish untouched', async () => {
    const agent = await agentFor();
    const out = await agent.substituteRecipe({ recipeTitle: 'Dal tadka' });
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.alreadyFitted).toBe(true);
  });

  it('applies an ad-hoc constraint without saving it', async () => {
    // Spike 3's "butter chicken but vegan".
    const agent = await agentFor();
    const out = await agent.substituteRecipe({
      recipeTitle: 'Palak paneer',
      extraDiets: ['vegan'],
    });

    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.swaps[0]?.fromName).toBe('paneer');
    expect((await agent.getProfile()).diets).toEqual([]);
  });

  it('explains each swap, with the rule that forced it', async () => {
    const agent = await agentFor();
    const out = await agent.substituteRecipe({
      recipeTitle: 'Palak paneer',
      extraDiets: ['vegan'],
    });
    const swap = out.status === 'ok' ? out.swaps[0] : undefined;
    expect(swap?.constraint).toBe('vegan');
    expect(swap?.explanation.length).toBeGreaterThan(10);
  });

  it('drops a dish nothing can rescue, and says why', async () => {
    // Toor dal has no row in the curated table, so a custom exclusion on it
    // leaves the engine with nowhere to go. The model is given a turn and
    // offers nothing, which is the real shape of this path.
    const agent = await agentFor();
    const out = await agent.substituteRecipe(
      { recipeTitle: 'Dal tadka', extraExclusions: ['toor dal'] },
      { model: returns('{"replacements":[]}') },
    );
    expect(out.status).toBe('dropped');
    expect(out.status === 'dropped' && out.reason.length).toBeGreaterThan(10);
  });

  it('takes a replacement from the model when the table has none', async () => {
    // Section 7 step 3, and the restriction that goes with it: the name has
    // to resolve to a taxonomy entry or it is discarded.
    const agent = await agentFor();
    const out = await agent.substituteRecipe(
      { recipeTitle: 'Dal tadka', extraExclusions: ['toor dal'] },
      { model: returns('{"replacements":[{"name":"masoor dal","note":null}]}') },
    );
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.swaps[0]?.fromName).toBe('toor dal');
  });

  it('ignores a replacement the taxonomy cannot verify', async () => {
    const agent = await agentFor();
    const out = await agent.substituteRecipe(
      { recipeTitle: 'Dal tadka', extraExclusions: ['toor dal'] },
      { model: returns('{"replacements":[{"name":"unobtainium dal","note":null}]}') },
    );
    expect(out.status).toBe('dropped');
  });

  it('invents a dish the catalog has never heard of, then rewrites it', async () => {
    const agent = await agentFor();
    const out = await agent.substituteRecipe(
      { recipeTitle: 'Butter paneer' },
      { model: returns(draftJson('Butter paneer', [{ name: 'paneer' }, { name: 'tamatar' }])) },
    );
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.source).toBe('generated');
    // And it is now in the catalog for the next person.
    expect(await d1RecipeSearch(env.DB).byTitle('Butter paneer')).not.toBeNull();
  });

  it('says so plainly when it can neither find nor build the dish', async () => {
    const agent = await agentFor();
    const out = await agent.substituteRecipe(
      { recipeTitle: 'Nani special' },
      { model: returns('no.') },
    );
    expect(out.status).toBe('not_found');
  });

  it('honours a profile allergy on top of the ad-hoc constraint', async () => {
    // Section 7's cashew case: a vegan with a tree-nut allergy must never be
    // handed cashew cream as the fix.
    const agent = await agentFor();
    await agent.setProfile({
      diets: [],
      allergens: ['tree_nuts'],
      exclusions: [],
      cuisines: [],
      maxCookMinutes: 60,
      servings: 2,
      spiceLevel: 'medium',
      timeZone: 'UTC',
    });

    const out = await agent.substituteRecipe({
      recipeTitle: 'Palak paneer',
      extraDiets: ['vegan'],
    });
    if (out.status === 'ok') {
      const ids = out.recipe.ingredients.map((i) => i.canonicalId);
      expect(ids).not.toContain('cashew');
      expect(ids).not.toContain('cashew_cream');
    }
  });
});
