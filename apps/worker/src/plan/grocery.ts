import type { Taxonomy } from '@cooked/safety';
import type { IngredientCategory, PantryItem, PlanDay, Unit } from '@cooked/shared';
import { convert, convertible } from '../agent/deduct.js';

/**
 * F9's grocery list: "ingredients needed minus pantry", merged the way
 * section 6 asks — "by canonical ingredient and unit".
 *
 * Pure, and deliberately separate from `buildPlan`: the list is regenerated
 * whenever the plan or the pantry changes, and it must not need the catalog,
 * a model or a clock to do it.
 */

export interface GroceryLine {
  canonicalId: string | null;
  name: string;
  quantity: number;
  unit: Unit;
  /** The taxonomy category, which is what F9's aisle grouping is drawn from. */
  category: IngredientCategory;
}

export interface GroceryDiff {
  /** Sorted by aisle, then by name, so the UI groups without re-sorting. */
  lines: GroceryLine[];
  /**
   * Things the plan needs but cannot count: "salt to taste", a recipe line
   * with no amount. Dropping them would send someone shopping without the
   * salt; inventing a quantity would be worse, so they are listed apart.
   */
  unquantified: string[];
}

const EPSILON = 1e-6;
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const norm = (s: string): string => s.trim().toLowerCase();

const CATEGORY_ORDER: IngredientCategory[] = [
  'produce',
  'dairy',
  'meat',
  'seafood',
  'bakery',
  'grains',
  'legumes',
  'spices',
  'condiments',
  'frozen',
  'sweets',
  'beverages',
  'other',
];

/**
 * One row of the list under construction.
 *
 * An ingredient can hold more than one of these: section 6 merges "by
 * canonical ingredient and unit", and a bunch of coriander genuinely does not
 * add to 20 grams of it. Within a dimension the amounts do merge, because
 * "500 g flour" and "0.5 kg flour" as two lines is a shopping list with a
 * bug in it rather than a faithful reading of the rule.
 */
interface Bucket {
  canonicalId: string | null;
  name: string;
  unit: Unit;
  quantity: number;
  category: IngredientCategory;
}

/**
 * Everything the plan needs, minus what is already in the kitchen.
 *
 * ponytail: the pantry offsets the whole week at once, so an item that goes
 * off on Wednesday still counts against Saturday's dinner. Doing it properly
 * means walking the days in order and depleting stock as it is cooked, which
 * is the same arithmetic `planDeduction` already does per meal. Reach for
 * that if the list ever has to be right to the gram; for a shopping list, the
 * error is one item and in the safe direction only when the plan is honest
 * about dates, so the expiry cut-off below at least drops stock that is dead
 * before the week even starts.
 */
export function groceryDiff(
  plan: PlanDay[],
  pantry: PantryItem[],
  taxonomy: Taxonomy,
): GroceryDiff {
  const firstDay = plan[0]?.date;
  const planStartMs = firstDay ? Date.parse(`${firstDay}T00:00:00Z`) : Number.NaN;

  const buckets = new Map<string, Bucket[]>();
  const unquantified = new Map<string, string>();

  for (const day of plan) {
    for (const meal of day.meals) {
      for (const ing of meal.ingredients) {
        const entry = taxonomy.resolve(ing.canonicalId) ?? taxonomy.resolve(ing.name);
        const canonicalId = entry?.canonicalId ?? ing.canonicalId;
        const key = canonicalId ?? norm(ing.name);
        const name = entry?.name ?? ing.name;

        // `to_taste` is an instruction, not an amount — the same line
        // `planDeduction` refuses to deduct against.
        if (ing.quantity === null || ing.unit === null || ing.unit === 'to_taste') {
          unquantified.set(key, name);
          continue;
        }

        // Hoisted out of the property. TypeScript drops the narrowing above
        // when `ing.unit` is read inside the `find` closure, because the
        // property is mutable and the callback could run later.
        const unit = ing.unit;
        const quantity = ing.quantity;

        const list = buckets.get(key) ?? [];
        const existing = list.find((b) => convertible(unit, b.unit));
        if (existing) {
          existing.quantity += convert(quantity, unit, existing.unit) ?? 0;
        } else {
          list.push({
            canonicalId: canonicalId ?? null,
            name,
            unit: ing.unit,
            quantity: ing.quantity,
            category: entry?.category ?? 'other',
          });
        }
        buckets.set(key, list);
      }
    }
  }

  const stock = pantry.filter(
    (i) =>
      i.deletedAt === null &&
      i.quantity > 0 &&
      (i.expiresAt === null ||
        Number.isNaN(planStartMs) ||
        Date.parse(i.expiresAt) >= planStartMs),
  );

  const lines: GroceryLine[] = [];
  for (const [key, list] of buckets) {
    // A row can only be spent once, however many plan lines want it.
    const rows = stock
      .filter((i) => (i.canonicalId !== null ? i.canonicalId === key : norm(i.displayName) === key))
      .map((i) => ({ unit: i.unit, left: i.quantity }));

    for (const bucket of list) {
      for (const row of rows) {
        if (bucket.quantity <= EPSILON || row.left <= EPSILON) continue;
        const have = convert(row.left, row.unit, bucket.unit);
        // An incompatible unit is not zero stock: a bunch of coriander cannot
        // answer a 20 g line, so the line stays on the list in full.
        if (have === null) continue;
        const take = Math.min(have, bucket.quantity);
        bucket.quantity = round(bucket.quantity - take);
        row.left = round(row.left - (convert(take, bucket.unit, row.unit) ?? 0));
      }
      if (bucket.quantity > EPSILON) {
        lines.push({
          canonicalId: bucket.canonicalId,
          name: bucket.name,
          quantity: round(bucket.quantity),
          unit: bucket.unit,
          category: bucket.category,
        });
      }
    }
  }

  const stocked = new Set(
    stock.map((i) => (i.canonicalId !== null ? i.canonicalId : norm(i.displayName))),
  );

  lines.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      a.name.localeCompare(b.name) ||
      a.unit.localeCompare(b.unit),
  );

  return {
    lines,
    unquantified: [...unquantified]
      .filter(([key]) => !stocked.has(key))
      .map(([, name]) => name)
      .sort((a, b) => a.localeCompare(b)),
  };
}
