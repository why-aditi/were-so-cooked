import { useAgent } from 'agents/react';
import { NavLink, Outlet } from 'react-router-dom';
import { EMPTY_STATE, type SyncedState } from '../lib/api';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { useState } from 'react';

/**
 * The app shell (section 10).
 *
 * "On phones the nav is a bottom tab bar (Chat, Pantry, Plan, Grocery,
 * More)." On wider screens the same five become a left rail, so there is one
 * list of destinations rather than two that can drift apart.
 *
 * The badges come from the agent's synced state, which section 5 pushes to
 * every open tab — so the inbox count is right without the shell polling
 * anything.
 */

interface Tab {
  to: string;
  label: string;
  icon: string;
  badge?: (state: SyncedState) => number;
}

const TABS: Tab[] = [
  { to: '/app', label: 'Chat', icon: '💬' },
  { to: '/app/pantry', label: 'Pantry', icon: '🧊', badge: (s) => s.expiringSoonCount },
  { to: '/app/plan', label: 'Plan', icon: '🗓' },
  { to: '/app/grocery', label: 'Grocery', icon: '🧾' },
  { to: '/app/more', label: 'More', icon: '⋯', badge: (s) => s.unreadInbox },
];

export function AppShell() {
  const { user } = useSession();
  const { theme, toggle } = useTheme();
  const [state, setState] = useState<SyncedState>(EMPTY_STATE);

  // The same socket the chat screen uses; the SDK shares one connection per
  // agent name, so this does not open a second.
  useAgent<SyncedState>({
    agent: 'kitchen-agent',
    name: user.id,
    onStateUpdate: (next) => setState(next ?? EMPTY_STATE),
  });

  return (
    // Exactly one screen tall: the page itself never scrolls. Each screen
    // scrolls inside <main>, and the chat inside its own thread, so the
    // composer and the rail stay put.
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Left rail from md up. `aria-label` distinguishes it from the bottom
          bar for anyone listing landmarks. */}
      <nav
        aria-label="Sections"
        className="hidden md:flex md:w-56 md:shrink-0 md:flex-col md:gap-1 md:overflow-y-auto md:border-r-2 md:p-3"
        style={{ borderColor: 'var(--line)' }}
      >
        <p className="mb-4 px-2 font-[family-name:var(--font-display)] text-[1.15rem] font-extrabold leading-none">
          we're so
          <br />
          cooked
        </p>
        {TABS.map((tab) => (
          <RailLink key={tab.to} tab={tab} state={state} />
        ))}

        <div className="mt-auto px-2">
          <button type="button" className="btn w-full" onClick={toggle}>
            {theme === 'dark' ? '☀️ light' : '🌙 dark'}
          </button>
        </div>
      </nav>

      <main
        id="main"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        // Clears the bottom bar on phones; the rail takes over from md up.
        style={{ paddingBottom: 'var(--tabbar-space, 0)' }}
      >
        <Outlet context={state} />
      </main>

      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t-2 md:hidden"
        style={{
          borderColor: 'var(--text-primary)',
          background: 'var(--surface-raised)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {TABS.map((tab) => (
          <TabLink key={tab.to} tab={tab} state={state} />
        ))}
      </nav>
    </div>
  );
}

function badgeFor(tab: Tab, state: SyncedState): number {
  return tab.badge ? tab.badge(state) : 0;
}

function RailLink({ tab, state }: { tab: Tab; state: SyncedState }) {
  const count = badgeFor(tab, state);
  return (
    <NavLink
      to={tab.to}
      end={tab.to === '/app'}
      className="flex items-center gap-2.5 rounded-xl px-2 py-2 font-semibold"
      style={({ isActive }) => ({
        background: isActive ? 'var(--surface-high)' : 'transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
      })}
    >
      <span aria-hidden="true">{tab.icon}</span>
      {tab.label}
      {count > 0 ? <Badge count={count} label={tab.label} /> : null}
    </NavLink>
  );
}

function TabLink({ tab, state }: { tab: Tab; state: SyncedState }) {
  const count = badgeFor(tab, state);
  return (
    <NavLink
      to={tab.to}
      end={tab.to === '/app'}
      className="relative flex flex-col items-center gap-0.5 py-2 text-[0.7rem] font-semibold"
      style={({ isActive }) => ({
        color: isActive ? 'var(--text-act)' : 'var(--text-muted)',
      })}
    >
      {({ isActive }) => (
        <>
          <span aria-hidden="true" className="text-[1.15rem] leading-none">
            {tab.icon}
          </span>
          {tab.label}
          {count > 0 ? <Badge count={count} label={tab.label} floating /> : null}
          {/* A bar, not just colour: 44px targets and a shape anyone can see. */}
          {isActive ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-4 top-0 h-[3px]"
              style={{ background: 'var(--color-marigold)' }}
            />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function Badge({ count, label, floating }: { count: number; label: string; floating?: boolean }) {
  return (
    <span
      className={`chip ${floating ? 'absolute right-[18%] top-1' : 'ml-auto'}`}
      style={{
        background: 'var(--color-chilli)',
        color: 'var(--color-ink)',
        borderColor: 'var(--color-ink)',
        padding: '0 0.35rem',
        fontSize: '0.68rem',
      }}
    >
      {count}
      <span className="sr-only"> needing attention in {label}</span>
    </span>
  );
}
