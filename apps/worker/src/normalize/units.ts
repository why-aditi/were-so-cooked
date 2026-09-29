import type { IngredientCategory, Unit } from '@cooked/shared';

/**
 * Quantity and unit vocabulary for the pantry normalizer.
 *
 * Everything here is data, not logic, so a missing word is a one-line fix
 * rather than a parser change. The lists are deliberately generous on input
 * and narrow on output: many spellings map onto the twelve units the shared
 * `Unit` enum allows, because section 6 merges the grocery list "by canonical
 * ingredient and unit" and free-text units would never merge.
 */

/** Written numbers, including the Hindi quantities people actually use. */
export const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  half: 0.5,
  quarter: 0.25,
  // Hindi quantity words, common when buying by weight.
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  paanch: 5,
  panch: 5,
  aadha: 0.5,
  adha: 0.5,
  aadhi: 0.5,
  dedh: 1.5,
  dhai: 2.5,
  sawa: 1.25,
  paune: 0.75,
};

/** Words that mean "an unspecified amount", which is not the same as one. */
export const VAGUE_WORDS = new Set([
  'some',
  'a few',
  'few',
  'a little',
  'little',
  'couple',
  'a couple',
  'several',
  'lots',
  'lots of',
  'plenty',
  'plenty of',
  'thoda',
  'thora',
  'kuch',
]);

/** Vague words that still imply a rough count. */
export const VAGUE_COUNTS: Record<string, number> = {
  couple: 2,
  'a couple': 2,
  few: 3,
  'a few': 3,
  several: 3,
};

export const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅙': 1 / 6,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
};

/**
 * Spelling to canonical unit.
 *
 * `tin`, `can`, `bottle` and `jar` all collapse to `packet`: the shared enum
 * has no container units, and for a pantry the distinction between a tin and a
 * packet of tomatoes does not change any decision the app makes.
 */
export const UNIT_ALIASES: Record<string, Unit> = {
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  gramme: 'g',
  grammes: 'g',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  ml: 'ml',
  mls: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  l: 'l',
  lt: 'l',
  ltr: 'l',
  litre: 'l',
  litres: 'l',
  liter: 'l',
  liters: 'l',
  tsp: 'tsp',
  tsps: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tbsp: 'tbsp',
  tbsps: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  chammach: 'tbsp',
  cup: 'cup',
  cups: 'cup',
  katori: 'cup',
  piece: 'piece',
  pieces: 'piece',
  pc: 'piece',
  pcs: 'piece',
  nos: 'piece',
  adad: 'piece',
  bunch: 'bunch',
  bunches: 'bunch',
  gaddi: 'bunch',
  guchha: 'bunch',
  gucchha: 'bunch',
  packet: 'packet',
  packets: 'packet',
  pack: 'packet',
  packs: 'packet',
  pkt: 'packet',
  pouch: 'packet',
  pouches: 'packet',
  box: 'packet',
  boxes: 'packet',
  tin: 'packet',
  tins: 'packet',
  can: 'packet',
  cans: 'packet',
  bottle: 'packet',
  bottles: 'packet',
  jar: 'packet',
  jars: 'packet',
  carton: 'packet',
  pinch: 'pinch',
  pinches: 'pinch',
  chutki: 'pinch',
};

/**
 * Last-resort unit for an ingredient the taxonomy does not know.
 *
 * Every known ingredient carries its own `defaultUnit` (migration 0003), so
 * this only fires for an unresolved name, where the category is always
 * 'other'. The map is kept whole rather than collapsed to a single constant
 * because the model fallback can resolve a category before it resolves a
 * unit.
 */
export const CATEGORY_DEFAULT_UNIT: Record<IngredientCategory, Unit> = {
  produce: 'piece',
  dairy: 'packet',
  meat: 'packet',
  seafood: 'packet',
  grains: 'packet',
  legumes: 'packet',
  spices: 'packet',
  condiments: 'packet',
  bakery: 'piece',
  frozen: 'packet',
  beverages: 'packet',
  sweets: 'packet',
  other: 'packet',
};

/** Filler that carries no meaning once the quantity is parsed out. */
export const STOPWORDS = new Set([
  'of',
  'the',
  'fresh',
  'ka',
  'ki',
  'ke',
  'and',
  // "chutki bhar haldi", "thoda sa namak" -- filler around a quantity.
  'bhar',
  'sa',
  'si',
]);

/** Verbs and openers people put in front of a shopping list. */
export const LEADING_PHRASES = [
  'i bought',
  'i got',
  'i picked up',
  'i have',
  'we bought',
  'we got',
  'we have',
  'just bought',
  'just got',
  'bought',
  'brought',
  'got',
  'picked up',
  'purchased',
  'add',
  'adding',
  'put',
  'theres',
  'there is',
  'there are',
  'khareeda',
  'liya',
  'le aaya',
];
