import type { TokenUsage } from '../budget/rates.js';
import type { ModelRunner } from '../agent/adapters.js';
import type { ClassifyRequest } from './index.js';

/**
 * The 8B fallback for ingredient names the taxonomy could not match.
 *
 * Section 8 routes normalization and classification to
 * `@cf/meta/llama-3.1-8b-instruct-fp8-fast`, and section 12 says to "try the
 * taxonomy lookup first and call a model only for misses". Both the chat
 * pantry add and the photo scan use this, so a receipt that says "amul
 * taaza" and a message that says the same thing resolve identically.
 *
 * The model picks from a shortlist, it does not invent. Whatever it returns
 * is checked against the taxonomy by the caller regardless — a hallucinated
 * canonical id would carry a real allergen set belonging to some other
 * ingredient, which is the one failure this whole path exists to prevent.
 */

export const CLASSIFY_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

export interface ClassifyResult {
  /** Input name to canonical id, or null where the model had no answer. */
  ids: Record<string, string | null>;
  usage: TokenUsage;
}

/**
 * How many candidate ids to put in front of the model.
 *
 * The full taxonomy is ~800 ids, roughly 4,000 tokens — more than the whole
 * rest of the prompt and more than the answer is worth at 10 neurons a call.
 * A prefix-and-substring shortlist per name gets the plausible candidates in
 * front of it for a fraction of that, and anything outside the taxonomy is
 * rejected afterwards either way.
 */
const SHORTLIST_PER_NAME = 25;

/**
 * Candidate ids that share a word or a stem with the unmatched name.
 *
 * Deliberately crude. This is a recall filter, not a matcher: the
 * deterministic pass has already failed, so the job here is to hand the
 * model a small set that probably contains the answer, and let it choose.
 */
export function shortlist(name: string, allowedIds: string[], limit = SHORTLIST_PER_NAME): string[] {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];

  const scored: { id: string; score: number }[] = [];
  for (const id of allowedIds) {
    let score = 0;
    for (const word of words) {
      if (id.includes(word)) score += 2;
      // A shared four-character stem catches "tamatar" against "tomato" far
      // less often than it catches "paneer_tikka" against "paneer" — which
      // is the case that matters, since the model can rule out the rest.
      else if (word.length >= 4 && id.includes(word.slice(0, 4))) score += 1;
    }
    if (score > 0) scored.push({ id, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((s) => s.id);
}

export function classifyPrompt(names: string[], candidates: Record<string, string[]>): string {
  const lines = [
    'Match each unknown food name to one id from its candidate list.',
    '',
    'Rules:',
    '- Answer with an id from that name\'s list, or null if none of them is the same food.',
    '- The names may be romanized Hindi, a brand name, or a receipt abbreviation.',
    '- null is a correct answer. A wrong match is worse than no match, because',
    '  these ids carry allergen information.',
    '',
  ];
  for (const name of names) {
    const options = candidates[name] ?? [];
    lines.push(
      options.length > 0
        ? `"${name}" -> one of: ${options.join(', ')}`
        : `"${name}" -> no candidates, answer null`,
    );
  }
  lines.push('', 'Reply with JSON only: {"matches":{"<name>":"<id or null>"}}');
  return lines.join('\n');
}

/**
 * One call for every unmatched name, not one per name.
 *
 * A four-item receipt costs one inference rather than four; at section 8's
 * estimate that is about 10 neurons instead of 40.
 */
export async function classifyWithModel(
  req: ClassifyRequest,
  model: ModelRunner,
): Promise<ClassifyResult> {
  const empty: ClassifyResult = {
    ids: {},
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  if (req.names.length === 0) return empty;

  const candidates: Record<string, string[]> = {};
  for (const name of req.names) candidates[name] = shortlist(name, req.allowedIds);

  // Every name drew a blank, so there is nothing for the model to choose
  // between and no reason to spend a call.
  if (Object.values(candidates).every((c) => c.length === 0)) return empty;

  const response = await model({
    model: CLASSIFY_MODEL,
    messages: [{ role: 'user', content: classifyPrompt(req.names, candidates) }],
  });

  return { ids: parseMatches(response.text, req.names, candidates), usage: response.usage };
}

/**
 * Reads the model's answer, keeping only ids it was actually offered.
 *
 * Constraining to that name's own candidate list, rather than to the whole
 * taxonomy, closes a subtle failure: a model that confuses two rows of the
 * prompt would otherwise return a real id for the wrong name, and a real id
 * passes every downstream check.
 */
export function parseMatches(
  text: string,
  names: string[],
  candidates: Record<string, string[]>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of names) out[name] = null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return out;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }

  const matches = (raw as { matches?: unknown }).matches ?? raw;
  if (typeof matches !== 'object' || matches === null) return out;

  for (const name of names) {
    const value = (matches as Record<string, unknown>)[name];
    if (typeof value !== 'string') continue;
    if (!(candidates[name] ?? []).includes(value)) continue;
    out[name] = value;
  }
  return out;
}
