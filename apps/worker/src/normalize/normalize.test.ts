import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaxonomy } from '@cooked/safety';
import type { Ingredient } from '@cooked/shared';
import { describe, expect, it, vi } from 'vitest';
import { type Classifier, normalizeWithModel } from './index.js';
import { normalize, parseQuantity, singularise, splitPhrases } from './normalize.js';

/**
 * The normalizer against the real seed taxonomy, not a fixture.
 *
 * A fixture would prove the parser works and tell us nothing about whether
 * "dhaniya" is actually in the data. Most of the value here is the join
 * between the two.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, '..', '..', '..', '..', 'seed', 'ingredients.json');

interface SeedRow {
  canonical_id: string;
  name: string;
  aliases: string[];
  category: Ingredient['category'];
  default_unit: Ingredient['defaultUnit'];
  default_shelf_days: number | null;
  allergens: Ingredient['allergens'];
  diet_flags: Ingredient['dietFlags'];
}

const taxonomy = createTaxonomy(
  (JSON.parse(readFileSync(SEED, 'utf8')) as SeedRow[]).map((r) => ({
    canonicalId: r.canonical_id,
    name: r.name,
    aliases: r.aliases,
    category: r.category,
    defaultUnit: r.default_unit,
    defaultShelfDays: r.default_shelf_days,
    allergens: r.allergens,
    dietFlags: r.diet_flags,
  })),
);

const NOW = new Date('2026-09-26T00:00:00Z');
const run = (text: string) => normalize(text, { taxonomy, now: NOW });
const one = (text: string) => {
  const r = run(text);
  expect(r.items, `"${text}" produced ${r.items.length} items`).toHaveLength(1);
  return r.items[0]!;
};

/* ------------------------- the phrases from the brief --------------------- */

describe('the cases named in the brief', () => {
  it('"bought 1kg paneer, 6 eggs, a bunch of dhaniya" gives three items', () => {
    const { items } = run('bought 1kg paneer, 6 eggs, a bunch of dhaniya');
    expect(items).toHaveLength(3);

    expect(items[0]).toMatchObject({
      canonicalId: 'paneer',
      quantity: 1,
      unit: 'kg',
      qtyConfidence: 'exact',
    });
    expect(items[1]).toMatchObject({ canonicalId: 'egg', quantity: 6, unit: 'piece' });
    expect(items[2]).toMatchObject({
      canonicalId: 'coriander_leaves',
      quantity: 1,
      unit: 'bunch',
    });
  });

  it('"a bunch" is one bunch and exact, because the count is definite', () => {
    // Section 5 turns approx into "about" in the reply. "A bunch" is exactly
    // one bunch; "some dhaniya" is not.
    expect(one('a bunch of dhaniya')).toMatchObject({ quantity: 1, unit: 'bunch', qtyConfidence: 'exact' });
    expect(one('some dhaniya')).toMatchObject({ unit: 'bunch', qtyConfidence: 'approx' });
  });

  it('"2 packets" keeps the container as a packet', () => {
    expect(one('2 packets of poha')).toMatchObject({
      canonicalId: 'poha',
      quantity: 2,
      unit: 'packet',
      qtyConfidence: 'exact',
    });
  });

  it('"1.5kg" parses glued decimals', () => {
    expect(one('1.5kg aloo')).toMatchObject({ canonicalId: 'potato', quantity: 1.5, unit: 'kg' });
  });

  it('"½ cup" parses a vulgar fraction', () => {
    expect(one('½ cup curd')).toMatchObject({ canonicalId: 'yoghurt', quantity: 0.5, unit: 'cup' });
  });

  it('"dhaniya" alone resolves and defaults sensibly', () => {
    expect(one('dhaniya')).toMatchObject({
      canonicalId: 'coriander_leaves',
      quantity: 1,
      unit: 'bunch',
      qtyConfidence: 'approx',
    });
  });

  it('"2 pyaaz" resolves a Hindi alias with an implied piece unit', () => {
    expect(one('2 pyaaz')).toMatchObject({
      canonicalId: 'onion',
      quantity: 2,
      unit: 'piece',
      qtyConfidence: 'exact',
    });
  });
});

/* ------------------------- sixty real-world phrases ----------------------- */

interface Case {
  text: string;
  id: string | null;
  qty?: number;
  unit?: string;
  conf?: 'exact' | 'approx';
}

const PHRASES: Case[] = [
  // weights, glued and spaced
  { text: '1kg paneer', id: 'paneer', qty: 1, unit: 'kg', conf: 'exact' },
  { text: '1 kg paneer', id: 'paneer', qty: 1, unit: 'kg' },
  { text: '250g butter', id: 'butter', qty: 250, unit: 'g' },
  { text: '500 grams chicken', id: 'chicken', qty: 500, unit: 'g' },
  { text: '2kg atta', id: 'wheat_flour', qty: 2, unit: 'kg' },
  { text: '1.5kg aloo', id: 'potato', qty: 1.5, unit: 'kg' },
  { text: '0.5 kg tamatar', id: 'tomato', qty: 0.5, unit: 'kg' },
  { text: '100gm kaju', id: 'cashew', qty: 100, unit: 'g' },
  { text: 'half a kilo of rajma', id: 'rajma', qty: 0.5, unit: 'kg' },
  { text: 'aadha kilo moong dal', id: 'moong_dal', qty: 0.5, unit: 'kg' },
  { text: 'dedh kilo chawal', id: 'rice_basmati', qty: 1.5, unit: 'kg' },
  // volumes
  { text: '1 litre milk', id: 'milk', qty: 1, unit: 'l' },
  { text: 'two litres of milk', id: 'milk', qty: 2, unit: 'l' },
  { text: '500ml curd', id: 'yoghurt', qty: 500, unit: 'ml' },
  { text: '200 ml cream', id: 'fresh_cream', qty: 200, unit: 'ml' },
  // spoons and cups
  { text: '3 tbsp ghee', id: 'ghee', qty: 3, unit: 'tbsp' },
  { text: '2 tablespoons of honey', id: 'honey', qty: 2, unit: 'tbsp' },
  { text: '1 tsp jeera', id: 'cumin_seed', qty: 1, unit: 'tsp' },
  { text: '½ cup curd', id: 'yoghurt', qty: 0.5, unit: 'cup' },
  { text: '1/2 cup besan', id: 'besan', qty: 0.5, unit: 'cup' },
  { text: '1 1/2 cups rice', id: 'rice_basmati', qty: 1.5, unit: 'cup' },
  { text: '1½ cup sooji', id: 'sooji', qty: 1.5, unit: 'cup' },
  { text: '2 katori dahi', id: 'yoghurt', qty: 2, unit: 'cup' },
  { text: 'a pinch of hing', id: 'asafoetida', qty: 1, unit: 'pinch' },
  { text: 'chutki bhar haldi', id: 'turmeric', qty: 1, unit: 'pinch' },
  // counts
  { text: '6 eggs', id: 'egg', qty: 6, unit: 'piece' },
  { text: 'a dozen eggs', id: 'egg', qty: 12, unit: 'piece' },
  { text: 'half a dozen eggs', id: 'egg', qty: 6, unit: 'piece' },
  { text: '2 pyaaz', id: 'onion', qty: 2, unit: 'piece' },
  { text: '4 tomatoes', id: 'tomato', qty: 4, unit: 'piece' },
  { text: 'three nimbu', id: 'lemon', qty: 3, unit: 'piece' },
  { text: 'do kela', id: 'banana', qty: 2, unit: 'piece' },
  { text: '5 green chillies', id: 'green_chilli', qty: 5, unit: 'piece' },
  // containers
  { text: '2 packets of poha', id: 'poha', qty: 2, unit: 'packet' },
  { text: 'a packet of maida', id: 'maida', qty: 1, unit: 'packet' },
  { text: '1 tin of coconut milk', id: 'coconut_milk', qty: 1, unit: 'packet' },
  { text: 'a bottle of soy sauce', id: 'soy_sauce', qty: 1, unit: 'packet' },
  { text: '2 boxes of cornflakes', id: 'cornflakes', qty: 2, unit: 'packet' },
  // bunches
  { text: 'a bunch of dhaniya', id: 'coriander_leaves', qty: 1, unit: 'bunch' },
  { text: '2 bunches of palak', id: 'palak', qty: 2, unit: 'bunch' },
  { text: 'ek gaddi methi', id: 'methi_leaves', qty: 1, unit: 'bunch' },
  { text: 'pudina', id: 'mint_leaves', qty: 1, unit: 'bunch' },
  { text: 'kadi patta', id: 'curry_leaves', qty: 1, unit: 'bunch' },
  // vague amounts
  { text: 'some paneer', id: 'paneer', conf: 'approx' },
  { text: 'a few tomatoes', id: 'tomato', qty: 3, conf: 'approx' },
  { text: 'a couple of onions', id: 'onion', qty: 2, conf: 'approx' },
  { text: 'thoda sa namak', id: 'table_salt', conf: 'approx' },
  // Hindi and romanised names
  { text: 'lehsun', id: 'garlic' },
  { text: 'adrak', id: 'ginger' },
  { text: 'haldi', id: 'turmeric' },
  { text: 'kali mirch', id: 'black_pepper' },
  { text: 'sarson ka tel', id: 'mustard_oil' },
  { text: 'besan', id: 'besan' },
  { text: 'gud', id: 'jaggery' },
  { text: 'sendha namak', id: 'rock_salt' },
  { text: 'kasuri methi', id: 'dried_fenugreek_leaves' },
  { text: 'chhole', id: 'kabuli_chana' },
  { text: 'arhar dal', id: 'toor_dal' },
  { text: 'sabut moong', id: 'moong_whole' },
  // plurals and descriptors
  { text: '3 potatoes', id: 'potato', qty: 3 },
  { text: 'carrots', id: 'carrot' },
  { text: '2 mangoes', id: 'mango', qty: 2 },
  { text: 'cherries', id: 'cherry' },
  { text: 'paneer cubes', id: 'paneer' },
  // things the taxonomy genuinely does not know
  { text: 'some mystery masala from the market', id: null },
  { text: '2 packets of bhel puri mix', id: null },
];

describe('sixty-plus real phrases', () => {
  it('has at least 60 cases', () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(PHRASES)('$text', ({ text, id, qty, unit, conf }) => {
    const item = one(text);
    expect(item.canonicalId, `"${text}" resolved to ${item.canonicalId}`).toBe(id);
    if (qty !== undefined) expect(item.quantity).toBeCloseTo(qty, 3);
    if (unit !== undefined) expect(item.unit).toBe(unit);
    if (conf !== undefined) expect(item.qtyConfidence).toBe(conf);
  });
});

/* -------------------------------- splitting ------------------------------- */

describe('splitting a message into items', () => {
  it('strips the leading verb', () => {
    expect(splitPhrases('bought 1kg paneer')).toEqual(['1kg paneer']);
    expect(splitPhrases('i picked up some atta')).toEqual(['some atta']);
    expect(splitPhrases('we have 2 onions')).toEqual(['2 onions']);
  });

  it('splits on commas and "and"', () => {
    expect(splitPhrases('atta, milk and eggs')).toEqual(['atta', 'milk', 'eggs']);
  });

  it('handles a four-item list', () => {
    const { items } = run('bought 2kg atta, 1 litre milk, 6 eggs and a bunch of methi');
    expect(items.map((i) => i.canonicalId)).toEqual([
      'wheat_flour',
      'milk',
      'egg',
      'methi_leaves',
    ]);
  });

  it('produces no phantom items from trailing punctuation', () => {
    expect(run('paneer, , and').items).toHaveLength(1);
    expect(run('').items).toHaveLength(0);
    expect(run('   ').items).toHaveLength(0);
  });
});

/* -------------------------------- quantities ------------------------------ */

describe('quantity parsing in isolation', () => {
  it.each([
    [['2'], 2, 'exact'],
    [['1.5'], 1.5, 'exact'],
    [['½'], 0.5, 'exact'],
    [['1½'], 1.5, 'exact'],
    [['3/4'], 0.75, 'exact'],
    [['two'], 2, 'exact'],
    [['a'], 1, 'exact'],
    [['some'], 1, 'approx'],
    [['a', 'few'], 3, 'approx'],
  ])('%s -> %s (%s)', (tokens, value, confidence) => {
    const q = parseQuantity(tokens as string[]);
    expect(q.value).toBeCloseTo(value as number, 3);
    expect(q.confidence).toBe(confidence);
  });

  it('treats a missing quantity as an approximate one', () => {
    const q = parseQuantity(['paneer']);
    expect(q).toMatchObject({ value: 1, confidence: 'approx', consumed: 0, implied: true });
  });

  it('refuses to divide by zero', () => {
    expect(parseQuantity(['1/0']).implied).toBe(true);
  });
});

describe('singularise', () => {
  it.each([
    ['tomatoes', 'tomato'],
    ['cherries', 'cherry'],
    ['potatoes', 'potato'],
    ['eggs', 'egg'],
    ['bunches', 'bunch'],
  ])('%s -> %s', (input, expected) => {
    expect(singularise(input)).toBe(expected);
  });

  it('leaves words that are not plurals alone', () => {
    expect(singularise('rice')).toBeNull();
    expect(singularise('gas')).toBeNull();
  });
});

/* ------------------------------ default units ----------------------------- */

describe('the default unit comes from the taxonomy, not the parser', () => {
  /**
   * Before migration 0003 this lived in the normalizer as a bunch list plus a
   * per-category fallback, which could not tell coriander from a carrot. These
   * assert the value is now read off the ingredient.
   */
  it.each([
    ['dhaniya', 'bunch'],
    ['pudina', 'bunch'],
    ['milk', 'l'],
    ['mustard oil', 'l'],
    ['paneer', 'g'],
    ['haldi', 'g'],
    ['aloo', 'kg'],
    ['atta', 'kg'],
    ['nimbu', 'piece'],
    ['soy sauce', 'packet'],
  ])('"%s" with no unit defaults to %s', (text, unit) => {
    expect(one(text).unit).toBe(unit);
  });

  it('matches the value stored on the taxonomy entry exactly', () => {
    for (const name of ['dhaniya', 'milk', 'paneer', 'aloo', 'soy sauce']) {
      const item = one(name);
      const entry = taxonomy.byId(item.canonicalId as string);
      expect(item.unit, name).toBe(entry?.defaultUnit);
    }
  });

  it('is overridden by a unit the phrase states', () => {
    // The taxonomy says litres for milk; the user said cups.
    expect(one('2 cups milk').unit).toBe('cup');
    expect(one('500g milk').unit).toBe('g');
  });

  it('is overridden by a bare count, which always means pieces', () => {
    // "2 aloo" is two potatoes, not two kilos, even though the taxonomy
    // default for potato is kg.
    expect(one('2 aloo')).toMatchObject({ quantity: 2, unit: 'piece' });
    expect(one('aloo')).toMatchObject({ unit: 'kg' });
  });

  it('falls back to the category default only when the name is unknown', () => {
    const item = one('500 flibbertigibbets');
    expect(item.canonicalId).toBeNull();
    expect(item.unit).toBe('piece'); // counted, so pieces
    expect(one('some flibbertigibbet').unit).toBe('packet'); // category 'other'
  });

  it('every seed ingredient has a usable default unit', () => {
    for (const entry of taxonomy.all()) {
      expect(entry.defaultUnit, entry.canonicalId).toBeTruthy();
      expect(entry.defaultUnit, entry.canonicalId).not.toBe('to_taste');
    }
  });
});

/* --------------------------------- expiry --------------------------------- */

describe('expiry estimates', () => {
  it('adds the taxonomy shelf life to now', () => {
    // palak is 3 days in the seed.
    const item = one('palak');
    expect(item.expiresAt).toBe('2026-09-29T00:00:00.000Z');
    expect(item.expirySource).toBe('estimated');
  });

  it('gives a long shelf life to a dry good', () => {
    const rice = one('2kg basmati chawal');
    expect(Date.parse(rice.expiresAt as string) - NOW.getTime()).toBe(730 * 86_400_000);
  });

  it('leaves expiry null when the taxonomy has no shelf life', () => {
    expect(one('water').expiresAt).toBeNull();
  });

  it('leaves expiry null for an ingredient it could not resolve', () => {
    // Guessing a shelf life for an unknown thing would be inventing data.
    expect(one('some mystery masala from the market').expiresAt).toBeNull();
  });

  it('always reports the source as estimated, never label or user', () => {
    for (const item of run('1kg paneer, 6 eggs').items) {
      expect(item.expirySource).toBe('estimated');
    }
  });
});

/* ---------------------------- the model fallback -------------------------- */

describe('the 8B fallback', () => {
  it('is not called when the taxonomy resolves everything', async () => {
    const classify = vi.fn<Classifier>(async () => ({}));
    const out = await normalizeWithModel('1kg paneer, 6 eggs', { taxonomy, now: NOW, classify });
    expect(classify).not.toHaveBeenCalled();
    expect(out.modelCalled).toBe(false);
  });

  it('batches every miss into a single call', async () => {
    // Section 12: one inference for the message, not one per unknown item.
    const classify = vi.fn<Classifier>(async () => ({}));
    await normalizeWithModel('some widget, two doohickeys and a thingamajig', {
      taxonomy,
      now: NOW,
      classify,
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0].names.length).toBeGreaterThanOrEqual(3);
  });

  it('restricts the model to real canonical ids', async () => {
    const classify = vi.fn<Classifier>(async (req) => {
      expect(req.allowedIds).toContain('paneer');
      expect(req.allowedIds.length).toBeGreaterThan(700);
      return {};
    });
    await normalizeWithModel('some widget', { taxonomy, now: NOW, classify });
    expect(classify).toHaveBeenCalled();
  });

  it('applies a valid answer, with the category and expiry that follow', async () => {
    const classify: Classifier = async () => ({ widget: 'paneer' });
    const out = await normalizeWithModel('500g widget', { taxonomy, now: NOW, classify });
    expect(out.items[0]).toMatchObject({
      canonicalId: 'paneer',
      category: 'dairy',
      quantity: 500,
      unit: 'g',
      matchedBy: 'model',
    });
    expect(out.items[0]?.expiresAt).toBe('2026-09-29T00:00:00.000Z');
    expect(out.unresolved).toHaveLength(0);
  });

  it('discards an id that is not in the taxonomy', async () => {
    // A hallucinated id would carry another ingredient's allergen set.
    const classify: Classifier = async () => ({ widget: 'unobtainium' });
    const out = await normalizeWithModel('500g widget', { taxonomy, now: NOW, classify });
    expect(out.items[0]?.canonicalId).toBeNull();
    expect(out.unresolved).toEqual(['widget']);
  });

  it('keeps the item when the model has no answer', async () => {
    const classify: Classifier = async () => ({ widget: null });
    const out = await normalizeWithModel('500g widget', { taxonomy, now: NOW, classify });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.canonicalId).toBeNull();
  });

  it('survives a classifier that throws', async () => {
    const classify: Classifier = async () => {
      throw new Error('model timed out');
    };
    const out = await normalizeWithModel('500g widget', { taxonomy, now: NOW, classify });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.canonicalId).toBeNull();
  });

  it('does not let the model override a unit the user actually said', async () => {
    const classify: Classifier = async () => ({ widget: 'coriander_leaves' });
    const out = await normalizeWithModel('3 packets widget', { taxonomy, now: NOW, classify });
    // coriander defaults to bunch, but the message said packets.
    expect(out.items[0]).toMatchObject({ unit: 'packet', quantity: 3 });
  });
});

/* -------------------------- safety-adjacent behaviour --------------------- */

describe('it never guesses an identity', () => {
  it('leaves a near-miss unresolved rather than picking something close', () => {
    // "kaju katli" is a sweet; "kaju" is the nut. A fuzzy matcher would happily
    // collapse them, and the two have different allergens and diet flags.
    const item = one('200g kaju katli');
    expect(item.canonicalId).toBe('kaju_katli');

    // And a genuine near-miss stays null rather than snapping to a neighbour.
    expect(one('500g paneerish substance').canonicalId).toBeNull();
  });

  it('reports unresolved names so the caller can decide', () => {
    const { unresolved } = run('1kg paneer and 200g flibbertigibbet');
    expect(unresolved).toEqual(['flibbertigibbet']);
  });

  it('records how each item was matched', () => {
    const { items } = run('paneer, pyaaz, tomatoes, widget');
    expect(items.map((i) => i.matchedBy)).toEqual([
      'canonical_id',
      'alias',
      'singular',
      'unresolved',
    ]);
  });
});
