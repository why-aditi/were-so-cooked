import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import './index.css';
import { RequireSession } from './lib/session';
import { Chat } from './routes/Chat';
import { Grocery } from './routes/Grocery';
import { Inbox } from './routes/Inbox';
import { Landing } from './routes/Landing';
import { More } from './routes/More';
import { Pantry } from './routes/Pantry';
import { Plan } from './routes/Plan';
import { Profile } from './routes/Profile';
import { Status } from './routes/Status';
import { Trending } from './routes/Trending';

/**
 * Routes from section 10's table.
 *
 * Everything under /app needs a session before it renders: the agent socket
 * is named after the user ID (section 9), so `RequireSession` wraps the
 * shell rather than each screen.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A pantry does not change behind your back often enough to justify
      // refetching every time a phone comes back to the foreground.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />

          <Route
            path="/app"
            element={
              <RequireSession>
                <AppShell />
              </RequireSession>
            }
          >
            <Route index element={<Chat />} />
            <Route path="pantry" element={<Pantry />} />
            <Route path="plan" element={<Plan />} />
            <Route path="grocery" element={<Grocery />} />
            <Route path="trending" element={<Trending />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="profile" element={<Profile />} />
            <Route path="more" element={<More />} />
          </Route>

          <Route
            path="/status"
            element={
              <RequireSession>
                <Status />
              </RequireSession>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
