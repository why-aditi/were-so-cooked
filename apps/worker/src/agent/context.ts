import type { PantryItem, Profile } from '@cooked/shared';

/**
 * The context window from section 5's table.
 *
 * Llama 3.3 70B on Workers AI has a 24K window and section 5 caps a turn at
 * about 6K input tokens. Spike 4 measured a real turn at 2,392, so there is
 * headroom now — but a pantry grows, and the failure mode when it stops
 * fitting is not an error, it is the model quietly losing the oldest half of
 * the conversation. So every slot is capped here, and the caps are tested.
 *
 * Pure: no storage, no clock beyond an injected `now`. The agent reads the
 * rows, this decides what survives.
 */

export interface Slot {
  name: 'system' | 'profile' | 'pantry' | 'taste' | 'history';
  /** Section 5's per-slot ceiling, in tokens. */
  cap: number;
  tokens: number;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on tool results, so the model can tie them to its call. */
  name?: string;
}

export interface BuildContextInput {
  system: string;
  profile: Profile;
  pantry: PantryItem[];
  /** Top taste memories for this message. Empty until Vectorize is wired in. */
  taste?: string[];
  history: ChatMessage[];
  message: string;
  now?: number;
}

export interface BuiltContext {
  messages: ChatMessage[];
  slots: Slot[];
  estimatedTokens: number;
  /** History turns dropped to fit. Non-zero means the window is under pressure. */
  droppedMessages: number;
}

export const SLOT_CAPS = {
  system: 1_200,
  profile: 200,
  pantry: 600,
  taste: 300,
  /** Section 5: "Remainder". 6K total less the four fixed slots. */
  total: 6_000,
} as const;

/** Section 5: the pantry slot lists what is going off within three days. */
const PANTRY_URGENT_DAYS = 3;

/**
 * Tokens, roughly.
 *
 * ponytail: four characters per token, the usual English heuristic. A real
 * tokenizer is a dependency and a WASM blob for a number that only has to be
 * right enough to trim on. It under-counts Hindi transliterations and emoji,
 * so the caps are enforced with a margin below — swap in `js-tiktoken` only if
 * a turn ever actually overflows.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cuts text to a token cap on a line boundary, so a slot never ends mid-fact. */
export function clampToTokens(text: string, cap: number): string {
  if (estimateTokens(text) <= cap) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > cap) break;
    kept.push(line);
    used += cost;
  }
  // A single line longer than the whole cap still has to be cut somewhere.
  if (kept.length === 0) return text.slice(0, cap * 4);
  return kept.join('\n');
}

/**
 * Section 5: "Compact summary of diets, allergens, exclusions, cuisines, time
 * limit."
 *
 * Allergens go first and are never trimmed. If this slot ever has to be cut,
 * it must not be the allergy list that goes — a model that cannot see "peanut"
 * will happily suggest peanuts.
 */
export function renderProfile(p: Profile): string {
  const lines: string[] = [];
  lines.push(p.allergens.length > 0 ? `allergens: ${p.allergens.join(', ')}` : 'allergens: none');
  if (p.diets.length > 0) lines.push(`diets: ${p.diets.join(', ')}`);
  if (p.exclusions.length > 0) lines.push(`will not eat: ${p.exclusions.join(', ')}`);
  if (p.cuisines.length > 0) lines.push(`likes: ${p.cuisines.join(', ')}`);
  lines.push(`serves ${p.servings}, up to ${p.maxCookMinutes} min, spice ${p.spiceLevel}`);
  return lines.join('\n');
}

/**
 * Section 5: "Items expiring within 3 days, then counts by category."
 *
 * Naming every item would be more useful and does not fit — 200 items is well
 * past 600 tokens. The urgent ones are named because the model needs them to
 * answer "what should I cook tonight"; the rest are counts, which is enough
 * for it to know whether to call `list_pantry`.
 */
export function renderPantry(items: PantryItem[], now: number): string {
  const live = items.filter((i) => i.deletedAt === null);
  if (live.length === 0) return 'pantry: empty';

  const cutoff = now + PANTRY_URGENT_DAYS * 86_400_000;
  const urgent = live.filter((i) => i.expiresAt !== null && Date.parse(i.expiresAt) <= cutoff);

  const lines: string[] = [];
  if (urgent.length > 0) {
    lines.push(`expiring within ${PANTRY_URGENT_DAYS} days:`);
    for (const i of urgent) {
      const days = Math.round((Date.parse(i.expiresAt as string) - now) / 86_400_000);
      const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `${days}d`;
      lines.push(`- ${i.displayName} ${i.quantity}${i.unit} (${when})`);
    }
  }

  const byCategory = new Map<string, number>();
  for (const i of live) byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + 1);
  const counts = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`)
    .join(', ');
  lines.push(`${live.length} items total: ${counts}`);
  return lines.join('\n');
}

/**
 * Assembles the turn.
 *
 * The four fixed slots are built and clamped first, then history fills what is
 * left, newest first. Trimming from the oldest is section 5's rule and is the
 * right one: the last thing said is what the user's message refers to.
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const now = input.now ?? Date.now();

  const fixed: Slot[] = [
    slot('system', SLOT_CAPS.system, input.system),
    slot('profile', SLOT_CAPS.profile, renderProfile(input.profile)),
    slot('pantry', SLOT_CAPS.pantry, renderPantry(input.pantry, now)),
    slot('taste', SLOT_CAPS.taste, (input.taste ?? []).join('\n')),
  ];

  const fixedTokens = fixed.reduce((n, s) => n + s.tokens, 0);
  const messageTokens = estimateTokens(input.message);
  let remaining = SLOT_CAPS.total - fixedTokens - messageTokens;

  const keptHistory: ChatMessage[] = [];
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const m = input.history[i] as ChatMessage;
    const cost = estimateTokens(m.content) + 4; // role and delimiter overhead
    if (cost > remaining) break;
    keptHistory.unshift(m);
    remaining -= cost;
  }

  const historySlot = slot(
    'history',
    Math.max(0, SLOT_CAPS.total - fixedTokens - messageTokens),
    keptHistory.map((m) => `${m.role}: ${m.content}`).join('\n'),
  );

  // The three context slots ride in the system message rather than as separate
  // turns. Workers AI tool calling is most reliable with a single system block
  // (spike 3), and a "here is your pantry" user turn invites the model to
  // answer it instead of the real question.
  const systemParts = [fixed[0]?.text ?? ''];
  if (fixed[1]?.text) systemParts.push(`--- profile ---\n${fixed[1].text}`);
  if (fixed[2]?.text) systemParts.push(`--- pantry ---\n${fixed[2].text}`);
  if (fixed[3]?.text) systemParts.push(`--- what they like ---\n${fixed[3].text}`);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    ...keptHistory,
    { role: 'user', content: input.message },
  ];

  const slots = [...fixed, historySlot];
  return {
    messages,
    slots,
    estimatedTokens: slots.reduce((n, s) => n + s.tokens, 0) + messageTokens,
    droppedMessages: input.history.length - keptHistory.length,
  };
}

function slot(name: Slot['name'], cap: number, raw: string): Slot {
  const text = clampToTokens(raw, cap);
  return { name, cap, tokens: estimateTokens(text), text };
}
