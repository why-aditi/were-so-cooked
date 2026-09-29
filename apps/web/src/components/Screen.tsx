import type { ReactNode } from 'react';

/**
 * The frame every non-chat screen sits in.
 *
 * One component rather than a copied header per screen, so the measure, the
 * gutters and the heading level stay the same everywhere and a screen reader
 * gets a predictable shape.
 */
export function Screen({
  title,
  lede,
  action,
  children,
}: {
  title: string;
  // `| undefined` spelled out because the repo runs with
  // `exactOptionalPropertyTypes`, which distinguishes an absent prop from
  // one passed as undefined — and a conditional expression produces the
  // second.
  lede?: string | undefined;
  action?: ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-6 md:px-8">
      <div className="mx-auto max-w-[46rem]">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[2.1rem]">{title}</h1>
            {lede ? (
              <p className="mt-1.5 text-[0.95rem]" style={{ color: 'var(--text-muted)' }}>
                {lede}
              </p>
            ) : null}
          </div>
          {action}
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * The state of a screen that is still fetching.
 *
 * `aria-live` on the wrapper rather than a spinner: a spinner tells a
 * screen reader nothing, and this replaces itself with the real content.
 */
export function Loading({ what }: { what: string }) {
  return (
    <p aria-live="polite" style={{ color: 'var(--text-muted)' }}>
      loading {what}…
    </p>
  );
}

/**
 * A failed fetch.
 *
 * Section 10's server-error copy, used verbatim. Errors explain and offer a
 * way out; they do not apologise.
 */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof Error ? error.message : "we're cooked 💀 (the server, not you). try again?";
  return (
    <div role="alert">
      <p style={{ color: 'var(--text-warn)' }}>{message}</p>
      <button type="button" className="btn mt-3" onClick={onRetry}>
        try again
      </button>
    </div>
  );
}

/** An empty screen is an invitation to act, so it always offers the next move. */
export function Empty({ line, children }: { line: string; children?: ReactNode }) {
  return (
    <div className="py-8">
      <p className="text-[1.15rem]">{line}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

/** Section 10's disclaimer, verbatim wherever food is listed. */
export function Disclaimer() {
  return (
    <p className="mt-10 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
      Always check labels. If you have a severe allergy, verify every ingredient yourself.
    </p>
  );
}
