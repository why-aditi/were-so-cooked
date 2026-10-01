import type {
  CookingLogEntry,
  MealSlot,
  PantryItem,
  PlanDay,
  PlanStatus,
  Profile,
} from '@cooked/shared';
import type { GroceryDiff } from './grocery.js';
import type { PlanOutcome, SlotGap } from './plan.js';

/**
 * How a weekly plan is stored in the agent's `plans` row, and how it is
 * shown.
 *
 * Kept apart from the agent so the two mappings below — the row's status
 * vocabulary to section 11's, and a finished outcome to a stored record —
 * are pure and tested without a Durable Object in the loop.
 */

/** Every meal slot, in the order a day reads. F8: all four on by default. */
export const ALL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'treat'];

/**
 * The Workflow's steps, by the names the plan progress card shows.
 *
 * One list, used by the Workflow when it reports progress and by the tool
 * when it hands the card its initial state, so the two cannot drift.
 */
export const PLAN_STEPS = [
  'reading your kitchen',
  'checking the budget',
  'building the week',
  'writing the grocery list',
  'saving',
] as const;
export type PlanStep = (typeof PLAN_STEPS)[number];

/** Section 6's load-context step, as the agent hands it to the Workflow. */
export interface PlanContext {
  profile: Profile;
  pantry: PantryItem[];
  history: CookingLogEntry[];
  dislikes: string[];
  isDemo: boolean;
}

/** The `plans.status` column. Its CHECK constraint is in `agent/schema.ts`. */
export type StoredStatus = 'generating' | 'ready' | 'partial' | 'failed';

/** The JSON in `plans.plan`. */
export interface StoredPlan {
  slots: MealSlot[];
  cuisines: string[];
  days: PlanDay[];
  /** Slots nothing safe could fill. Non-empty exactly when status is `partial`. */
  unfilled: SlotGap[];
  /** Slots filled by repeating a dish from earlier in the week. */
  repeated: SlotGap[];
  /** Section 10's "Removed this recipe because…" copy, for the plan screen. */
  dropped: { title: string; reason: string }[];
  /** Why there is no plan, when status is `failed`. */
  error: string | null;
  /** Set when the run went ahead catalog-only because the budget said no. */
  catalogOnly: boolean;
}

/** What `GET /api/plans/current` and `get_plan` return. */
export interface PlanView extends StoredPlan {
  id: string;
  weekStart: string;
  /** Section 11's vocabulary, not the column's. */
  status: PlanStatus;
  /** True when every switched-on slot of every day has a meal. */
  complete: boolean;
  workflowId: string | null;
  createdAt: string;
}

/**
 * The column's four states onto section 11's `PlanStatus`.
 *
 * `partial` is a finished plan with a hole in it, so it reads as `ready`; the
 * hole is reported by `complete` and `unfilled` rather than by inventing a
 * fifth status the shared schema does not have.
 */
export function viewStatus(stored: StoredStatus): PlanStatus {
  switch (stored) {
    case 'generating':
      return 'running';
    case 'ready':
    case 'partial':
      return 'ready';
    case 'failed':
      return 'failed';
  }
}

export function emptyPlan(slots: MealSlot[], cuisines: string[]): StoredPlan {
  return {
    slots,
    cuisines,
    days: [],
    unfilled: [],
    repeated: [],
    dropped: [],
    error: null,
    catalogOnly: false,
  };
}

/**
 * Old rows, and rows a failed write left half-filled, still parse. A plan the
 * screen cannot read is worse than one with defaults in it.
 */
export function parseStoredPlan(json: string): StoredPlan {
  let raw: Partial<StoredPlan> = {};
  try {
    raw = JSON.parse(json) as Partial<StoredPlan>;
  } catch {
    // Fall through to the defaults.
  }
  return {
    slots: Array.isArray(raw.slots) && raw.slots.length > 0 ? raw.slots : ALL_SLOTS,
    cuisines: Array.isArray(raw.cuisines) ? raw.cuisines : [],
    days: Array.isArray(raw.days) ? raw.days : [],
    unfilled: Array.isArray(raw.unfilled) ? raw.unfilled : [],
    repeated: Array.isArray(raw.repeated) ? raw.repeated : [],
    dropped: Array.isArray(raw.dropped) ? raw.dropped : [],
    error: typeof raw.error === 'string' ? raw.error : null,
    catalogOnly: raw.catalogOnly === true,
  };
}

/** A finished outcome as the record the agent stores, plus its status. */
export function recordFromOutcome(
  base: StoredPlan,
  outcome: Pick<PlanOutcome, 'status' | 'days' | 'unfilled' | 'repeated' | 'dropped'>,
  catalogOnly: boolean,
): { status: StoredStatus; plan: StoredPlan } {
  return {
    status: outcome.status === 'complete' ? 'ready' : 'partial',
    plan: {
      ...base,
      days: outcome.days,
      unfilled: outcome.unfilled,
      repeated: outcome.repeated,
      // The same dish can be dropped once per slot it was offered for. One
      // line each is enough for the screen.
      dropped: dedupeByTitle(outcome.dropped),
      error: null,
      catalogOnly,
    },
  };
}

/** Grocery rows as the agent writes them: counted lines, then uncounted ones. */
export function groceryRows(diff: GroceryDiff): {
  canonicalId: string | null;
  displayName: string;
  category: string;
  quantity: number | null;
  unit: string | null;
}[] {
  return [
    ...diff.lines.map((l) => ({
      canonicalId: l.canonicalId,
      displayName: l.name,
      category: l.category,
      quantity: l.quantity,
      unit: l.unit,
    })),
    // "Salt to taste" still goes on the list — without an amount, rather
    // than with an invented one. See `GroceryDiff.unquantified`.
    ...diff.unquantified.map((name) => ({
      canonicalId: null,
      displayName: name,
      category: 'other',
      quantity: null,
      unit: null,
    })),
  ];
}

/**
 * Today's date in the user's own time zone, YYYY-MM-DD.
 *
 * The default week start. UTC would start a Sydney user's week on yesterday
 * for most of their morning.
 */
export function todayIn(timeZone: string, now = Date.now()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = i.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
