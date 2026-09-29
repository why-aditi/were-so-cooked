import type { Taxonomy } from '@cooked/safety';
import type { ScanItem, Unit } from '@cooked/shared';
import type { Classifier } from '../normalize/index.js';
import { type ExtractedItem, LOW_CONFIDENCE, parsePrintedDate } from './extract.js';

/**
 * The normalize step of `PhotoScanWorkflow` (section 6): "Match to the
 * ingredient taxonomy; small model only for names that don't match."
 *
 * Pure apart from the injected classifier, so the confidence rules and the
 * taxonomy matching are testable without a runtime.
 */

export interface NormalizeScanResult {
  items: ScanItem[];
  /** Names nothing could resolve. Kept, unticked, and flagged to the user. */
  unresolved: string[];
  modelCalled: boolean;
}

/**
 * Extracted items into the confirm list.
 *
 * Two decisions worth stating.
 *
 * `selected` starts false below 0.5 confidence, which is section 6's rule —
 * the row is still shown, just unticked, so a doubtful read costs a tap
 * rather than being silently dropped or silently added.
 *
 * An item the taxonomy cannot resolve is also unticked, whatever the vision
 * model's confidence. The model can be certain it read "xyzzy paste"
 * correctly; that says nothing about whether we know what is in it, and
 * section 7 treats an unresolved ingredient as a hard violation for anyone
 * with an allergy. Ticking it by default would put an unverifiable item in
 * the pantry on the strength of a confident misread.
 */
export async function normalizeScan(
  extracted: ExtractedItem[],
  taxonomy: Taxonomy,
  options: { classify?: Classifier; now?: number } = {},
): Promise<NormalizeScanResult> {
  const now = options.now ?? Date.now();

  const resolved = extracted.map((item) => ({
    item,
    entry: taxonomy.resolve(item.name),
  }));

  const misses = resolved.filter((r) => !r.entry).map((r) => r.item.name);
  let answers: Record<string, string | null> = {};
  let modelCalled = false;

  // One call for every miss, not one per miss — the same rule the chat
  // normalizer follows, and the reason a four-item receipt costs one
  // inference rather than four.
  if (options.classify && misses.length > 0) {
    modelCalled = true;
    try {
      answers = await options.classify({
        names: [...new Set(misses)],
        allowedIds: taxonomy.all().map((i) => i.canonicalId),
      });
    } catch {
      // A failed classifier leaves the items unresolved, which is the safe
      // outcome: they arrive unticked rather than mislabelled.
      answers = {};
    }
  }

  const items: ScanItem[] = [];
  const unresolved: string[] = [];

  for (const { item, entry } of resolved) {
    // Anything the model offers is checked against the taxonomy before it is
    // believed. A hallucinated id would carry another ingredient's allergens.
    const suggested = answers[item.name];
    const match = entry ?? (suggested ? taxonomy.byId(suggested) : undefined);
    if (!match) unresolved.push(item.name);

    const confident = item.confidence >= LOW_CONFIDENCE;
    items.push({
      name: match?.name ?? item.name,
      canonicalId: match?.canonicalId ?? null,
      quantity: item.quantity,
      unit: item.unit as Unit | null,
      confidence: item.confidence,
      expiresAt: parsePrintedDate(item.expires_at, now),
      selected: confident && match !== undefined,
    });
  }

  return { items, unresolved, modelCalled };
}

/**
 * The phrase handed to the agent when the user confirms.
 *
 * The pantry add path takes free text so that one normalizer owns quantity,
 * unit and expiry parsing for chat and photos alike. Rebuilding a phrase
 * here looks redundant but keeps that single path: a photo item and a typed
 * item become the same kind of pantry row, with the same defaults applied.
 */
export function confirmPhrase(item: Pick<ScanItem, 'name' | 'quantity' | 'unit'>): string {
  const amount =
    item.quantity !== null && item.unit !== null
      ? `${item.quantity}${item.unit} `
      : item.quantity !== null
        ? `${item.quantity} `
        : '';
  return `${amount}${item.name}`;
}

/** Items the user ticked. Everything else is discarded with the scan. */
export function selectedItems(items: ScanItem[]): ScanItem[] {
  return items.filter((i) => i.selected);
}
