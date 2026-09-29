import type { Proposer, SubstitutionRow, Taxonomy } from '@cooked/safety';
import type {
  CookingLogEntry,
  MealSlot,
  PantryItem,
  PlanDay,
  PlanMeal,
  Profile,
  Recipe,
  Swap,
} from '@cooked/shared';
import type { TokenUsage } from '../budget/rates.js';
import type { GenerateRequest, GenerateResult } from '../recipes/generate.js';
import type { RecipeSearch } from '../recipes/store.js';
import { coverageOf, draftToRecipe, gate, summariseProfile } from '../recipes/suggest.js';

/**
 * The generate/validate/repair core of `WeeklyPlanWorkflow` (section 6), as
 * pure logic.
 *
 * F8 is four rules that all have to hold at once — soon-to-expire items
 * first, no repeats within 7 days, the profile's cook-time limit, and treats
 * held to the same diet rules as everything else — and section 6 adds the
 * safety engine on top. Rules that interact are easiest to get wrong and
 * cheapest to test, so none of them lives in the Workflow: the catalog, the
 * model and the clock all arrive as dependencies.
 *
 * Nothing here decides what a user may eat. Every candidate, catalog or
 * model-invented, goes through `gate` from `../recipes/suggest.js`, which is
 * the same door `suggest_recipes` uses; a treat is not a special case.
 */

/* --------------------------------- types ---------------------------------- */

export interface PlanRequest {
  /** First day of the week, YYYY-MM-DD. */
  weekStart: string;
  /** The slots the user left switched on. F8: each one can be switched off. */
  slots: MealSlot[];
  profile: Profile;
  pantry: PantryItem[];
  /** Section 6's load-context step: the last 14 days of cooking. */
  history: CookingLogEntry[];
  /** Absent or empty means any cuisine (F7). */
  cuisines?: string[] | undefined;
}

export interface PlanDeps {
  taxonomy: Taxonomy;
  search: RecipeSearch;
  substitutions: SubstitutionRow[];
  /** Absent means catalog-only: no repair rounds, so more partial plans. */
  generate?: ((req: GenerateRequest) => Promise<GenerateResult>) | undefined;
  propose?: Proposer | undefined;
  /** Section 7: dislikes lower a ranking, they never block. */
  dislikes?: string[] | undefined;
  now?: number | undefined;
}

/** A slot nothing safe could be found for, and why. */
export interface SlotGap {
  date: string;
  slot: MealSlot;
  reason: string;
}

/** A recipe that has already been through the safety engine. */
export interface GatedCandidate {
  recipe: Recipe;
  swaps: Swap[];
  source: 'catalog' | 'generated';
}

export interface PlanOutcome {
  /**
   * `partial` whenever a slot stayed empty. Section 6 records a run as
   * "failed or partial, never silently retried"; the same applies to a plan
   * with a hole in it, so the status is in the return type rather than
   * something the caller has to infer from a short `meals` array.
   */
  status: 'complete' | 'partial';
  days: PlanDay[];
  unfilled: SlotGap[];
  /** Slots section 6's catalog fallback filled by repeating a dish. */
  repeated: SlotGap[];
  /** Section 10's "Removed this recipe because…" copy. */
  dropped: { title: string; reason: string }[];
  repairRounds: number;
  usage: TokenUsage;
  modelCalled: boolean;
}

/* ------------------------------- constants -------------------------------- */

const PLAN_DAYS = 7;
const DAY_MS = 86_400_000;

/** Section 6: "Up to 60 catalog recipes across the four slots." */
const CANDIDATES_PER_SLOT = 15;

/** Section 6: "at most 2 rounds, then drops the day to a safe catalog fallback". */
export const MAX_REPAIR_ROUNDS = 2;

/** F8's window. Also exactly the width of the grid — see `buildPlan`. */
const NO_REPEAT_DAYS = 7;

/** The window `coverageOf` calls expiring, reused so the two agree. */
const EXPIRING_DAYS = 3;

const SLOT_ORDER: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'treat'];

/**
 * ponytail: a `Recipe` carries no slot tag, so slot fit is a search term
 * matched against title and cuisine. It will happily offer a curry for
 * breakfast if that is what the catalog holds. The upgrade is a `slots`
 * column on `recipes`, populated by the seed build and by
 * `ViralRecipesWorkflow`; until something writes it, a filter on it would
 * return nothing at all, which is worse than a loose match.
 */
const SLOT_QUERY: Record<MealSlot, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  treat: 'dessert',
};

const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  treat: 'sweet treat',
};

const norm = (s: string): string => s.trim().toLowerCase();

/* --------------------------------- dates ---------------------------------- */

/**
 * ponytail: plan days are UTC calendar days, not days in the profile's zone.
 * The plan is a grid of dates, not a schedule of instants, so the only thing
 * a zone changes is which side of midnight an expiry falls on — hours of
 * slack against a 3-day expiry window. Give `PlanRequest` a resolved offset
 * if the plan ever grows times of day.
 */
export function planDates(weekStart: string): string[] {
  const startMs = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(startMs)) throw new RangeError(`weekStart is not a date: ${weekStart}`);
  return Array.from({ length: PLAN_DAYS }, (_, i) =>
    new Date(startMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/* ------------------------------- the pantry -------------------------------- */

/**
 * Section 6's "rank pantry by expiry" step: soonest first, nulls last, and a
 * bigger quantity ahead of a smaller one on the same date because a kilo
 * going off is a worse loss than a spoonful.
 */
export function rankPantry(pantry: PantryItem[]): PantryItem[] {
  return pantry
    .filter((i) => i.deletedAt === null)
    .sort(
      (a, b) =>
        (a.expiresAt === null ? 1 : 0) - (b.expiresAt === null ? 1 : 0) ||
        (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') ||
        b.quantity - a.quantity,
    );
}

/**
 * What the pantry can still offer on a given day.
 *
 * Two exclusions, both of which change which dish wins. An item that has
 * already gone off by the day it would be cooked is not coverage, however
 * much of it there is. And an item a previous day already claimed is spent:
 * without that, one dying bunch of coriander scores three separate dinners
 * equally well and the plan only pretends to use it up.
 */
function availableOn(pantry: PantryItem[], dayMs: number, spent: Set<string>): PantryItem[] {
  return pantry.filter(
    (i) =>
      i.deletedAt === null &&
      (i.expiresAt === null || Date.parse(i.expiresAt) >= dayMs) &&
      !(i.canonicalId !== null && spent.has(i.canonicalId)),
  );
}

/** Records the expiring items a chosen dish uses up, so no later day claims them. */
function markSpent(recipe: Recipe, available: PantryItem[], dayMs: number, spent: Set<string>) {
  const wanted = new Set(recipe.ingredients.map((i) => i.canonicalId).filter(Boolean));
  const cutoff = dayMs + EXPIRING_DAYS * DAY_MS;
  for (const item of available) {
    if (item.canonicalId === null || !wanted.has(item.canonicalId)) continue;
    if (item.expiresAt !== null && Date.parse(item.expiresAt) <= cutoff) {
      spent.add(item.canonicalId);
    }
  }
}

/* ------------------------------- no repeats -------------------------------- */

/**
 * Titles cooked in the seven days before `dayMs`.
 *
 * F8's rule is about the gap between two servings of a dish, not about the
 * calendar week, so it has to be asked per day: a curry eaten six days before
 * the week starts still blocks Monday and no longer blocks Sunday.
 *
 * Inside the grid the same rule collapses to something simpler. Day 0 and day
 * 6 are six days apart, which is inside the window, so no title may appear
 * twice anywhere in the plan — one set for the whole grid, not a rolling one.
 */
export function cookedWithinWindow(history: CookingLogEntry[], dayMs: number): Set<string> {
  const from = dayMs - NO_REPEAT_DAYS * DAY_MS;
  const titles = new Set<string>();
  for (const entry of history) {
    if (Date.parse(entry.cookedAt) >= from) titles.add(norm(entry.recipeTitle));
  }
  return titles;
}

/* --------------------------------- gating ---------------------------------- */

async function gateAll(
  recipes: Recipe[],
  source: 'catalog' | 'generated',
  req: PlanRequest,
  deps: PlanDeps,
): Promise<{ candidates: GatedCandidate[]; dropped: { title: string; reason: string }[] }> {
  const candidates: GatedCandidate[] = [];
  const dropped: { title: string; reason: string }[] = [];
  for (const recipe of recipes) {
    const result = await gate(recipe, req.profile, deps);
    if (!result.ok) {
      dropped.push({ title: recipe.title, reason: result.reason });
      continue;
    }
    candidates.push({ recipe: result.recipe, swaps: result.swaps, source });
  }
  return { candidates, dropped };
}

/** F7: a cuisine filter narrows the plan; an empty list means anything goes. */
function matchesCuisine(recipe: Recipe, cuisines: string[] | undefined): boolean {
  if (!cuisines || cuisines.length === 0) return true;
  return cuisines.some((c) => norm(c) === norm(recipe.cuisine));
}

/* -------------------------------- placement -------------------------------- */

interface Placement {
  meal: PlanMeal;
  candidate: GatedCandidate;
  available: PantryItem[];
}

/**
 * The best remaining candidate for one slot on one day.
 *
 * Expiry leads, which is where this differs from `rankSuggestions`: a
 * suggestion answers "what can I cook now" and leads on coverage, while F8
 * asks a plan to use soon-to-expire items *first*. Coverage breaks the tie,
 * then fewer swaps, then the quicker dish.
 *
 * `allowRepeat` is section 6's last resort — "drops the day to a safe catalog
 * fallback" — and is never on during the normal pass.
 */
function place(
  slot: MealSlot,
  dayMs: number,
  pool: GatedCandidate[],
  req: PlanRequest,
  taken: Set<string>,
  spent: Set<string>,
  allowRepeat: boolean,
): Placement | null {
  const available = availableOn(req.pantry, dayMs, spent);
  const recent = cookedWithinWindow(req.history, dayMs);

  const scored = pool
    .filter((c) => c.recipe.minutes <= req.profile.maxCookMinutes)
    // `allowRepeat` relaxes the within-plan rule only. Section 6's fallback
    // is "a second helping of something already in this week", which is a
    // fair compromise against a blank Thursday. The cooking history is not
    // negotiable in the same way: F8's "no repeats within 7 days" is about
    // what they actually ate, and serving Tuesday's dinner again on Friday
    // is the exact thing it forbids. An unfilled slot is the better answer,
    // and `status: partial` reports it.
    .filter((c) => !recent.has(norm(c.recipe.title)))
    .filter((c) => allowRepeat || !taken.has(norm(c.recipe.title)))
    .map((c) => ({ c, cov: coverageOf(c.recipe, available, dayMs) }))
    .sort(
      (a, b) =>
        b.cov.usesExpiring - a.cov.usesExpiring ||
        b.cov.coverage - a.cov.coverage ||
        a.c.swaps.length - b.c.swaps.length ||
        a.c.recipe.minutes - b.c.recipe.minutes ||
        a.c.recipe.title.localeCompare(b.c.recipe.title),
    );

  const best = scored[0];
  if (!best) return null;

  return {
    candidate: best.c,
    available,
    meal: {
      slot,
      // Section 6: "New dishes store only a title and ingredient list in the
      // plan", and an invented dish has no catalog row to point at yet.
      recipeId: best.c.source === 'catalog' ? best.c.recipe.id : null,
      title: best.c.recipe.title,
      ingredients: best.c.recipe.ingredients,
      minutes: best.c.recipe.minutes,
      pantryCoverage: best.cov.coverage,
      swaps: best.c.swaps,
    },
  };
}

/* --------------------------------- repair ---------------------------------- */

export interface RepairResult {
  /** Fresh gated candidates, keyed by the slot they were asked for. */
  candidates: Map<MealSlot, GatedCandidate[]>;
  dropped: { title: string; reason: string }[];
  usage: TokenUsage;
  modelCalled: boolean;
}

/**
 * One repair round: section 6's "Regenerates only the failing days".
 *
 * It produces candidates rather than meals, and `buildPlan` places them. That
 * keeps the placement rules in exactly one function, so a repaired slot
 * cannot quietly acquire a different definition of "no repeats" from the
 * first pass.
 *
 * One model call per distinct failing slot, not per failing day — spike 4
 * measured a repair round at 50.5 neurons, and asking four times for the same
 * empty dinner slot would spend that four times over for one answer.
 */
export async function repairRound(
  gaps: SlotGap[],
  req: PlanRequest,
  deps: PlanDeps,
  avoidTitles: string[],
): Promise<RepairResult> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  const candidates = new Map<MealSlot, GatedCandidate[]>();
  const dropped: { title: string; reason: string }[] = [];
  if (!deps.generate) return { candidates, dropped, usage, modelCalled: false };

  const now = deps.now ?? Date.now();
  const slots = [...new Set(gaps.map((g) => g.slot))];
  // Named so the model has something to aim at; the score, not the prompt, is
  // what actually enforces F8's expiry rule.
  const expiring = rankPantry(req.pantry)
    .filter((i) => i.expiresAt !== null)
    .slice(0, 6)
    .map((i) => i.displayName);

  for (const slot of slots) {
    const wanted = gaps.filter((g) => g.slot === slot).length;
    const cuisineNote = req.cuisines?.length ? ` Stay within ${req.cuisines.join(' or ')} cuisine.` : '';
    const generated = await deps.generate({
      query:
        `${wanted} different ${SLOT_LABEL[slot]} ideas.` +
        (expiring.length > 0 ? ` Use up: ${expiring.join(', ')}.` : '') +
        cuisineNote,
      pantry: req.pantry.filter((i) => i.deletedAt === null).map((i) => i.displayName),
      profileSummary: summariseProfile(req.profile),
      maxMinutes: req.profile.maxCookMinutes,
      // One spare, because the gate rejects some.
      count: Math.min(6, wanted + 1),
      avoidTitles,
    });
    usage.promptTokens += generated.usage.promptTokens;
    usage.completionTokens += generated.usage.completionTokens;

    const recipes = await Promise.all(
      generated.drafts.map((d) => draftToRecipe(d, deps.taxonomy, now)),
    );
    const gated = await gateAll(recipes, 'generated', req, deps);
    candidates.set(slot, gated.candidates);
    dropped.push(...gated.dropped);
  }

  return { candidates, dropped, usage, modelCalled: true };
}

/* -------------------------------- buildPlan --------------------------------- */

/**
 * A week of meals, or an honest account of which slots could not be filled.
 *
 * Order matters: retrieve and gate once per slot, place greedily day by day
 * so an earlier day gets first claim on the food that dies soonest, then
 * repair only what is still empty.
 */
export async function buildPlan(req: PlanRequest, deps: PlanDeps): Promise<PlanOutcome> {
  const dates = planDates(req.weekStart);
  const slots = SLOT_ORDER.filter((s) => req.slots.includes(s));
  const dropped: { title: string; reason: string }[] = [];
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let modelCalled = false;

  const pools = new Map<MealSlot, GatedCandidate[]>();
  for (const slot of slots) {
    const found = await deps.search.find({
      text: SLOT_QUERY[slot],
      // Belt and braces: the query filters, and `place` filters again, because
      // a generated dish never passes through this query at all.
      maxMinutes: req.profile.maxCookMinutes,
      limit: CANDIDATES_PER_SLOT,
    });
    const gated = await gateAll(
      found.filter((r) => matchesCuisine(r, req.cuisines)),
      'catalog',
      req,
      deps,
    );
    pools.set(slot, gated.candidates);
    dropped.push(...gated.dropped);
  }

  // Titles already spoken for. One set for the whole grid rather than a
  // rolling window — see `cookedWithinWindow` for why seven days of plan
  // means every day is inside every other day's window.
  const taken = new Set<string>();
  const spent = new Set<string>();
  const meals = new Map<string, PlanMeal>();
  const key = (date: string, slot: MealSlot): string => `${date}|${slot}`;

  const fill = (date: string, slot: MealSlot, allowRepeat: boolean): boolean => {
    const dayMs = Date.parse(`${date}T00:00:00Z`);
    const placed = place(slot, dayMs, pools.get(slot) ?? [], req, taken, spent, allowRepeat);
    if (!placed) return false;
    meals.set(key(date, slot), placed.meal);
    taken.add(norm(placed.meal.title));
    markSpent(placed.candidate.recipe, placed.available, dayMs, spent);
    return true;
  };

  let gaps: SlotGap[] = [];
  for (const date of dates) {
    for (const slot of slots) {
      if (!fill(date, slot, false)) {
        gaps.push({ date, slot, reason: 'No safe catalog dish fitted this slot.' });
      }
    }
  }

  let repairRounds = 0;
  while (gaps.length > 0 && repairRounds < MAX_REPAIR_ROUNDS && deps.generate) {
    repairRounds += 1;
    const round = await repairRound(gaps, req, deps, [...taken]);
    usage.promptTokens += round.usage.promptTokens;
    usage.completionTokens += round.usage.completionTokens;
    modelCalled ||= round.modelCalled;
    dropped.push(...round.dropped);

    for (const [slot, extra] of round.candidates) {
      pools.set(slot, [...(pools.get(slot) ?? []), ...extra]);
    }

    const still: SlotGap[] = [];
    for (const gap of gaps) {
      if (!fill(gap.date, gap.slot, false)) {
        still.push({ ...gap, reason: 'Repair round produced nothing safe for this slot.' });
      }
    }
    // Nothing moved, so another identical round will not move it either.
    if (still.length === gaps.length) {
      gaps = still;
      break;
    }
    gaps = still;
  }

  // Section 6's fallback: after the repair rounds, take a safe dish even
  // though it repeats one already in the week. A second helping of something
  // the engine has cleared beats a blank Thursday, and `repeated` says so out
  // loud rather than letting the repeat look like a bug.
  const repeated: SlotGap[] = [];
  const unfilled: SlotGap[] = [];
  for (const gap of gaps) {
    if (fill(gap.date, gap.slot, true)) {
      repeated.push({ ...gap, reason: 'Repeated a dish from earlier in the week.' });
    } else {
      unfilled.push(gap);
    }
  }

  const days: PlanDay[] = dates.map((date) => ({
    date,
    meals: slots.map((slot) => meals.get(key(date, slot))).filter((m): m is PlanMeal => !!m),
  }));

  return {
    status: unfilled.length === 0 ? 'complete' : 'partial',
    days,
    unfilled,
    repeated,
    dropped,
    repairRounds,
    usage,
    modelCalled,
  };
}
