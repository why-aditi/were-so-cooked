import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Disclaimer, Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "Viral recipe cards with thumbnail, creator credit, 'make it
 * fit my diet' button."
 *
 * The filter is section 11's `?fits=me`, which "keeps only ones that pass or
 * can be substituted" — so with it on, a card that appears has already been
 * through the safety engine against this user's profile. The button is only
 * offered where `needsSubstitution` says a swap is actually required.
 *
 * `ViralRecipesWorkflow` is not built, so nothing has a `trending_until` yet
 * and the list is empty. The screen says that plainly instead of spinning.
 */
export function Trending() {
  const [fitsMe, setFitsMe] = useState(true);
  const trending = useQuery({
    queryKey: ['trending', fitsMe],
    queryFn: () => api.trending(fitsMe),
  });

  const recipes = trending.data?.recipes ?? [];

  return (
    <Screen
      title="trending"
      lede="what the internet is cooking this week"
      action={
        <label className="flex cursor-pointer items-center gap-2 text-[0.9rem]">
          <input
            type="checkbox"
            checked={fitsMe}
            onChange={(e) => setFitsMe(e.target.checked)}
            className="h-[1.1rem] w-[1.1rem] accent-[var(--color-marigold)]"
          />
          only what i can eat
        </label>
      }
    >
      {trending.isPending ? <Loading what="this week's chaos" /> : null}
      {trending.isError ? <LoadError error={trending.error} onRetry={() => trending.refetch()} /> : null}

      {trending.isSuccess && recipes.length === 0 ? (
        <Empty
          line={
            fitsMe
              ? 'nothing trending fits your profile right now 🍳'
              : 'nothing trending yet. the pipeline runs on Sundays.'
          }
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {recipes.map(({ recipe, needsSubstitution }) => (
          <article
            key={recipe.id}
            className="sticker overflow-hidden"
            style={{ ['--tilt' as string]: '0deg' }}
          >
            {recipe.thumbnailUrl ? (
              <img
                src={recipe.thumbnailUrl}
                // The title is right below, so the image adds nothing a
                // screen reader needs. Empty alt hides it rather than
                // reading the dish name twice.
                alt=""
                loading="lazy"
                className="aspect-video w-full object-cover"
                style={{ borderBottom: '2px solid var(--text-primary)' }}
              />
            ) : null}

            <div className="p-3.5">
              <h2 className="text-[1.15rem]">{recipe.title}</h2>

              <p className="mt-1 mb-0 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                {recipe.creator ? `by ${recipe.creator}` : 'creator unknown'} · {recipe.minutes} min
              </p>

              {needsSubstitution ? (
                <p className="mt-2 mb-0 text-[0.88rem]">
                  <span className="chip" style={{ color: 'var(--text-act)' }}>
                    needs a swap
                  </span>
                </p>
              ) : (
                <p className="mt-2 mb-0 text-[0.88rem]">
                  <span className="chip" style={{ color: 'var(--text-go)' }}>
                    fits as written
                  </span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {needsSubstitution ? (
                  <button type="button" className="btn btn-primary">
                    make it fit my diet
                  </button>
                ) : null}
                {recipe.sourceUrl ? (
                  <a
                    className="btn"
                    href={recipe.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    watch
                    <span className="sr-only"> {recipe.title} (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>

      {recipes.length > 0 ? <Disclaimer /> : null}
    </Screen>
  );
}
