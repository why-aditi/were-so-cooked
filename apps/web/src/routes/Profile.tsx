import { Allergen, Diet, type Profile as ProfileShape } from '@cooked/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "Diets, allergens, exclusions, cuisines, cook-time limit,
 * servings, time zone, delete account."
 *
 * The whole screen is deliberately sober. Everywhere else the copy is
 * lowercase and a bit unhinged; here every label is plain and sentence case,
 * because section 10 exempts "safety, allergy and data-loss messages" and
 * this screen is nothing but those three. A joke next to an allergy checkbox
 * would be the one place the voice actually costs something.
 *
 * Both enums are rendered in full from `packages/shared`, not from a
 * hand-copied list — 18 diets and 14 allergens, and a diet added to the
 * schema appears here without anyone remembering to add it.
 */

/** Readable labels. The enum values are snake_case identifiers, not copy. */
const DIET_LABELS: Record<string, string> = {
  vegetarian: 'Vegetarian',
  eggetarian: 'Eggetarian',
  ovo_vegetarian: 'Ovo-vegetarian',
  lacto_vegetarian: 'Lacto-vegetarian',
  vegan: 'Vegan',
  jain: 'Jain',
  sattvic: 'Sattvic',
  pescatarian: 'Pescatarian',
  halal: 'Halal',
  kosher_style: 'Kosher-style',
  no_beef: 'No beef',
  no_pork: 'No pork',
  gluten_free: 'Gluten free',
  dairy_free: 'Dairy free',
  keto_friendly: 'Keto friendly',
  paleo: 'Paleo',
  low_fodmap: 'Low FODMAP',
  navratri: 'Navratri fasting',
};

const ALLERGEN_LABELS: Record<string, string> = {
  milk: 'Milk',
  egg: 'Egg',
  fish: 'Fish',
  crustaceans: 'Crustaceans',
  molluscs: 'Molluscs',
  peanuts: 'Peanuts',
  tree_nuts: 'Tree nuts',
  gluten: 'Gluten',
  soy: 'Soy',
  sesame: 'Sesame',
  mustard: 'Mustard',
  celery: 'Celery',
  lupin: 'Lupin',
  sulphites: 'Sulphites',
};

type Draft = Omit<ProfileShape, 'updatedAt'>;

export function Profile() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile });
  const [draft, setDraft] = useState<Draft | null>(null);

  // Seeded once the fetch lands. Re-seeding on every render would throw away
  // edits in progress the moment anything refetched.
  useEffect(() => {
    if (profile.data && !draft) {
      const { updatedAt, ...rest } = profile.data.profile;
      setDraft(rest);
    }
  }, [profile.data, draft]);

  const save = useMutation({
    mutationFn: (next: Draft) => api.saveProfile(next),
    onSuccess: (result) => {
      queryClient.setQueryData(['profile'], result);
      const { updatedAt, ...rest } = result.profile;
      setDraft(rest);
    },
  });

  if (profile.isPending) {
    return (
      <Screen title="Profile">
        <Loading what="your profile" />
      </Screen>
    );
  }

  if (profile.isError || !draft) {
    return (
      <Screen title="Profile">
        <LoadError
          error={profile.error}
          onRetry={() => queryClient.invalidateQueries({ queryKey: ['profile'] })}
        />
      </Screen>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const toggle = <K extends 'diets' | 'allergens'>(key: K, value: string) =>
    setDraft((current) => {
      if (!current) return current;
      const list = current[key] as string[];
      const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
      return { ...current, [key]: next } as Draft;
    });

  const original = profile.data.profile;
  const dropped = original.allergens.filter((a) => !draft.allergens.includes(a));
  const dirty = JSON.stringify({ ...original, updatedAt: '' }) !== JSON.stringify({ ...draft, updatedAt: '' });

  return (
    <Screen title="Profile" lede="What you can eat, and what you would rather not.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft);
        }}
      >
        {/* Allergens first. They are the only section here where being wrong
            is dangerous rather than annoying. */}
        <fieldset className="sober sober-warn mb-6 p-4">
          <legend className="px-1 text-[1.05rem] font-bold">Allergens</legend>
          <p className="mt-1 mb-3 text-[0.9rem]" style={{ color: 'var(--text-muted)' }}>
            Recipes containing these are hidden, and anything we cannot verify is hidden too.
          </p>
          <CheckGrid
            name="allergens"
            options={Allergen.options}
            labels={ALLERGEN_LABELS}
            selected={draft.allergens}
            onToggle={(value) => toggle('allergens', value)}
          />

          {dropped.length > 0 ? (
            <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
              This removes {dropped.map((a) => ALLERGEN_LABELS[a] ?? a).join(' and ')} from your
              allergy list. Recipes containing them will no longer be hidden.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="sober mb-6 p-4">
          <legend className="px-1 text-[1.05rem] font-bold">Diets</legend>
          <p className="mt-1 mb-3 text-[0.9rem]" style={{ color: 'var(--text-muted)' }}>
            Diets combine. A recipe has to satisfy all of them.
          </p>
          <CheckGrid
            name="diets"
            options={Diet.options}
            labels={DIET_LABELS}
            selected={draft.diets}
            onToggle={(value) => toggle('diets', value)}
          />
        </fieldset>

        <fieldset className="sober mb-6 p-4">
          <legend className="px-1 text-[1.05rem] font-bold">Will not eat</legend>
          <p className="mt-1 mb-3 text-[0.9rem]" style={{ color: 'var(--text-muted)' }}>
            Anything else to keep out. Treated as strictly as a diet, not as a preference.
          </p>
          <TagInput
            label="Excluded ingredients"
            placeholder="mushroom"
            values={draft.exclusions}
            onChange={(values) => set('exclusions', values)}
          />
        </fieldset>

        <fieldset className="sober mb-6 p-4">
          <legend className="px-1 text-[1.05rem] font-bold">Cooking</legend>

          <div className="mb-4">
            <TagInput
              label="Cuisines you like"
              placeholder="thai"
              values={draft.cuisines}
              onChange={(values) => set('cuisines', values)}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <NumberField
              id="servings"
              label="Servings"
              value={draft.servings}
              min={1}
              max={20}
              onChange={(value) => set('servings', value)}
            />
            <NumberField
              id="minutes"
              label="Time limit (minutes)"
              value={draft.maxCookMinutes}
              min={5}
              max={600}
              onChange={(value) => set('maxCookMinutes', value)}
            />

            <span>
              <label htmlFor="spice" className="block text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                Spice level
              </label>
              <select
                id="spice"
                className="field w-40"
                value={draft.spiceLevel}
                onChange={(e) => set('spiceLevel', e.target.value as Draft['spiceLevel'])}
              >
                {['none', 'mild', 'medium', 'hot'].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </span>

            <span>
              <label htmlFor="tz" className="block text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                Time zone
              </label>
              <input
                id="tz"
                className="field w-56"
                value={draft.timeZone}
                onChange={(e) => set('timeZone', e.target.value)}
              />
              <span className="mt-1 block text-[0.78rem]" style={{ color: 'var(--text-muted)' }}>
                Used for the 9am and 5pm nudges.
              </span>
            </span>
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {save.isSuccess && !dirty ? (
            <span role="status" style={{ color: 'var(--text-go)' }}>
              Saved
            </span>
          ) : null}
        </div>

        {save.isError ? (
          <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
            {save.error instanceof Error ? save.error.message : 'That did not save. Try again.'}
          </p>
        ) : null}
      </form>

      <DeleteAccount />
    </Screen>
  );
}

/* -------------------------------- controls -------------------------------- */

/**
 * A grid of checkboxes inside a fieldset.
 *
 * Real `<input type="checkbox">` elements rather than styled buttons: they
 * are focusable, toggle with Space, announce their checked state, and group
 * under the legend without any ARIA. A custom control would need all of that
 * rebuilt to end up in the same place.
 */
function CheckGrid({
  name,
  options,
  labels,
  selected,
  onToggle,
}: {
  name: string;
  options: readonly string[];
  labels: Record<string, string>;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1.5">
      {options.map((option) => (
        <label key={option} className="flex cursor-pointer items-center gap-2.5 py-1">
          <input
            type="checkbox"
            name={name}
            value={option}
            checked={selected.includes(option)}
            onChange={() => onToggle(option)}
            className="h-[1.15rem] w-[1.15rem] accent-[var(--color-marigold)]"
          />
          <span>{labels[option] ?? option}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Free-text tags: custom exclusions and cuisines.
 *
 * Enter adds, Backspace on an empty box removes the last one, and each tag
 * carries its own remove button so the list is navigable without knowing
 * that shortcut.
 */
function TagInput({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `tags-${label.replace(/\s+/g, '-').toLowerCase()}`;

  const add = () => {
    const value = text.trim().toLowerCase();
    if (!value || values.includes(value)) {
      setText('');
      return;
    }
    onChange([...values, value]);
    setText('');
  };

  return (
    <div>
      <label htmlFor={id} className="block text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>

      <ul className="mb-2 mt-1.5 flex flex-wrap gap-2 p-0 list-none">
        {values.map((value) => (
          <li key={value}>
            <span className="chip" style={{ color: 'var(--text-primary)' }}>
              {value}
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="ml-0.5 leading-none"
                style={{ fontSize: '1.1em' }}
              >
                <span aria-hidden="true">×</span>
                <span className="sr-only">Remove {value}</span>
              </button>
            </span>
          </li>
        ))}
        {values.length === 0 ? (
          <li className="text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
            None yet
          </li>
        ) : null}
      </ul>

      <div className="flex gap-2">
        <input
          id={id}
          ref={inputRef}
          className="field"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // This input sits inside the profile form; Enter here must add
              // a tag, not submit the whole thing.
              e.preventDefault();
              add();
            }
            if (e.key === 'Backspace' && text === '' && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
        />
        <button type="button" className="btn shrink-0" onClick={add} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <span>
      <label htmlFor={id} className="block text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="field w-28"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </span>
  );
}

/* ----------------------------- delete account ----------------------------- */

/**
 * Section 11's `DELETE /api/me`.
 *
 * Typing the word is the confirmation rather than a dialog with a red
 * button: this deletes a pantry, a profile and a chat history with no undo,
 * and a second click is not a decision. The copy is plain for the same
 * reason as the rest of this screen — data loss is on section 10's exempt
 * list.
 */
function DeleteAccount() {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');

  const remove = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: () => navigate('/'),
  });

  return (
    <section className="sober sober-warn mt-10 p-4">
      <h2 className="text-[1.05rem]">Delete your account</h2>
      <p className="mt-2 text-[0.9rem]">
        This removes your pantry, profile, chat history and uploads. It cannot be undone.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <span>
          <label htmlFor="confirm-delete" className="block text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
            Type DELETE to confirm
          </label>
          <input
            id="confirm-delete"
            className="field w-44"
            value={confirm}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </span>
        <button
          type="button"
          className="btn btn-danger"
          disabled={confirm !== 'DELETE' || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? 'Deleting…' : 'Delete account'}
        </button>
      </div>

      {remove.isError ? (
        <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
          {remove.error instanceof Error ? remove.error.message : 'That did not work. Try again.'}
        </p>
      ) : null}
    </section>
  );
}
