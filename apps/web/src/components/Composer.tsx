import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BudgetMeter } from './BudgetMeter';

/**
 * The composer from section 10: a message box, photo attach, budget meter.
 *
 * The textarea grows to a cap rather than scrolling from line two, and
 * Enter sends while Shift+Enter breaks the line — the convention people
 * already have from every other chat box, so it needs no explaining.
 */

const MAX_ROWS = 6;

export function Composer({
  onSend,
  onPhoto,
  disabled,
  busy,
}: {
  onSend: (text: string) => void;
  onPhoto: (file: File) => void;
  disabled: boolean;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (areaRef.current) areaRef.current.style.height = 'auto';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    const lineHeight = 24;
    element.style.height = `${Math.min(element.scrollHeight, lineHeight * MAX_ROWS)}px`;
  };

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    // Checked here as well as on the server, so a 20 MB photo fails
    // instantly instead of after a long upload on a phone connection.
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError('That photo is over 5 MB. Try a smaller one.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setPhotoError('Photos need to be JPEG, PNG or WebP.');
      return;
    }
    setPhotoError(null);
    onPhoto(file);
  };

  return (
    <div
      className="border-t-2 px-3 pt-2.5"
      style={{
        borderColor: 'var(--line)',
        background: 'var(--surface-page)',
        // Clears the home indicator on a phone without padding a desktop.
        paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="mx-auto max-w-[46rem]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <BudgetMeter />
          {busy ? (
            <span className="text-[0.8rem]" style={{ color: 'var(--text-muted)' }} aria-live="polite">
              thinking…
            </span>
          ) : null}
        </div>

        {photoError ? (
          // Plain and sentence case: this is a failure, not a bit.
          <p role="alert" className="mb-2 text-[0.85rem]" style={{ color: 'var(--text-warn)' }}>
            {photoError}
          </p>
        ) : null}

        <form onSubmit={submit} className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => {
              pickPhoto(e.target.files?.[0]);
              // Reset so picking the same file twice still fires.
              e.target.value = '';
            }}
          />

          <button
            type="button"
            className="btn shrink-0 px-3"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            <span aria-hidden="true">📷</span>
            <span className="sr-only">Attach a photo of your shopping or fridge</span>
          </button>

          <label htmlFor="composer" className="sr-only">
            Message your kitchen agent
          </label>
          <textarea
            id="composer"
            ref={areaRef}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder="bought 1kg paneer and a bunch of dhaniya…"
            className="field resize-none leading-6"
            onChange={(e) => {
              setText(e.target.value);
              grow(e.target);
            }}
            onKeyDown={onKeyDown}
          />

          <button type="submit" className="btn btn-primary shrink-0" disabled={disabled || !text.trim()}>
            send
          </button>
        </form>

        <p className="sr-only" id="composer-hint">
          Press Enter to send, Shift and Enter for a new line.
        </p>
      </div>
    </div>
  );
}
