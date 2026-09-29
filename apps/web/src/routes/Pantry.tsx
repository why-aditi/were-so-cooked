import type { PantryItem } from '@cooked/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Disclaimer, Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "Items grouped by category, expiry badges, inline edit, add by
 * text."
 *
 * Add-by-text goes through the same normalizer chat uses, so "2 pyaaz" works
 * here too — a second, dumber entry path would produce pantry rows that
 * behave differently from the ones the agent makes.
 */

const CATEGORY_ORDER = [
  'produce',
  'dairy',
  'meat',
  'seafood',
  'grains',
  'legumes',
  'spices',
  'condiments',
  'bakery',
  'frozen',
  'beverages',
  'sweets',
  'other',
];

function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.round((Date.parse(expiresAt) - Date.now()) / 86_400_000);
}

/** The expiry badge. Never colour alone — the words carry it. */
function ExpiryBadge({ item }: { item: PantryItem }) {
  const days = daysLeft(item.expiresAt);
  if (days === null) {
    return (
      <span className="chip" style={{ color: 'var(--text-muted)' }}>
        no date
      </span>
    );
  }

  const urgent = days <= 2;
  const label =
    days < 0 ? 'past it' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `${days} days`;

  return (
    <span className="chip" style={{ color: urgent ? 'var(--text-warn)' : 'var(--text-go)' }}>
      {label}
      {item.expirySource === 'estimated' ? (
        <>
          <span aria-hidden="true">*</span>
          <span className="sr-only"> (estimated)</span>
        </>
      ) : null}
    </span>
  );
}

export function Pantry() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);

  const pantry = useQuery({ queryKey: ['pantry'], queryFn: api.pantry });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pantry'] });

  const add = useMutation({
    mutationFn: api.addPantry,
    onSuccess: () => {
      setText('');
      void refresh();
    },
  });

  const patch = useMutation({
    mutationFn: ({ id, ...rest }: { id: string } & Record<string, unknown>) =>
      api.patchPantry(id, rest),
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (item: PantryItem) => api.removePantry(item.id),
    onSuccess: (_result, item) => {
      // Soft delete, so the undo is real rather than a re-add.
      setUndo({ id: item.id, name: item.displayName });
      void refresh();
    },
  });

  const restore = useMutation({
    mutationFn: api.restorePantry,
    onSuccess: () => {
      setUndo(null);
      void refresh();
    },
  });

  const items = pantry.data?.items ?? [];
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: items
      .filter((i) => i.category === category)
      .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999')),
  })).filter((group) => group.items.length > 0);

  return (
    <Screen title="pantry" lede={`${items.length} things in here`}>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate(text.trim());
        }}
      >
        <label htmlFor="add-item" className="sr-only">
          Add items by typing what you bought
        </label>
        <input
          id="add-item"
          className="field"
          value={text}
          placeholder="2 pyaaz, 1.5kg aloo, a bunch of dhaniya…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-primary shrink-0" disabled={!text.trim() || add.isPending}>
          {add.isPending ? 'adding…' : 'add'}
        </button>
      </form>

      {add.isError ? (
        <p role="alert" className="mb-4 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
          {add.error instanceof Error ? add.error.message : 'That did not go in. Try again.'}
        </p>
      ) : null}

      {undo ? (
        <div className="mb-4 flex items-center gap-3 text-[0.9rem]" role="status">
          <span>removed {undo.name}</span>
          <button type="button" className="btn" onClick={() => restore.mutate(undo.id)}>
            undo
          </button>
        </div>
      ) : null}

      {pantry.isPending ? <Loading what="your pantry" /> : null}
      {pantry.isError ? <LoadError error={pantry.error} onRetry={refresh} /> : null}

      {pantry.isSuccess && items.length === 0 ? (
        <Empty line="your fridge is in witness protection. add something 👀" />
      ) : null}

      {grouped.map((group) => (
        <section key={group.category} className="mb-6">
          <h2 className="mb-2 text-[1.1rem]" style={{ color: 'var(--text-muted)' }}>
            {group.category}
          </h2>
          <ul className="space-y-2 p-0 list-none">
            {group.items.map((item) => (
              <li key={item.id} className="sticker p-3" style={{ ['--tilt' as string]: '0deg' }}>
                {editing === item.id ? (
                  <EditRow
                    item={item}
                    pending={patch.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={(fields) => patch.mutate({ id: item.id, ...fields })}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="font-semibold">{item.displayName}</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {item.quantity}
                      {item.unit}
                      {item.qtyConfidence === 'approx' ? (
                        <span className="sr-only"> (approximate)</span>
                      ) : null}
                    </span>
                    <ExpiryBadge item={item} />
                    {item.canonicalId === null ? (
                      // Plain and sentence case: this is the allergy caveat.
                      <span className="chip" style={{ color: 'var(--text-warn)' }}>
                        Not verified
                      </span>
                    ) : null}
                    <span className="ml-auto flex gap-2">
                      <button type="button" className="btn" onClick={() => setEditing(item.id)}>
                        edit<span className="sr-only"> {item.displayName}</span>
                      </button>
                      <button type="button" className="btn" onClick={() => remove.mutate(item)}>
                        remove<span className="sr-only"> {item.displayName}</span>
                      </button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {items.some((i) => i.canonicalId === null) ? (
        <p className="mt-6 text-[0.88rem]" style={{ color: 'var(--text-warn)' }}>
          Items marked "Not verified" could not be matched to a known ingredient, so we cannot check
          them against your allergies.
        </p>
      ) : null}

      {items.length > 0 ? <Disclaimer /> : null}
    </Screen>
  );
}

/** Inline edit. Escape cancels, which is the shortcut people already try. */
function EditRow({
  item,
  pending,
  onSave,
  onCancel,
}: {
  item: PantryItem;
  pending: boolean;
  onSave: (fields: { quantity: number; expiresAt: string | null }) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [date, setDate] = useState(item.expiresAt?.slice(0, 10) ?? '');

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          quantity: Number(quantity) || item.quantity,
          expiresAt: date ? new Date(`${date}T00:00:00Z`).toISOString() : null,
        });
      }}
    >
      <span className="w-full font-semibold">{item.displayName}</span>

      <span>
        <label htmlFor={`qty-${item.id}`} className="block text-[0.78rem]" style={{ color: 'var(--text-muted)' }}>
          amount ({item.unit})
        </label>
        <input
          id={`qty-${item.id}`}
          className="field w-24"
          inputMode="decimal"
          value={quantity}
          autoFocus
          onChange={(e) => setQuantity(e.target.value)}
        />
      </span>

      <span>
        <label htmlFor={`exp-${item.id}`} className="block text-[0.78rem]" style={{ color: 'var(--text-muted)' }}>
          use by
        </label>
        {/* A native date input: it is keyboard-accessible, localised and
            already familiar, which no custom picker manages for free. */}
        <input
          id={`exp-${item.id}`}
          type="date"
          className="field w-44"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </span>

      <button type="submit" className="btn btn-primary" disabled={pending}>
        save
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        cancel
      </button>
    </form>
  );
}
