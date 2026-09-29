import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SubstitutionRow, type Taxonomy, createTaxonomy } from '@cooked/safety';
import type { Ingredient } from '@cooked/shared';

/**
 * The real seed, loaded for the eval suites.
 *
 * Evals run against the shipped taxonomy and the shipped swap table, never
 * a fixture. The point of section 13's safety eval is that the *data* and
 * the rules together hold — a flag misspelled in the TSV produces a rule
 * that silently never fires, and a fixture would hide exactly that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = join(HERE, '..', '..', 'seed');
export const REPORTS_DIR = join(HERE, '..', 'reports');

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

interface SeedSubstitution {
  from_id: string;
  to_id: string;
  rule: string;
  ratio_note: string | null;
  explanation: string;
}

export function loadIngredients(): Ingredient[] {
  const raw = JSON.parse(
    readFileSync(join(SEED_DIR, 'ingredients.json'), 'utf8'),
  ) as SeedIngredient[];

  return raw.map((row) => ({
    canonicalId: row.canonical_id,
    name: row.name,
    aliases: row.aliases,
    category: row.category,
    defaultUnit: row.default_unit,
    defaultShelfDays: row.default_shelf_days,
    allergens: row.allergens,
    dietFlags: row.diet_flags,
  }));
}

export function loadTaxonomy(): Taxonomy {
  return createTaxonomy(loadIngredients());
}

export function loadSubstitutions(): SubstitutionRow[] {
  const raw = JSON.parse(
    readFileSync(join(SEED_DIR, 'substitutions.json'), 'utf8'),
  ) as SeedSubstitution[];

  return raw.map((row) => ({
    fromId: row.from_id,
    toId: row.to_id,
    rule: row.rule,
    ratioNote: row.ratio_note,
    explanation: row.explanation,
  }));
}
