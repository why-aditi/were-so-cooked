import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Screen } from '../components/Screen';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';

/**
 * The fifth tab.
 *
 * Section 10's bottom bar is Chat, Pantry, Plan, Grocery, More — so the
 * screens that do not get a tab of their own live behind this one. It is a
 * list of destinations rather than a settings page, which keeps the tab bar
 * to five without hiding anything.
 */

const LINKS = [
  { to: '/app/inbox', label: 'inbox', hint: 'nudges and notices' },
  { to: '/app/trending', label: 'trending', hint: 'what the internet is cooking' },
  { to: '/app/profile', label: 'profile', hint: 'diets, allergens, exclusions' },
  { to: '/status', label: 'pipeline status', hint: 'recent viral-recipe runs' },
];

export function More() {
  const { user } = useSession();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  const logout = useMutation({
    mutationFn: api.logout,
    // Full reload rather than a client navigation: it drops every cached
    // query, so the next person at this browser does not see the last one's
    // pantry flash up before the redirect.
    onSuccess: () => {
      window.location.href = '/';
    },
    onError: () => navigate('/'),
  });

  return (
    <Screen title="more" lede={user.isDemo ? 'you are on a demo account' : `signed in as ${user.login}`}>
      <ul className="space-y-2 p-0 list-none">
        {LINKS.map((link) => (
          <li key={link.to}>
            <Link
              to={link.to}
              className="sticker flex items-baseline justify-between p-3.5"
              style={{ ['--tilt' as string]: '0deg' }}
            >
              <span className="font-semibold">{link.label}</span>
              <span className="text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                {link.hint}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={toggle}>
          {theme === 'dark' ? '☀️ light theme' : '🌙 dark theme'}
        </button>
        <button type="button" className="btn" onClick={() => logout.mutate()} disabled={logout.isPending}>
          sign out
        </button>
      </div>

      {user.isDemo ? (
        // Data loss, so it is plain and sentence case.
        <p className="mt-6 text-[0.88rem]" style={{ color: 'var(--text-muted)' }}>
          Demo accounts and everything in them are deleted 24 hours after they are created.
        </p>
      ) : null}
    </Screen>
  );
}
