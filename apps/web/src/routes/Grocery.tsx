import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api, type GroceryRow } from '../lib/api';
import { formatAmount } from '../lib/format';

/**
 * Section 10: "Checklist grouped by aisle-style category, share as text."
 *
 * The list is derived from the current plan minus the pantry, so it is
 * empty until a plan exists. Ticking is optimistic — a checkbox that waits
 * for a round trip feels broken in a shop with one bar of signal.
 */

/** Roughly the order you walk a shop, not alphabetical. */
const AISLES = [
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
  'beverages',
  'sweets',
  'other',
];

function asText(items: GroceryRow[]): string {
  const lines: string[] = ['grocery list'];
  for (const aisle of AISLES) {
    const inAisle = items.filter((i) => i.category === aisle && !i.checked);
    if (inAisle.length === 0) continue;
    lines.push('', aisle);
    for (const item of inAisle) {
      lines.push(`- ${formatAmount(item.quantity, item.unit, item.displayName)}`);
    }
  }
  return lines.join('\n');
}

export function Grocery() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const grocery = useQuery({ queryKey: ['grocery'], queryFn: api.grocery });

  const tick = useMutation({
    mutationFn: ({ id, checked }: { id: string; checked: boolean }) => api.checkGrocery(id, checked),
    // Optimistic: the box moves now, and reverts if the write fails.
    onMutate: async ({ id, checked }) => {
      await queryClient.cancelQueries({ queryKey: ['grocery'] });
      const previous = queryClient.getQueryData<{ items: GroceryRow[] }>(['grocery']);
      queryClient.setQueryData<{ items: GroceryRow[] }>(['grocery'], (current) =>
        current
          ? { items: current.items.map((i) => (i.id === id ? { ...i, checked } : i)) }
          : current,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['grocery'], context.previous);
    },
  });

  const items = grocery.data?.items ?? [];
  const left = items.filter((i) => !i.checked).length;

  const share = async () => {
    const text = asText(items);
    try {
      // The share sheet on a phone, the clipboard everywhere else.
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // A cancelled share sheet rejects. That is not a failure worth saying
      // anything about.
    }
  };

  return (
    <Screen
      title="grocery"
      lede={items.length > 0 ? `${left} still to get` : undefined}
      action={
        items.length > 0 ? (
          <button type="button" className="btn" onClick={() => void share()}>
            {copied ? 'copied' : 'share as text'}
          </button>
        ) : undefined
      }
    >
      {grocery.isPending ? <Loading what="your list" /> : null}
      {grocery.isError ? (
        <LoadError
          error={grocery.error}
          onRetry={() => queryClient.invalidateQueries({ queryKey: ['grocery'] })}
        />
      ) : null}

      {grocery.isSuccess && items.length === 0 ? (
        <Empty line="nothing to buy, because nothing is planned yet 🧾" />
      ) : null}

      {AISLES.map((aisle) => {
        const inAisle = items.filter((i) => i.category === aisle);
        if (inAisle.length === 0) return null;
        return (
          <section key={aisle} className="mb-5">
            <h2 className="mb-1.5 text-[1.05rem]" style={{ color: 'var(--text-muted)' }}>
              {aisle}
            </h2>
            <ul className="p-0 list-none">
              {inAisle.map((item) => (
                <li key={item.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 py-1.5">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(e) => tick.mutate({ id: item.id, checked: e.target.checked })}
                      className="h-[1.2rem] w-[1.2rem] accent-[var(--color-marigold)]"
                    />
                    <span
                      style={{
                        textDecoration: item.checked ? 'line-through' : 'none',
                        color: item.checked ? 'var(--text-muted)' : 'var(--text-primary)',
                      }}
                    >
                      {formatAmount(item.quantity, item.unit, item.displayName)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Screen>
  );
}
