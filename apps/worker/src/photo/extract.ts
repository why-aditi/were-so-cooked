import { Unit } from '@cooked/shared';
import { z } from 'zod';
import type { TokenUsage } from '../budget/rates.js';

/**
 * The vision step of `PhotoScanWorkflow` (section 6).
 *
 * Spike 2 chose the model and measured the cost: Qwen3.8 27B, 713 prompt
 * tokens at 768x768, 49.7 billed neurons per photo. It also found that the
 * model section 8 originally named, Llama 3.2 Vision, is gated behind a
 * one-time licence whose terms exclude EU-domiciled users — which is why
 * this is not that model.
 *
 * Spike 2's caveat still stands and is worth repeating where someone will
 * read it: it compared licence, tokens and neurons, **not accuracy**. All
 * four candidates returned 0/3 usable JSON against synthesised images that
 * contained no food. Section 13's eval with real receipts is what validates
 * the choice, and could still overturn it.
 *
 * Nothing here trusts the model. Its output is schema-checked, its
 * confidences are clamped, and section 6 then shows every item to the user
 * before a single row reaches the pantry.
 */

export const EXTRACT_MODEL = '@cf/qwen/qwen3.8-27b';

/** Section 6: "Items below 0.5 confidence are shown unticked". */
export const LOW_CONFIDENCE = 0.5;

/** Section 8: one retry with the error appended, then give up. */
const MAX_ATTEMPTS = 2;

/**
 * What the model is allowed to return.
 *
 * `canonicalId` is deliberately absent: the model names things in English or
 * romanized Hindi and the normalize step resolves them against the taxonomy.
 * Letting a vision model assert a taxonomy ID would put an unverified claim
 * where the safety engine expects a checked one.
 */
export const ExtractedItem = z.object({
  name: z.string().min(1).max(80),
  quantity: z.number().positive().max(10_000).nullable().default(null),
  unit: Unit.nullable().default(null),
  confidence: z.number().min(0).max(1),
  /** A printed date read off the packaging, if the photo shows one. */
  expires_at: z.string().max(40).nullable().default(null),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

const ExtractResponse = z.object({ items: z.array(ExtractedItem).max(60) });

export interface ExtractResult {
  items: ExtractedItem[];
  usage: TokenUsage;
  attempts: number;
  error?: string;
}

/** A single vision call. Injected so the Workflow can be tested offline. */
export type VisionRunner = (req: {
  model: string;
  prompt: string;
  image: number[];
}) => Promise<{ text: string; usage: TokenUsage }>;

/**
 * One prompt for both receipts and fridge photos (section 6).
 *
 * Two prompts would double the eval surface and the failure modes for a
 * distinction the model can make itself from the picture. The instruction to
 * report low confidence rather than omit an item matters: an item the user
 * can untick is recoverable, one the model silently dropped is not.
 */
export const EXTRACT_PROMPT = [
  'This photo is either a grocery receipt or a shelf, fridge or counter with food on it.',
  'List the food items you can see.',
  '',
  'Rules:',
  '- One entry per distinct food item. Skip non-food lines: totals, taxes, bags, store names.',
  '- Use the plain name. Keep a romanized Hindi name if that is what is printed.',
  '- Give a quantity and unit only if the photo actually shows one. Otherwise null.',
  '- Include a printed expiry or best-before date if one is legible, as YYYY-MM-DD.',
  '- confidence is 0 to 1: how sure you are this item is really there and read correctly.',
  '- If you are unsure about an item, include it with low confidence. Do not leave it out.',
  '- If there is no food in the picture, return an empty list.',
  '',
  'Reply with JSON only, no prose and no markdown fence:',
  '{"items":[{"name":"","quantity":null,"unit":null,"confidence":0.0,"expires_at":null}]}',
].join('\n');

/**
 * Pulls the JSON out of whatever the model said.
 *
 * Recovery, not trust: the outermost brace pair is extracted so a markdown
 * fence or a "Sure! Here you go" does not fail the step, and the result then
 * goes through the schema like any other input.
 */
export function parseExtraction(
  text: string,
): { ok: true; items: ExtractedItem[] } | { ok: false; error: string } {
  // Both bracket kinds, because the model sometimes drops the wrapper and
  // returns a bare array. Scanning only for `{` would slice the first
  // object out of that array and silently lose every item after it.
  const object = span(text, '{', '}');
  const array = span(text, '[', ']');
  const chosen =
    object && array ? (object.start < array.start ? object : array) : (object ?? array);
  if (!chosen) return { ok: false, error: 'No JSON in the reply.' };

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(chosen.start, chosen.end + 1));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unparseable JSON.' };
  }

  const parsed = ExtractResponse.safeParse(raw);
  if (parsed.success) return { ok: true, items: parsed.data.items };

  // A bare array instead of the wrapper is a common near-miss and is cheaper
  // to accept than to spend a second vision call correcting.
  const bare = z.array(ExtractedItem).max(60).safeParse(raw);
  if (bare.success) return { ok: true, items: bare.data };

  return {
    ok: false,
    error: parsed.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

/** The outermost span between a pair of brackets, if there is one. */
function span(text: string, open: string, close: string): { start: number; end: number } | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start === -1 || end <= start ? null : { start, end };
}

/**
 * Runs the vision model over one image.
 *
 * A second failure returns no items rather than throwing. The Workflow then
 * parks on an empty confirm list, which the user can close — better than a
 * retried step burning three more vision calls on a photo of a wall.
 */
export async function extractItems(
  image: Uint8Array,
  deps: { vision: VisionRunner },
): Promise<ExtractResult> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  // Workers AI takes the image as a plain byte array.
  const bytes = [...image];
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt =
      attempt === 1
        ? EXTRACT_PROMPT
        : `${EXTRACT_PROMPT}\n\nYour previous reply was rejected: ${lastError}\nReturn valid JSON matching the shape exactly.`;

    let response;
    try {
      response = await deps.vision({ model: EXTRACT_MODEL, prompt, image: bytes });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }

    usage.promptTokens += response.usage.promptTokens;
    usage.completionTokens += response.usage.completionTokens;

    const parsed = parseExtraction(response.text);
    if (parsed.ok) return { items: parsed.items, usage, attempts: attempt };
    lastError = parsed.error;
  }

  return { items: [], usage, attempts: MAX_ATTEMPTS, error: lastError };
}

/**
 * A printed date into an ISO timestamp.
 *
 * Deliberately strict. A packaging date is worth having, but a
 * misinterpreted one is worse than none: it would set `expiry_source` to
 * `label`, which the UI presents as a fact rather than an estimate. Anything
 * that is not an unambiguous `YYYY-MM-DD` is dropped and the taxonomy's
 * shelf life is used instead.
 */
export function parsePrintedDate(value: string | null, now = Date.now()): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  // Rejects 2026-02-31, which `Date.UTC` would roll into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  // A date more than a decade out is a misread, not a long shelf life.
  const tenYears = now + 10 * 365 * 86_400_000;
  if (stamp > tenYears) return null;

  return date.toISOString();
}
