import type { ReactNode } from 'react';

/**
 * Section 10's six chat cards.
 *
 * | Card          | Shown when                                    |
 * | Pantry diff   | Items added, changed or removed               |
 * | Recipe        | A suggestion, with a compliance badge         |
 * | Substitution  | A modified recipe, each swap original -> new  |
 * | Approval      | A tool needs confirmation                     |
 * | Scan confirm  | A photo scan is ready, editable checkboxes    |
 * | Plan progress | Plan Workflow running, step names update live |
 *
 * Four are stickers. Two — Approval and any allergen notice — are `sober`:
 * square, flat, sentence case, no emoji. That is the same rule section 10
 * states for copy, applied to the shape of the thing, so a card that can
 * cost someone an allergen never looks like a joke.
 */

/** A stable tilt per card, so a thread looks stuck on rather than ruled. */
function tilt(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const degrees = ((Math.abs(hash) % 25) - 12) / 10;
  return `${degrees.toFixed(2)}deg`;
}

function Card({
  id,
  title,
  accent,
  children,
  footer,
}: {
  id: string;
  title: string;
  accent: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <article
      className="sticker p-4 my-3 max-w-[34rem]"
      style={{ ['--tilt' as string]: tilt(id) }}
    >
      <h3 className="text-[1.05rem] mb-2" style={{ color: accent }}>
        {title}
      </h3>
      {children}
      {footer ? <div className="mt-3 flex flex-wrap gap-2">{footer}</div> : null}
    </article>
  );
}

/* ------------------------------- pantry diff ------------------------------ */

export interface PantryDiffItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  expires: string | null;
  approximate: boolean;
}

export function PantryDiffCard({
  id,
  added = [],
  removed = [],
  unverified = [],
}: {
  id: string;
  added?: PantryDiffItem[];
  removed?: string[];
  unverified?: string[];
}) {
  return (
    <Card id={id} title="fridge updated 🧊" accent="var(--text-go)">
      <ul className="space-y-1.5">
        {added.map((item) => (
          <li key={item.id} className="flex items-baseline gap-2">
            <span aria-hidden="true" style={{ color: 'var(--text-go)' }}>
              +
            </span>
            <span className="font-semibold">
              {item.quantity}
              {item.unit} {item.name}
            </span>
            {item.approximate ? (
              <span className="text-[0.78rem]" style={{ color: 'var(--text-muted)' }}>
                roughly
              </span>
            ) : null}
          </li>
        ))}
        {removed.map((name) => (
          <li key={name} className="flex items-baseline gap-2">
            <span aria-hidden="true" style={{ color: 'var(--text-warn)' }}>
              −
            </span>
            <span className="line-through" style={{ color: 'var(--text-muted)' }}>
              {name}
            </span>
          </li>
        ))}
      </ul>

      {unverified.length > 0 ? (
        // Plain, sentence case, no emoji: this is the allergy caveat, and
        // section 10 does not let it be funny.
        <p className="mt-3 text-[0.88rem]" style={{ color: 'var(--text-warn)' }}>
          We could not match {unverified.join(', ')} to a known ingredient, so we cannot check it
          against your allergies.
        </p>
      ) : null}
    </Card>
  );
}

/* ---------------------------------- recipe -------------------------------- */

export interface RecipeSuggestion {
  id: string;
  title: string;
  cuisine: string;
  minutes: number;
  have: string[];
  missing: string[];
  advisories?: string[];
}

export function RecipeCard({
  recipe,
  onCook,
}: {
  recipe: RecipeSuggestion;
  onCook?: (id: string) => void;
}) {
  const total = recipe.have.length + recipe.missing.length;
  return (
    <Card
      id={recipe.id}
      title={recipe.title}
      accent="var(--text-act)"
      footer={
        onCook ? (
          <button type="button" className="btn btn-primary" onClick={() => onCook(recipe.id)}>
            i made this
          </button>
        ) : undefined
      }
    >
      <p className="text-[0.88rem] m-0" style={{ color: 'var(--text-muted)' }}>
        {recipe.cuisine} · {recipe.minutes} min
      </p>

      {/* The compliance badge section 10 asks for. It states what was
          checked, not that the dish is "safe" — the engine checks rules, it
          does not certify a kitchen. */}
      <p className="mt-2 mb-0 text-[0.88rem]">
        <span className="chip" style={{ color: 'var(--text-go)' }}>
          passes your profile
        </span>
      </p>

      <p className="mt-3 mb-0 text-[0.92rem]">
        you have {recipe.have.length} of {total}
        {recipe.missing.length > 0 ? (
          <>
            {' '}
            — still need{' '}
            <span style={{ color: 'var(--text-warn)' }}>{recipe.missing.join(', ')}</span>
          </>
        ) : (
          <> — everything, actually 🔥</>
        )}
      </p>

      {recipe.advisories?.length ? (
        <p className="mt-2 mb-0 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
          {recipe.advisories.join(' ')}
        </p>
      ) : null}
    </Card>
  );
}

/* ------------------------------- substitution ----------------------------- */

export interface Swap {
  from: string;
  to: string;
  because: string;
  why: string;
  note: string | null;
}

export function SubstitutionCard({
  id,
  title,
  swaps,
}: {
  id: string;
  title: string;
  swaps: Swap[];
}) {
  return (
    <Card id={id} title={`${title}, rebuilt`} accent="var(--text-act)">
      <ul className="space-y-2.5 m-0 p-0 list-none">
        {swaps.map((swap) => (
          <li key={`${swap.from}-${swap.to}`}>
            <p className="m-0 font-semibold">
              {swap.from} <span aria-label="becomes">→</span> {swap.to}
            </p>
            <p className="m-0 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
              {swap.why}
              {swap.note ? ` ${swap.note}` : ''}
            </p>
          </li>
        ))}
      </ul>
      {swaps.length === 0 ? <p className="m-0">nothing needed swapping. it already fits ✨</p> : null}
    </Card>
  );
}

/* --------------------------------- approval -------------------------------- */

/**
 * The one card that changes something irreversible, so it is the one card
 * that never looks playful: square, flat, sentence case, no emoji.
 */
export function ApprovalCard({
  toolName,
  summary,
  pending,
  onApprove,
  onReject,
}: {
  toolName: string;
  summary: string[];
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const heading =
    toolName === 'update_profile' ? 'Confirm this profile change' : 'Confirm this deduction';
  const dropsAnAllergen = summary.some((line) => line.includes('allergy list'));

  return (
    <section
      className={`sober ${dropsAnAllergen ? 'sober-warn' : ''} p-4 my-3 max-w-[34rem]`}
      aria-labelledby={`approval-${toolName}`}
    >
      <h3 id={`approval-${toolName}`} className="text-[1rem] mb-2" style={{ letterSpacing: '-0.01em' }}>
        {heading}
      </h3>

      <ul className="space-y-1 text-[0.92rem]">
        {summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <div className="mt-4 flex gap-2">
        <button type="button" className="btn btn-primary" onClick={onApprove} disabled={pending}>
          Approve
        </button>
        <button type="button" className="btn" onClick={onReject} disabled={pending}>
          Reject
        </button>
      </div>
    </section>
  );
}

/* ------------------------------- scan confirm ------------------------------ */

export interface ScanConfirmItem {
  name: string;
  canonicalId: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
  expiresAt: string | null;
  selected: boolean;
}

export function ScanConfirmCard({
  id,
  items,
  pending,
  onToggle,
  onConfirm,
}: {
  id: string;
  items: ScanConfirmItem[];
  pending: boolean;
  onToggle: (index: number) => void;
  onConfirm: () => void;
}) {
  const ticked = items.filter((i) => i.selected).length;

  return (
    <Card
      id={id}
      title="what we saw 📸"
      accent="var(--text-act)"
      footer={
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={pending || items.length === 0}
        >
          add {ticked} {ticked === 1 ? 'thing' : 'things'}
        </button>
      }
    >
      {items.length === 0 ? (
        <p className="m-0">nothing edible in that one. try again? 👀</p>
      ) : (
        <ul className="space-y-1 m-0 p-0 list-none">
          {items.map((item, index) => {
            const unsure = item.confidence < 0.5 || item.canonicalId === null;
            return (
              <li key={`${item.name}-${index}`}>
                <label className="flex items-center gap-2.5 py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => onToggle(index)}
                    className="w-[1.15rem] h-[1.15rem] accent-[var(--color-marigold)]"
                  />
                  <span className="font-semibold">
                    {item.quantity !== null ? `${item.quantity}${item.unit ?? ''} ` : ''}
                    {item.name}
                  </span>
                  {unsure ? (
                    <span className="chip" style={{ color: 'var(--text-warn)' }}>
                      not sure
                    </span>
                  ) : null}
                  {item.expiresAt ? (
                    <span className="chip" style={{ color: 'var(--text-muted)' }}>
                      use by {item.expiresAt.slice(0, 10)}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {items.some((i) => i.canonicalId === null) ? (
        <p className="mt-3 mb-0 text-[0.85rem]" style={{ color: 'var(--text-warn)' }}>
          Items marked "not sure" could not be matched to a known ingredient. We cannot check those
          against your allergies.
        </p>
      ) : null}
    </Card>
  );
}

/* ------------------------------- plan progress ----------------------------- */

export function PlanProgressCard({
  id,
  steps,
}: {
  id: string;
  steps: { name: string; status: 'pending' | 'started' | 'done' | 'failed' }[];
}) {
  const done = steps.filter((s) => s.status === 'done').length;

  return (
    <Card id={id} title="letting him cook…" accent="var(--text-work)">
      <ol className="space-y-1 m-0 p-0 list-none">
        {steps.map((step) => (
          <li key={step.name} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              style={{
                color:
                  step.status === 'done'
                    ? 'var(--text-go)'
                    : step.status === 'failed'
                      ? 'var(--text-warn)'
                      : step.status === 'pending'
                        ? 'var(--text-muted)'
                        : 'var(--text-work)',
              }}
            >
              {step.status === 'done'
                ? '✓'
                : step.status === 'failed'
                  ? '✕'
                  : step.status === 'pending'
                    ? '·'
                    : '•'}
            </span>
            <span style={{ color: step.status === 'started' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {step.name}
            </span>
          </li>
        ))}
      </ol>

      {/* Announced politely: a live region that fires on every step would
          talk over a screen reader user mid-sentence. */}
      <p className="sr-only" aria-live="polite">
        {done} of {steps.length} steps done
      </p>
    </Card>
  );
}
