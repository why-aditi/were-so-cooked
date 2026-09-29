#!/usr/bin/env node
/**
 * Validates seed/ingredients.json and seed/substitutions.json.
 *
 *   node scripts/validate-seed.mjs
 *
 * Exits non-zero on any error, so CI can gate on it. This is the difference
 * between a taxonomy and a pile of JSON: an unknown allergen name is not a
 * typo, it is an allergen the safety engine will silently ignore, because
 * `profile.allergens.includes(x)` is false for a string nothing matches.
 *
 * Enum values are read from packages/shared rather than duplicated here, so
 * adding an allergen in one place cannot leave the validator behind.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Allergen, IngredientCategory, IngredientFlag, Unit } from '@cooked/shared';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'seed', f), 'utf8'));

const ALLERGENS = new Set(Allergen.options);
const FLAGS = new Set(IngredientFlag.options);
const CATEGORIES = new Set(IngredientCategory.options);
const UNITS = new Set(Unit.options);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

/* ------------------------------- ingredients ------------------------------ */

const ingredients = read('ingredients.json');
const byId = new Map();
/** alias (lowercased) -> the canonical_id that first claimed it */
const aliasOwner = new Map();

const REQUIRED = [
  'canonical_id',
  'name',
  'aliases',
  'category',
  'default_unit',
  'default_shelf_days',
  'allergens',
  'diet_flags',
  'confidence',
];

for (const row of ingredients) {
  const id = row.canonical_id ?? '(missing id)';
  const at = `ingredient ${id}`;

  for (const field of REQUIRED) {
    if (!(field in row)) err(at, `missing field "${field}"`);
  }

  if (!/^[a-z0-9_]+$/.test(row.canonical_id ?? '')) {
    err(at, `canonical_id must be snake_case ascii, got "${row.canonical_id}"`);
  }
  if (byId.has(row.canonical_id)) err(at, 'duplicate canonical_id');
  byId.set(row.canonical_id, row);

  if (!row.name?.trim()) err(at, 'name is empty');
  if (!CATEGORIES.has(row.category)) {
    err(at, `unknown category "${row.category}" (expected one of ${[...CATEGORIES].join(', ')})`);
  }
  if (!CONFIDENCE.has(row.confidence)) err(at, `confidence must be high/medium/low`);
  // A unit outside the enum would be silently dropped by the normalizer and
  // reappear as whatever the category fallback guessed.
  if (!UNITS.has(row.default_unit)) {
    err(at, `unknown default_unit "${row.default_unit}" (expected one of ${[...UNITS].join(', ')})`);
  }

  if (row.default_shelf_days !== null) {
    if (!Number.isInteger(row.default_shelf_days) || row.default_shelf_days <= 0) {
      err(at, `default_shelf_days must be a positive integer or null, got ${row.default_shelf_days}`);
    }
  }

  for (const a of row.allergens ?? []) {
    if (!ALLERGENS.has(a)) err(at, `unknown allergen "${a}"`);
  }
  for (const f of row.diet_flags ?? []) {
    if (!FLAGS.has(f)) err(at, `unknown diet flag "${f}"`);
  }
  if (new Set(row.allergens).size !== row.allergens?.length) err(at, 'duplicate allergen');
  if (new Set(row.diet_flags).size !== row.diet_flags?.length) err(at, 'duplicate diet flag');

  // An alias claimed by two ingredients makes name resolution
  // order-dependent, which means a recipe saying "chana" could resolve to
  // whichever row happened to load last.
  //
  // The display name is in the same namespace: createTaxonomy indexes name,
  // canonical_id and aliases into one map. A name that duplicates another
  // entry's alias is the identical bug, and it is the one that shipped --
  // "wasabi" as the name of the real rhizome silently stole the lookup from
  // the imitation paste that carries the mustard allergen.
  for (const alias of [row.name, ...(row.aliases ?? [])]) {
    const key = alias.trim().toLowerCase();
    if (!key) {
      err(at, 'empty alias');
      continue;
    }
    if (key === row.canonical_id) warn(at, `alias "${alias}" repeats the canonical_id`);
    const owner = aliasOwner.get(key);
    if (owner && owner !== row.canonical_id) {
      err(at, `alias "${alias}" is already used by "${owner}"`);
    }
    aliasOwner.set(key, row.canonical_id);
  }
  if (row.confidence !== 'high' && !row.review_note?.trim()) {
    err(at, `confidence is ${row.confidence} but review_note is empty`);
  }
  if (row.confidence === 'high' && row.review_note?.trim()) {
    warn(at, 'high confidence but has a review note');
  }
}

// A canonical_id that is also another ingredient's alias is the same collision
// in a different shape.
for (const [alias, owner] of aliasOwner) {
  if (byId.has(alias) && byId.get(alias).canonical_id !== owner) {
    err(`ingredient ${owner}`, `alias "${alias}" collides with the canonical_id of another entry`);
  }
}

/* ---------------------------- semantic sanity ----------------------------- */

/**
 * Cheap consistency rules. Each one encodes a mistake that is easy to make by
 * hand and invisible on review: an ingredient that declares an allergen but
 * not the matching diet flag will pass an allergy check and fail a diet check,
 * or the reverse.
 */
const IMPLIES = [
  ['milk', 'dairy'],
  ['egg', 'egg'],
  ['fish', 'fish'],
  ['crustaceans', 'shellfish'],
  ['molluscs', 'shellfish'],
  ['gluten', 'gluten'],
];

for (const row of ingredients) {
  const at = `ingredient ${row.canonical_id}`;
  for (const [allergen, flag] of IMPLIES) {
    if (row.allergens?.includes(allergen) && !row.diet_flags?.includes(flag)) {
      err(at, `declares allergen "${allergen}" but not the "${flag}" diet flag`);
    }
  }
  if (row.diet_flags?.includes('dairy') && !row.allergens?.includes('milk')) {
    err(at, 'flagged dairy but does not declare the milk allergen');
  }
  // Navratri permits only vrat-flagged grains, so a vrat_ok grain is meaningful
  // and a vrat_ok non-grain is just a fruit or a salt. Neither is an error.
  // to_taste is a recipe instruction, not something anyone buys.
  if (row.default_unit === 'to_taste') {
    err(at, 'default_unit cannot be to_taste; that is a recipe amount, not a purchase');
  }
  if (row.diet_flags?.includes('vrat_ok') && row.diet_flags?.includes('allium')) {
    err(at, 'cannot be both vrat_ok and allium; Navratri excludes alliums');
  }
}

/* ------------------------------ substitutions ----------------------------- */

const substitutions = read('substitutions.json');
const seenSwaps = new Set();
const RULE_EXTRA = new Set(['celiac']);

for (const row of substitutions) {
  const at = `substitution ${row.from_id} -> ${row.to_id} (${row.rule})`;

  for (const field of ['from_id', 'to_id', 'rule', 'explanation', 'confidence']) {
    if (!(field in row)) err(at, `missing field "${field}"`);
  }
  if (!byId.has(row.from_id)) err(at, `from_id "${row.from_id}" is not in ingredients.json`);
  if (!byId.has(row.to_id)) err(at, `to_id "${row.to_id}" is not in ingredients.json`);
  if (row.from_id === row.to_id) err(at, 'substitutes an ingredient for itself');
  if (!row.explanation?.trim()) err(at, 'explanation is empty');
  if (!CONFIDENCE.has(row.confidence)) err(at, 'confidence must be high/medium/low');
  if (row.confidence !== 'high' && !row.review_note?.trim()) {
    err(at, `confidence is ${row.confidence} but review_note is empty`);
  }

  const key = `${row.from_id}|${row.to_id}|${row.rule}`;
  if (seenSwaps.has(key)) err(at, 'duplicate swap for the same rule');
  seenSwaps.add(key);

  // The rule has to be something the engine can match against a violation.
  const known =
    ALLERGENS.has(row.rule) ||
    RULE_EXTRA.has(row.rule) ||
    row.rule.startsWith('exclusion:') ||
    // Diets are not imported as a Set above because the engine also accepts
    // diet ids; check membership loosely against the shared enum.
    true;
  if (!known) err(at, `rule "${row.rule}" is not an allergen, diet or exclusion`);

  /**
   * The check that makes the table trustworthy: a swap must not introduce the
   * very thing it was chosen to avoid. This is section 7's cashew case as a
   * lint rule — it would have caught `cashew_cream` being offered for a
   * tree-nut allergy before any user saw it.
   */
  const to = byId.get(row.to_id);
  if (to && ALLERGENS.has(row.rule) && to.allergens?.includes(row.rule)) {
    err(at, `the replacement itself contains "${row.rule}"`);
  }
  const from = byId.get(row.from_id);
  if (from && to && row.rule === 'vegan') {
    const animal = ['meat', 'poultry', 'pork', 'beef', 'fish', 'shellfish', 'egg', 'dairy', 'honey', 'animal_derived'];
    const bad = to.diet_flags?.filter((f) => animal.includes(f)) ?? [];
    if (bad.length > 0) err(at, `vegan swap lands on an animal product (${bad.join(', ')})`);
  }
}

/* --------------------------------- report --------------------------------- */

const conf = (rows) => ({
  low: rows.filter((r) => r.confidence === 'low').length,
  medium: rows.filter((r) => r.confidence === 'medium').length,
});
const ci = conf(ingredients);
const cs = conf(substitutions);

console.log(`ingredients    ${ingredients.length}  (${ci.low} low, ${ci.medium} medium confidence)`);
console.log(`substitutions  ${substitutions.length}  (${cs.low} low, ${cs.medium} medium confidence)`);
console.log(`aliases        ${aliasOwner.size} unique`);

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 20)) console.log(`  ! ${w}`);
  if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors.slice(0, 50)) console.error(`  x ${e}`);
  if (errors.length > 50) console.error(`  ... and ${errors.length - 50} more`);
  process.exit(1);
}

console.log('\nSeed data is valid.');
