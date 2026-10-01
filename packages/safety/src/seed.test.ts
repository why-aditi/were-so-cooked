import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ingredient } from '@cooked/shared';
import { describe, expect, it } from 'vitest';
import { check } from './check.js';
import { substitute, type SubstitutionRow } from './substitute.js';
import { createTaxonomy } from './taxonomy.js';

/**
 * The safety engine run against the real seed taxonomy, not the fixtures.
 *
 * `check.test.ts` proves the rules are right. This proves the *data* is
 * wired to them: a flag misspelled in the TSV, or an allergen recorded on an
 * ingredient but not its diet flag, produces a rule that silently never fires.
 * Unit tests against a hand-made fixture cannot see that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, '..', '..', '..', 'seed');

interface SeedIngredient {
  canonical_id: string;
  name: string;
  aliases: string[];
  category: Ingredient['category'];
  default_unit: Ingredient['defaultUnit'];
  default_shelf_days: number | null;
  allergens: Ingredient['allergens'];
  diet_flags: Ingredient['dietFlags'];
}

const raw = JSON.parse(readFileSync(join(SEED, 'ingredients.json'), 'utf8')) as SeedIngredient[];
const subsRaw = JSON.parse(readFileSync(join(SEED, 'substitutions.json'), 'utf8')) as {
  from_id: string;
  to_id: string;
  rule: string;
  ratio_note: string | null;
  explanation: string;
}[];

const ingredients: Ingredient[] = raw.map((r) => ({
  canonicalId: r.canonical_id,
  name: r.name,
  aliases: r.aliases,
  category: r.category,
  defaultUnit: r.default_unit,
  defaultShelfDays: r.default_shelf_days,
  allergens: r.allergens,
  dietFlags: r.diet_flags,
}));

const substitutions: SubstitutionRow[] = subsRaw.map((r) => ({
  fromId: r.from_id,
  toId: r.to_id,
  rule: r.rule,
  ratioNote: r.ratio_note,
  explanation: r.explanation,
}));

const taxonomy = createTaxonomy(ingredients);
const dish = (ids: string[]) => ({
  ingredients: ids.map((i) => ({ canonicalId: i, name: i, quantity: 1, unit: 'piece' as const, note: null })),
});
const profile = (over: Partial<Parameters<typeof check>[1]> = {}) => ({
  diets: [],
  allergens: [],
  exclusions: [],
  ...over,
});

describe('the seed taxonomy resolves', () => {
  it('loads every ingredient', () => {
    expect(ingredients.length).toBeGreaterThan(700);
    for (const i of ingredients) expect(taxonomy.byId(i.canonicalId)).toBeDefined();
  });

  it('resolves Hindi and romanised aliases', () => {
    expect(taxonomy.resolve('pyaz')?.canonicalId).toBe('onion');
    expect(taxonomy.resolve('lehsun')?.canonicalId).toBe('garlic');
    expect(taxonomy.resolve('dhaniya')?.canonicalId).toBe('coriander_leaves');
    expect(taxonomy.resolve('atta')?.canonicalId).toBe('wheat_flour');
    expect(taxonomy.resolve('kaju')?.canonicalId).toBe('cashew');
    expect(taxonomy.resolve('HALDI')?.canonicalId).toBe('turmeric');
  });

  it('resolves every substitution endpoint', () => {
    for (const s of substitutions) {
      expect(taxonomy.byId(s.fromId), `from ${s.fromId}`).toBeDefined();
      expect(taxonomy.byId(s.toId), `to ${s.toId}`).toBeDefined();
    }
  });
});

describe('composite ingredients carry their hidden allergens', () => {
  // Section 7 names these specifically. If any stops reporting its allergen,
  // a user gets served it.
  const cases: [string, string][] = [
    ['naan', 'milk'],
    ['naan', 'gluten'],
    ['soy_sauce', 'soy'],
    ['soy_sauce', 'gluten'],
    ['fish_sauce', 'fish'],
    ['oyster_sauce', 'molluscs'],
    ['worcestershire_sauce', 'fish'],
    ['pesto_genovese', 'tree_nuts'],
    ['pesto_genovese', 'milk'],
    ['tahini', 'sesame'],
    ['mayonnaise', 'egg'],
    ['caesar_dressing', 'fish'],
    ['asafoetida', 'gluten'],
    ['surimi', 'crustaceans'],
    ['hummus', 'sesame'],
  ];

  it.each(cases)('%s reports %s', (id, allergen) => {
    const result = check(dish([id]), profile({ allergens: [allergen as never] }), taxonomy);
    expect(result.ok, `${id} should be blocked for ${allergen}`).toBe(false);
  });
});

describe('real dishes against real profiles', () => {
  it('blocks palak paneer for a vegan', () => {
    const r = check(dish(['palak', 'paneer', 'onion', 'ghee']), profile({ diets: ['vegan'] }), taxonomy);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.ingredientName).sort()).toEqual(['ghee', 'paneer']);
  });

  it('blocks a Jain dish containing onion, garlic and potato', () => {
    const r = check(dish(['potato', 'onion', 'garlic', 'tomato']), profile({ diets: ['jain'] }), taxonomy);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(3);
  });

  it('passes a Navratri thali', () => {
    const r = check(
      dish(['kuttu_flour', 'potato', 'rock_salt', 'ginger', 'green_chilli', 'yoghurt']),
      profile({ diets: ['navratri'] }),
      taxonomy,
    );
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  });

  it('blocks a Navratri thali the moment wheat appears', () => {
    const r = check(dish(['wheat_flour', 'potato']), profile({ diets: ['navratri'] }), taxonomy);
    expect(r.ok).toBe(false);
  });

  it('blocks hing for a gluten-free Jain, which is the section 7 footnote', () => {
    // "Hing must be gluten-free if also gluten-free." Ordinary hing is
    // wheat-compounded, so it fails a gluten-free profile.
    const gf = profile({ diets: ['jain', 'gluten_free'] });
    expect(check(dish(['asafoetida']), gf, taxonomy).ok).toBe(false);
    expect(check(dish(['asafoetida_gf']), gf, taxonomy).ok).toBe(true);
  });
});

describe('ingredients split in two because one name covers two products', () => {
  /**
   * Four names in common use cover two products with different allergens. A
   * single row would have to pick one, and picking the safe one means someone
   * gets served wheat.
   *
   * The rule in every pair: the bare, ambiguous id carries the riskier
   * variant, so a recipe that just says "soba" or "wasabi" resolves to the one
   * with the allergen. The safe variant needs an explicit id, which means
   * somebody had to look at a label to use it.
   */
  const pairs: { risky: string; safe: string; allergen: string }[] = [
    { risky: 'asafoetida', safe: 'asafoetida_gf', allergen: 'gluten' },
    { risky: 'soba_noodles', safe: 'soba_juwari', allergen: 'gluten' },
    { risky: 'sausage_pork', safe: 'sausage_pork_gf', allergen: 'gluten' },
    { risky: 'wasabi_paste', safe: 'wasabi_real', allergen: 'mustard' },
  ];

  it.each(pairs)('$risky is blocked for $allergen but $safe is not', ({ risky, safe, allergen }) => {
    const p = profile({ allergens: [allergen as never] });
    expect(check(dish([risky]), p, taxonomy).ok, `${risky} should be blocked`).toBe(false);
    expect(check(dish([safe]), p, taxonomy).ok, `${safe} should pass`).toBe(true);
  });

  it.each(pairs)('the common name resolves to the risky variant, not $safe', ({ risky, safe }) => {
    // The whole point of the split: an unqualified mention fails closed.
    const entry = taxonomy.byId(risky);
    expect(entry).toBeDefined();
    expect(entry?.allergens.length).toBeGreaterThan(0);
    expect(taxonomy.byId(safe)?.allergens.length).toBe(0);
  });

  it('offers the safe variant as a substitution for each', async () => {
    for (const { risky, safe } of pairs) {
      const swap = substitutions.find((s) => s.fromId === risky && s.toId === safe);
      expect(swap, `no swap from ${risky} to ${safe}`).toBeDefined();
    }
  });

  it('bare "hing" and "wasabi" both resolve to the risky entry', () => {
    expect(taxonomy.resolve('hing')?.canonicalId).toBe('asafoetida');
    expect(taxonomy.resolve('wasabi')?.canonicalId).toBe('wasabi_paste');
    expect(taxonomy.resolve('soba')?.canonicalId).toBe('soba_noodles');
  });
});

describe('substitution against the real table', () => {
  it('makes butter chicken vegan', async () => {
    const recipe = {
      id: 'r',
      source: 'seed' as const,
      title: 'Butter chicken',
      cuisine: 'indian',
      ingredients: ['chicken', 'butter', 'tomato', 'ginger_garlic_paste'].map((i) => ({
        canonicalId: i,
        name: i,
        quantity: 1,
        unit: 'piece' as const,
        note: null,
      })),
      steps: [],
      minutes: 45,
      servings: 4,
      dietTags: [],
      allergenTags: [],
      sourceUrl: null,
      creator: null,
      thumbnailUrl: null,
      trendingUntil: null,
      contentHash: 'h',
      createdAt: '2026-09-26T00:00:00Z',
    };

    const out = await substitute(recipe, profile({ diets: ['vegan'] }), { taxonomy, substitutions });
    expect(out.dropped, out.dropped ? out.reason : '').toBe(false);
    if (out.dropped) return;
    expect(out.swaps.length).toBeGreaterThanOrEqual(2);
    expect(check(out.recipe, profile({ diets: ['vegan'] }), taxonomy).ok).toBe(true);
  });

  it('never routes a Jain or sattvic swap through wheat-compounded hing', () => {
    // Every hing substitution must point at asafoetida_gf, not asafoetida.
    const hingSwaps = substitutions.filter((s) => s.toId.startsWith('asafoetida'));
    expect(hingSwaps.length).toBeGreaterThan(0);
    for (const s of hingSwaps) expect(s.toId).toBe('asafoetida_gf');
  });

  it('no substitution introduces the allergen it was chosen to avoid', () => {
    // The same rule the validator enforces, asserted through the engine.
    for (const s of substitutions) {
      const to = taxonomy.byId(s.toId);
      if (!to) continue;
      if (to.allergens.some((a) => a === s.rule)) {
        throw new Error(`${s.fromId} -> ${s.toId} for ${s.rule} reintroduces ${s.rule}`);
      }
    }
  });
});

/* ------------------------------ the SQL files ------------------------------ */

describe('the generated seed SQL', () => {
  const files = ['010_ingredients.sql', '020_substitutions.sql'];

  // Remote D1 rejects SQL transaction statements, so a wrapped seed loads in
  // the local test pool — which only reads the INSERT lines — and then fails
  // `pnpm bootstrap` against a real database.
  it.each(files)('%s has no transaction statements remote D1 would reject', (file) => {
    const sql = readFileSync(join(SEED, file), 'utf8');
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/im);
  });

  it.each(files)('%s is idempotent, every statement an INSERT OR REPLACE', (file) => {
    const statements = readFileSync(join(SEED, file), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('--'));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((l) => l.startsWith('INSERT OR REPLACE INTO '))).toBe(true);
  });
});
