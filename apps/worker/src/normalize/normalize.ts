import type {
  ExpirySource,
  IngredientCategory,
  PantryItemSource,
  QuantityConfidence,
  Unit,
} from '@cooked/shared';
import type { Taxonomy } from '@cooked/safety';
import {
  CATEGORY_DEFAULT_UNIT,
  LEADING_PHRASES,
  NUMBER_WORDS,
  STOPWORDS,
  UNIT_ALIASES,
  VAGUE_COUNTS,
  VAGUE_WORDS,
  VULGAR_FRACTIONS,
} from './units.js';

/**
 * Free text to pantry items (section 5's `add_pantry_items`).
 *
 * "bought 1kg paneer, 6 eggs, a bunch of dhaniya" becomes three normalized
 * items with quantities, units and estimated expiry dates.
 *
 * Deterministic first, model second. Section 12: "Classification and
 * normalization try the taxonomy lookup first and call a model only for
 * misses." The taxonomy has ~800 entries and ~1,800 lookup keys, so the
 * overwhelming majority of real phrases never reach a model at all — which is
 * the difference between ~0 and ~10 neurons per message.
 *
 * There is deliberately **no fuzzy matching**. A Levenshtein match that turns
 * "kaju barfi" into "kaju" or "besan" into "besan laddu" is a wrong canonical
 * id, and a wrong canonical id is a wrong allergen set. An unmatched
 * ingredient is safe — section 7 blocks anything it cannot verify — whereas a
 * confidently wrong match is not. Exact, alias and singular matching only.
 */

export type MatchedBy = 'canonical_id' | 'name' | 'alias' | 'singular' | 'model' | 'unresolved';

export interface NormalizedItem {
  canonicalId: string | null;
  displayName: string;
  category: IngredientCategory;
  quantity: number;
  unit: Unit;
  qtyConfidence: QuantityConfidence;
  expiresAt: string | null;
  expirySource: ExpirySource;
  source: PantryItemSource;
  matchedBy: MatchedBy;
  /**
   * True when the phrase named a unit outright. The model fallback uses this
   * to avoid overriding something the user actually said.
   */
  unitExplicit: boolean;
  /** The phrase this came from, so the UI can show what it read. */
  raw: string;
}

export interface NormalizeResult {
  items: NormalizedItem[];
  /** Names no deterministic rule could resolve. Candidates for the model. */
  unresolved: string[];
}

export interface NormalizeOptions {
  taxonomy: Taxonomy;
  /** Injected so expiry dates are testable. Defaults to now. */
  now?: Date;
  source?: PantryItemSource;
}

/* --------------------------------- text ---------------------------------- */

const clean = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    // Keep , and ; -- splitPhrases needs them, and stripping them first
    // silently glued every list into a single item.
    .replace(/[^\p{L}\p{N}\s,;./'½⅓⅔¼¾⅕⅙⅛⅜⅝⅞-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function stripLeadingPhrase(text: string): string {
  let out = text;
  for (const phrase of LEADING_PHRASES) {
    if (out.startsWith(`${phrase} `)) {
      out = out.slice(phrase.length + 1);
      break;
    }
  }
  return out.trim();
}

/**
 * Splits a message into one phrase per item.
 *
 * Splitting on " and " is safe for a shopping list but wrong inside an
 * ingredient name, so a fragment that is only a connector or that leaves
 * nothing behind is dropped rather than becoming a phantom item.
 */
export function splitPhrases(text: string): string[] {
  return stripLeadingPhrase(clean(text))
    .split(/\s*(?:,|;|\band\b|\bplus\b|\n)\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !STOPWORDS.has(p));
}

/* ------------------------------- quantities ------------------------------- */

interface Quantity {
  value: number;
  confidence: QuantityConfidence;
  /** Tokens consumed from the front of the phrase. */
  consumed: number;
  /** True when the phrase named no amount at all. */
  implied: boolean;
  /**
   * True only for an actual numeral or number word. "some" and "a few" are
   * amounts but not counts, and the difference decides the default unit:
   * "6 eggs" is six pieces, "some paneer" is not six of anything.
   */
  counted: boolean;
}

function parseNumericToken(token: string): number | null {
  // 1½ and ½ alike.
  const vulgarMatch = token.match(/^(\d*)([½⅓⅔¼¾⅕⅙⅛⅜⅝⅞])$/u);
  if (vulgarMatch) {
    const whole = vulgarMatch[1] ? Number(vulgarMatch[1]) : 0;
    return whole + (VULGAR_FRACTIONS[vulgarMatch[2] as string] ?? 0);
  }
  // 1/2 and 3/4.
  const fractionMatch = token.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const denominator = Number(fractionMatch[2]);
    return denominator === 0 ? null : Number(fractionMatch[1]) / denominator;
  }
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  return null;
}

/**
 * Reads the amount from the front of a phrase.
 *
 * `exact` means the phrase named a definite count: a numeral, a fraction, or
 * an article in front of a discrete unit ("a bunch" is exactly one bunch).
 * `approx` means it did not: "some", "a few", or nothing at all. Section 5
 * turns that into "about" in the reply, so getting it wrong either overstates
 * certainty or nags about a quantity the user actually gave.
 */
export function parseQuantity(tokens: string[]): Quantity {
  if (tokens.length === 0)
    return { value: 1, confidence: 'approx', consumed: 0, implied: true, counted: false };

  const first = tokens[0] as string;
  const twoWord = tokens.length > 1 ? `${first} ${tokens[1]}` : '';

  // "a few", "a couple" before "a" alone, so the article is not read as one.
  if (VAGUE_WORDS.has(twoWord)) {
    return { value: VAGUE_COUNTS[twoWord] ?? 1, confidence: 'approx', consumed: 2, implied: false, counted: false };
  }
  if (VAGUE_WORDS.has(first)) {
    return { value: VAGUE_COUNTS[first] ?? 1, confidence: 'approx', consumed: 1, implied: false, counted: false };
  }

  const numeric = parseNumericToken(first);
  if (numeric !== null) {
    // "1 1/2 kg" and "1 ½ kg".
    const second = tokens[1] ? parseNumericToken(tokens[1] as string) : null;
    if (second !== null && second < 1 && Number.isInteger(numeric)) {
      return { value: numeric + second, confidence: 'exact', consumed: 2, implied: false, counted: true };
    }
    return { value: numeric, confidence: 'exact', consumed: 1, implied: false, counted: true };
  }

  if (first in NUMBER_WORDS) {
    const value = NUMBER_WORDS[first] as number;
    // "half a dozen" and "half a kilo".
    if (value === 0.5 && tokens[1] === 'a' && tokens[2]) {
      const third = tokens[2] as string;
      if (third in NUMBER_WORDS) {
        return { value: 0.5 * (NUMBER_WORDS[third] as number), confidence: 'exact', consumed: 3, implied: false, counted: true };
      }
      return { value: 0.5, confidence: 'exact', consumed: 2, implied: false, counted: true };
    }
    return { value, confidence: 'exact', consumed: 1, implied: false, counted: true };
  }

  return { value: 1, confidence: 'approx', consumed: 0, implied: true, counted: false };
}

/* ---------------------------------- units --------------------------------- */

interface UnitMatch {
  unit: Unit | null;
  consumed: number;
  /** "dozen" multiplies the count rather than naming a unit. */
  multiplier: number;
}

export function parseUnit(tokens: string[]): UnitMatch {
  if (tokens.length === 0) return { unit: null, consumed: 0, multiplier: 1 };
  const first = tokens[0] as string;

  if (first === 'dozen' || first === 'dozens') {
    return { unit: 'piece', consumed: 1, multiplier: 12 };
  }
  if (first in UNIT_ALIASES) {
    return { unit: UNIT_ALIASES[first] as Unit, consumed: 1, multiplier: 1 };
  }
  // "to taste".
  if (first === 'to' && tokens[1] === 'taste') {
    return { unit: 'to_taste', consumed: 2, multiplier: 1 };
  }
  return { unit: null, consumed: 0, multiplier: 1 };
}

/**
 * Splits a glued quantity and unit: "1kg", "250g", "1.5kg", "2tbsp".
 * People type these without a space far more often than with one.
 */
function splitGlued(token: string): string[] {
  const m = token.match(/^(\d+(?:\.\d+)?|[½⅓⅔¼¾⅕⅙⅛⅜⅝⅞])([a-z]+)$/u);
  if (!m) return [token];
  const unit = m[2] as string;
  return unit in UNIT_ALIASES ? [m[1] as string, unit] : [token];
}

/* -------------------------------- matching -------------------------------- */

/**
 * Plural to singular candidates.
 *
 * Returns a list rather than one answer because English is ambiguous:
 * "cherries" is cherry but "chillies" is chilli. Trying both and keeping
 * whichever the taxonomy recognises beats picking a rule and being wrong
 * half the time.
 */
export function singulariseAll(name: string): string[] {
  const out: string[] = [];
  if (name.endsWith('ies') && name.length > 4) {
    out.push(`${name.slice(0, -3)}y`, `${name.slice(0, -3)}i`);
  }
  if (name.endsWith('oes') && name.length > 4) out.push(name.slice(0, -2));
  if (name.endsWith('ses') || name.endsWith('shes') || name.endsWith('ches')) {
    out.push(name.slice(0, -2));
  }
  if (name.endsWith('s') && !name.endsWith('ss') && name.length > 3) out.push(name.slice(0, -1));
  return [...new Set(out)];
}

/** The first candidate, for callers that only want one. */
export function singularise(name: string): string | null {
  return singulariseAll(name)[0] ?? null;
}

interface Resolution {
  canonicalId: string | null;
  displayName: string;
  category: IngredientCategory;
  shelfDays: number | null;
  /** null when the name did not resolve. */
  defaultUnit: Unit | null;
  matchedBy: MatchedBy;
}

export function resolveName(name: string, taxonomy: Taxonomy): Resolution {
  const attempt = (value: string, how: MatchedBy): Resolution | null => {
    const entry = taxonomy.resolve(value);
    if (!entry) return null;
    return {
      canonicalId: entry.canonicalId,
      displayName: entry.name,
      category: entry.category,
      shelfDays: entry.defaultShelfDays,
      defaultUnit: entry.defaultUnit,
      matchedBy: how,
    };
  };

  const direct = attempt(name, 'name');
  if (direct) {
    // Report which key matched, because the distinction matters when
    // debugging a bad alias.
    const entry = taxonomy.resolve(name);
    const how: MatchedBy =
      entry?.canonicalId === name ? 'canonical_id' : entry?.name.toLowerCase() === name ? 'name' : 'alias';
    return { ...direct, matchedBy: how };
  }

  for (const candidate of singulariseAll(name)) {
    const viaSingular = attempt(candidate, 'singular');
    if (viaSingular) return viaSingular;
  }

  // Trailing descriptors: "paneer cubes", "onion chopped".
  const words = name.split(' ');
  if (words.length > 1) {
    const head = words.slice(0, -1).join(' ');
    const viaHead = attempt(head, 'alias');
    if (viaHead) return viaHead;
    for (const candidate of singulariseAll(head)) {
      const viaHeadSingular = attempt(candidate, 'singular');
      if (viaHeadSingular) return viaHeadSingular;
    }
  }

  return {
    canonicalId: null,
    displayName: name,
    category: 'other',
    shelfDays: null,
    defaultUnit: null,
    matchedBy: 'unresolved',
  };
}

/* -------------------------------- assembly -------------------------------- */

function expiryFor(shelfDays: number | null, now: Date): string | null {
  if (shelfDays === null) return null;
  return new Date(now.getTime() + shelfDays * 24 * 60 * 60 * 1000).toISOString();
}

export function normalizePhrase(phrase: string, options: NormalizeOptions): NormalizedItem | null {
  const now = options.now ?? new Date();
  let tokens = phrase.split(' ').filter(Boolean).flatMap(splitGlued);
  if (tokens.length === 0) return null;

  const quantity = parseQuantity(tokens);
  tokens = tokens.slice(quantity.consumed);

  // "of" between the amount and the thing: "a bunch of dhaniya".
  const unitMatch = parseUnit(tokens);
  tokens = tokens.slice(unitMatch.consumed);
  while (tokens.length > 0 && STOPWORDS.has(tokens[0] as string)) tokens = tokens.slice(1);

  // Only leading filler is dropped. An interior stopword can be part of the
  // name itself -- "sarson ka tel" is a real alias, and filtering "ka" out of
  // the middle made it unresolvable.
  const name = tokens.join(' ').trim();
  if (!name) return null;

  const resolved = resolveName(name, options.taxonomy);

  let unit = unitMatch.unit;
  if (unit === null) {
    if (quantity.counted) {
      // A bare count means pieces: "6 eggs", "2 pyaaz". This beats the
      // taxonomy default, which describes an uncounted purchase.
      unit = 'piece';
    } else {
      // The taxonomy knows what this ingredient is sold in; the category
      // fallback is only for a name it could not resolve.
      unit = resolved.defaultUnit ?? CATEGORY_DEFAULT_UNIT[resolved.category];
    }
  }

  return {
    canonicalId: resolved.canonicalId,
    displayName: resolved.displayName,
    category: resolved.category,
    quantity: Math.round(quantity.value * unitMatch.multiplier * 1000) / 1000,
    unit,
    qtyConfidence: quantity.confidence,
    expiresAt: expiryFor(resolved.shelfDays, now),
    // Always estimated: the normalizer never reads a printed date. A label
    // date arrives through the photo scan, and a user correction sets 'user'.
    expirySource: 'estimated',
    source: options.source ?? 'chat',
    matchedBy: resolved.matchedBy,
    unitExplicit: unitMatch.unit !== null,
    raw: phrase,
  };
}

/** The deterministic pass. No I/O, no model, no network. */
export function normalize(text: string, options: NormalizeOptions): NormalizeResult {
  const items: NormalizedItem[] = [];
  for (const phrase of splitPhrases(text)) {
    const item = normalizePhrase(phrase, options);
    if (item) items.push(item);
  }
  return {
    items,
    unresolved: [...new Set(items.filter((i) => i.canonicalId === null).map((i) => i.displayName))],
  };
}
