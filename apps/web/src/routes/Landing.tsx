import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';

/**
 * The landing page (section 10): "Tagline, GitHub sign-in, 'try the demo',
 * 3 feature teasers."
 *
 * The hero is the product's actual subject rather than a description of it:
 * a fridge shelf where things are visibly running out of time. The expiry
 * panic is what this app is for, so it is the first thing on the page.
 */

const SHELF = [
  { name: 'palak', qty: '1 bunch', days: 0, tilt: '-2.1deg' },
  { name: 'paneer', qty: '400g', days: 2, tilt: '1.4deg' },
  { name: 'dahi', qty: '500ml', days: 4, tilt: '-0.8deg' },
  { name: 'atta', qty: '5kg', days: 180, tilt: '2.2deg' },
];

const TEASERS = [
  {
    title: 'it remembers the dhaniya',
    body: 'type what you bought, however you type it. "2 pyaaz", "1.5kg aloo", "a bunch of dhaniya" — it works out the rest.',
  },
  {
    title: 'it reads your receipts',
    body: 'photograph the shopping or the open fridge. tick what it got right, bin what it did not.',
  },
  {
    title: 'it will not poison you',
    body: 'every suggestion is checked against your allergies and diets before you see it. anything it cannot verify, it hides and says so.',
  },
];

export function Landing() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();

  const demo = useMutation({
    mutationFn: api.startDemo,
    onSuccess: () => navigate('/app'),
  });

  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <header className="mx-auto flex max-w-[68rem] items-center justify-between px-5 py-4">
        <span className="font-[family-name:var(--font-display)] text-[1.1rem] font-extrabold">
          we're so cooked
        </span>
        <button type="button" className="btn" onClick={toggle}>
          {theme === 'dark' ? '☀️ light' : '🌙 dark'}
        </button>
      </header>

      <main id="main" className="mx-auto max-w-[68rem] px-5 pb-20">
        <section className="grid items-center gap-10 py-8 md:grid-cols-[1.1fr_0.9fr] md:py-16">
          <div>
            <h1 className="text-[clamp(2.75rem,9vw,5.25rem)]">
              your fridge is
              <br />
              keeping secrets
            </h1>

            <p className="mt-5 text-[1.1rem]" style={{ color: 'var(--text-muted)' }}>
              tell it what you bought. it works out what is about to go off, what you can cook
              tonight, and what to buy on Sunday. it never suggests anything you cannot eat.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <a className="btn btn-primary" href="/auth/github">
                sign in with GitHub
              </a>
              <button
                type="button"
                className="btn"
                onClick={() => demo.mutate()}
                disabled={demo.isPending}
              >
                {demo.isPending ? 'setting up…' : 'try the demo'}
              </button>
            </div>

            {demo.isError ? (
              // Plain: a failure explains itself and does not do a bit.
              <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
                {demo.error instanceof Error
                  ? demo.error.message
                  : 'Could not start the demo. Try again.'}
              </p>
            ) : null}

            <p className="mt-3 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
              the demo is a real account with a pantry already in it. it deletes itself after a day.
            </p>
          </div>

          {/* The shelf. Not a screenshot and not a gradient — the thing the
              product is about, rendered in the product's own card language. */}
          <div aria-hidden="true" className="relative mx-auto w-full max-w-[22rem] md:mx-0">
            {SHELF.map((item) => {
              const urgent = item.days <= 2;
              return (
                <div
                  key={item.name}
                  className="sticker mb-3 flex items-baseline justify-between p-3.5"
                  style={{ ['--tilt' as string]: item.tilt }}
                >
                  <span className="font-[family-name:var(--font-display)] text-[1.35rem] font-extrabold">
                    {item.name}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span style={{ color: 'var(--text-muted)' }}>{item.qty}</span>
                    <span
                      className="chip"
                      style={{ color: urgent ? 'var(--text-warn)' : 'var(--text-go)' }}
                    >
                      {item.days === 0
                        ? 'today'
                        : item.days <= 7
                          ? `${item.days}d`
                          : `${Math.round(item.days / 30)}mo`}
                    </span>
                  </span>
                </div>
              );
            })}
            <p className="mt-4 text-center text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
              🚨 the palak is giving <em>last seen 3 days ago</em>
            </p>
          </div>
        </section>

        <section className="grid gap-4 border-t-2 pt-10 md:grid-cols-3" style={{ borderColor: 'var(--line)' }}>
          {TEASERS.map((teaser) => (
            <div key={teaser.title}>
              <h2 className="text-[1.3rem]">{teaser.title}</h2>
              <p className="mt-2 text-[0.95rem]" style={{ color: 'var(--text-muted)' }}>
                {teaser.body}
              </p>
            </div>
          ))}
        </section>

        {/* The disclaimer section 10 specifies, verbatim and unadorned. */}
        <p className="mt-12 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
          Always check labels. If you have a severe allergy, verify every ingredient yourself.
        </p>
      </main>
    </div>
  );
}
