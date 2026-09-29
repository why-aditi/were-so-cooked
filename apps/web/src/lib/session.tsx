import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api, type Me } from './api';

/**
 * Who is signed in.
 *
 * The agent socket is named after the user ID (section 9), so nothing under
 * /app can render before the session resolves — `useAgent` would otherwise
 * open a connection to an agent named `undefined`.
 */

const SessionContext = createContext<Me['user'] | null>(null);

export function useSession(): { user: Me['user'] } {
  const user = useContext(SessionContext);
  if (!user) throw new Error('useSession outside a signed-in route');
  return { user };
}

export function useMaybeSession() {
  return useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { data, isPending, isError } = useMaybeSession();

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <p aria-live="polite" style={{ color: 'var(--text-muted)' }}>
          finding your kitchen…
        </p>
      </div>
    );
  }

  if (isError || !data) return <Navigate to="/" replace />;

  return <SessionContext.Provider value={data.user}>{children}</SessionContext.Provider>;
}
