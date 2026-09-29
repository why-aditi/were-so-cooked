import type { Unit } from '@cooked/shared';

/**
 * Working out what a cooked meal takes out of the pantry.
 *
 * Pure: no storage, no clock beyond what is passed in. `log_cooked` is the one
 * pantry tool that needs approval (section 5: "shows the deduction first"), so
 * the number on that approval card has to be right before anyone taps it.
 */

/* ------------------------------- conversion ------------------------------- */

/**
 * Units that can be converted into one another, with their size in a base
 * unit. Anything absent is convertible only to itself.
 *
 * `bunch`, `packet` and `pinch` are deliberately not here. A bunch of
 * coriander is not a reliable number of grams, and inventing a factor would
 * turn a rough pantry into confidently wrong arithmetic. `to_taste` is a
 * recipe instruction and is never deducted at all.
 */
const DIMENSIONS: Record<string, Record<string, number>> = {
  mass: { g: 1, kg: 1000 },
  // Spoons and cups are volume, which is what makes "200ml milk" deductible
  // from a litre carton and "2 tbsp ghee" from a 500g tub impossible.
  volume: { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 },
  count: { piece: 1 },
};

function dimensionOf(unit: Unit): string | null {
  for (const [dimension, units] of Object.entries(DIMENSIONS)) {
    if (unit in units) return dimension;
  }
  return null;
}

/** @returns the amount expressed in `to`, or null if the units do not convert. */
export function convert(quantity: number, from: Unit, to: Unit): number | null {
  if (from === to) return quantity;
  const dimension = dimensionOf(from);
  if (dimension === null || dimension !== dimensionOf(to)) return null;
  const units = DIMENSIONS[dimension] as Record<string, number>;
  return (quantity * (units[from] as number)) / (units[to] as number);
}

export function convertible(from: Unit, to: Unit): boolean {
  return convert(1, from, to) !== null;
}

/* -------------------------------- planning -------------------------------- */

export interface PantryRow {
  id: string;
  canonicalId: string | null;
  displayName: string;
  quantity: number;
  unit: Unit;
  expiresAt: string | null;
}

export interface RequiredIngredient {
  canonicalId: string | null;
  name: string;
  quantity: number | null;
  unit: Unit | null;
}

export interface Deduction {
  pantryItemId: string;
  canonicalId: string | null;
  name: string;
  /** In the pantry row's own unit, which is what gets written back. */
  quantity: number;
  unit: Unit;
  /** True when the row is emptied and soft-deleted. */
  emptied: boolean;
}

export interface Shortfall {
  canonicalId: string | null;
  name: string;
  /** What the recipe still wants after everything available was taken. */
  quantity: number;
  unit: Unit;
  reason: 'not_in_pantry' | 'not_enough' | 'incompatible_unit';
}

export interface DeductionPlan {
  deductions: Deduction[];
  shortfalls: Shortfall[];
  /** Recipe lines with no amount, which cannot be deducted from anything. */
  skipped: string[];
}

/**
 * Oldest expiry first, nulls last.
 *
 * Section 8 plans meals around using soon-to-expire items first, so deducting
 * in the same order keeps the pantry consistent with that intent: cooking a
 * dish should consume the coriander that was about to go off, not the bunch
 * bought this morning.
 */
function byExpiry(a: PantryRow, b: PantryRow): number {
  if (a.expiresAt === null && b.expiresAt === null) return 0;
  if (a.expiresAt === null) return 1;
  if (b.expiresAt === null) return -1;
  return a.expiresAt.localeCompare(b.expiresAt);
}

/** Floating point: 0.1 + 0.2 should not leave 3e-17 grams in the pantry. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const EPSILON = 1e-6;

/**
 * Works out the deduction without applying it.
 *
 * Nothing is partially applied and nothing is invented: an ingredient the
 * pantry does not have becomes a shortfall, not a negative quantity. The
 * caller decides whether a shortfall is worth blocking on — a missing pinch of
 * salt should not stop someone logging dinner.
 */
export function planDeduction(
  required: RequiredIngredient[],
  pantry: PantryRow[],
  servingsMultiplier = 1,
): DeductionPlan {
  const deductions: Deduction[] = [];
  const shortfalls: Shortfall[] = [];
  const skipped: string[] = [];

  // Remaining balance per row, so two recipe lines for the same ingredient
  // cannot each spend the whole jar.
  const remaining = new Map(pantry.map((row) => [row.id, row.quantity]));

  for (const line of required) {
    if (line.quantity === null || line.unit === null || line.unit === 'to_taste') {
      skipped.push(line.name);
      continue;
    }

    let outstanding = line.quantity * servingsMultiplier;

    const candidates = pantry
      .filter((row) =>
        line.canonicalId
          ? row.canonicalId === line.canonicalId
          : row.displayName.toLowerCase() === line.name.toLowerCase(),
      )
      .sort(byExpiry);

    if (candidates.length === 0) {
      shortfalls.push({
        canonicalId: line.canonicalId,
        name: line.name,
        quantity: round(outstanding),
        unit: line.unit,
        reason: 'not_in_pantry',
      });
      continue;
    }

    let sawIncompatible = false;

    for (const row of candidates) {
      if (outstanding <= EPSILON) break;
      const available = remaining.get(row.id) ?? 0;
      if (available <= EPSILON) continue;

      // How much of this row's unit the outstanding amount represents.
      const wanted = convert(outstanding, line.unit, row.unit);
      if (wanted === null) {
        sawIncompatible = true;
        continue;
      }

      const take = Math.min(wanted, available);
      const left = round(available - take);
      remaining.set(row.id, left);

      deductions.push({
        pantryItemId: row.id,
        canonicalId: row.canonicalId,
        name: row.displayName,
        quantity: round(take),
        unit: row.unit,
        emptied: left <= EPSILON,
      });

      // Convert what was taken back into the recipe's unit to decrement.
      const takenInLineUnit = convert(take, row.unit, line.unit) ?? 0;
      outstanding = round(outstanding - takenInLineUnit);
    }

    if (outstanding > EPSILON) {
      shortfalls.push({
        canonicalId: line.canonicalId,
        name: line.name,
        quantity: round(outstanding),
        unit: line.unit,
        // "Incompatible unit" is more useful than "not enough" when the pantry
        // holds a bunch of coriander and the recipe asks for 20 grams.
        reason: sawIncompatible && deductions.length === 0 ? 'incompatible_unit' : 'not_enough',
      });
    }
  }

  return { deductions, shortfalls, skipped };
}

/** One line per deduction, for the approval card section 5 requires. */
export function describePlan(plan: DeductionPlan): string[] {
  const lines = plan.deductions.map(
    (d) => `${d.name}: ${formatQuantity(d.quantity)} ${d.unit}${d.emptied ? ' (all of it)' : ''}`,
  );
  for (const s of plan.shortfalls) {
    lines.push(
      s.reason === 'not_in_pantry'
        ? `${s.name}: not in your pantry, nothing deducted`
        : s.reason === 'incompatible_unit'
          ? `${s.name}: your pantry measures this differently, nothing deducted`
          : `${s.name}: ${formatQuantity(s.quantity)} ${s.unit} short`,
    );
  }
  return lines;
}

function formatQuantity(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
