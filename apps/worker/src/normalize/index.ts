import type { Taxonomy } from '@cooked/safety';
import {
  type NormalizeOptions,
  type NormalizeResult,
  type NormalizedItem,
  normalize,
} from './normalize.js';

export * from './normalize.js';
export * from './units.js';

/**
 * The 8B model fallback for names the taxonomy could not match.
 *
 * Section 8 routes normalization to `@cf/meta/llama-3.1-8b-instruct-fp8-fast`,
 * and section 12 says to "try the taxonomy lookup first and call a model only
 * for misses". Two consequences shape this file:
 *
 * 1. **One call for all misses, not one per miss.** A message with four
 *    unknown items costs one inference, not four. At the section 8 estimate
 *    that is ~10 neurons instead of ~40.
 * 2. **The model picks from the taxonomy, it does not invent.** Anything it
 *    returns that is not a real canonical id is discarded, exactly as the
 *    substitution proposer is treated in packages/safety. A hallucinated id
 *    would carry a real allergen set belonging to a different ingredient.
 *
 * Injected rather than imported, so the module stays testable without a
 * Workers AI binding and the caller owns the budget reservation.
 */

export interface ClassifyRequest {
  /** Names the deterministic pass could not resolve. */
  names: string[];
  /** Every canonical id the model may choose from. */
  allowedIds: string[];
}

/** Maps each input name to a canonical id, or null when there is no match. */
export type Classifier = (req: ClassifyRequest) => Promise<Record<string, string | null>>;

export interface NormalizeWithModelOptions extends NormalizeOptions {
  classify?: Classifier;
}

/**
 * Applies the model's answers to the items the taxonomy missed.
 *
 * An item that stays unresolved is kept, not dropped: the user did buy
 * something, and section 7 will treat the unknown ingredient as a hard
 * violation for anyone with an allergy. Silently discarding it would lose a
 * pantry item; silently guessing would lose an allergen.
 */
export async function normalizeWithModel(
  text: string,
  options: NormalizeWithModelOptions,
): Promise<NormalizeResult & { modelCalled: boolean }> {
  const deterministic = normalize(text, options);

  if (!options.classify || deterministic.unresolved.length === 0) {
    return { ...deterministic, modelCalled: false };
  }

  let answers: Record<string, string | null> = {};
  try {
    answers = await options.classify({
      names: deterministic.unresolved,
      allowedIds: options.taxonomy.all().map((i) => i.canonicalId),
    });
  } catch {
    // A failing classifier leaves the items unresolved, which is the safe
    // outcome. Normalization must not fail a pantry add.
    return { ...deterministic, modelCalled: true };
  }

  const now = options.now ?? new Date();
  const items = deterministic.items.map((item) =>
    item.canonicalId === null ? applyAnswer(item, answers, options.taxonomy, now) : item,
  );

  return {
    items,
    unresolved: [...new Set(items.filter((i) => i.canonicalId === null).map((i) => i.displayName))],
    modelCalled: true,
  };
}

function applyAnswer(
  item: NormalizedItem,
  answers: Record<string, string | null>,
  taxonomy: Taxonomy,
  now: Date,
): NormalizedItem {
  const proposed = answers[item.displayName];
  if (!proposed) return item;

  const entry = taxonomy.byId(proposed);
  // The id has to exist. A model that returns "paneer_cubes" or an English
  // sentence gets ignored rather than writing a null-allergen item that looks
  // resolved.
  if (!entry) return item;

  // The unit was chosen against category 'other'; now that the category is
  // known, pick again — but never over a unit the phrase stated outright.
  const unit = item.unitExplicit ? item.unit : entry.defaultUnit;

  return {
    ...item,
    canonicalId: entry.canonicalId,
    displayName: entry.name,
    category: entry.category,
    unit,
    // Same clock the deterministic pass used, so two items from one message
    // do not end up expiring milliseconds apart.
    expiresAt:
      entry.defaultShelfDays === null
        ? null
        : new Date(now.getTime() + entry.defaultShelfDays * 24 * 60 * 60 * 1000).toISOString(),
    matchedBy: 'model',
  };
}
