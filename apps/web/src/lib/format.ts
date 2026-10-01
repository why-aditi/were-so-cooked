/**
 * Amounts as people say them: "6 eggs", "1 kg paneer", "2 bunches coriander".
 *
 * The screens used to print `${quantity}${unit}` — "6piece egg", "1bunch
 * coriander leaves" — which is the database talking, not the app.
 */

/** Units that read the same in the plural. */
const INVARIANT = new Set(['g', 'kg', 'ml', 'l', 'tsp', 'tbsp']);

const UNIT_PLURAL: Record<string, string> = {
  cup: 'cups',
  bunch: 'bunches',
  packet: 'packets',
  pinch: 'pinches',
};

const number = (n: number): string => String(Math.round(n * 100) / 100);

/** Good enough for ingredient names; leaves anything already plural alone. */
function plural(name: string): string {
  if (/(s|leaves)$/i.test(name)) return name;
  if (/(ch|sh|x|o)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * The quantity and unit alone, for screens that show the name separately:
 * "1 kg", "2 bunches", "6". Empty when there is nothing to count.
 */
export function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity === null || unit === 'to_taste') return '';
  if (!unit || unit === 'piece') return number(quantity);
  const word = quantity === 1 || INVARIANT.has(unit) ? unit : (UNIT_PLURAL[unit] ?? unit);
  return `${number(quantity)} ${word}`;
}

/** The whole line: "6 eggs", "1 kg paneer", "salt, to taste". */
export function formatAmount(quantity: number | null, unit: string | null, name: string): string {
  if (unit === 'to_taste') return `${name}, to taste`;
  if (quantity === null) return name;
  if (!unit || unit === 'piece') {
    return `${number(quantity)} ${quantity === 1 ? name : plural(name)}`;
  }
  return `${formatQuantity(quantity, unit)} ${name}`;
}
