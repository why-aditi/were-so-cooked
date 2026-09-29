import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "7-day grid, regenerate one day, open recipe, plan status
 * while generating."
 *
 * `WeeklyPlanWorkflow` is not built, so the grid renders from a real (empty)
 * plan rather than a fabricated week. The generating and ready states below
 * are the ones section 10 names, wired to the real status field — when the
 * Workflow lands it writes the row and this screen already knows what to do
 * with it.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'sweet treat'];

interface Slot {
  recipeId: string | null;
  title: string | null;
}

export function Plan() {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ['plan'], queryFn: api.currentPlan, refetchInterval: (query) =>
    // Poll only while a Workflow is actually running.
    (query.state.data?.plan?.status === 'generating' ? 3_000 : false) });

  const start = useMutation({ mutationFn: api.startPlan, onSuccess: () => refresh() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plan'] });

  if (plan.isPending) {
    return (
      <Screen title="this week">
        <Loading what="your plan" />
      </Screen>
    );
  }

  if (plan.isError) {
    return (
      <Screen title="this week">
        <LoadError error={plan.error} onRetry={refresh} />
      </Screen>
    );
  }

  const current = plan.data?.plan ?? null;

  if (!current) {
    return (
      <Screen title="this week" lede="no plan yet">
        <Empty line="nothing planned. the week is wide open and slightly menacing 👀">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => start.mutate()}
            disabled={start.isPending}
          >
            {start.isPending ? 'starting…' : 'plan my week'}
          </button>
          {start.isError ? (
            <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
              {start.error instanceof Error ? start.error.message : 'That did not start.'}
            </p>
          ) : null}
        </Empty>
      </Screen>
    );
  }

  const generating = current.status === 'generating';
  const grid = (current.plan ?? {}) as Record<string, Record<string, Slot>>;

  return (
    <Screen
      title="this week"
      lede={generating ? 'letting him cook…' : "the week is planned. you're not cooked. dinner is. 🍳"}
      action={
        <button type="button" className="btn" onClick={() => start.mutate()} disabled={generating}>
          start again
        </button>
      }
    >
      {generating ? (
        <p aria-live="polite" className="mb-4" style={{ color: 'var(--text-work)' }}>
          working through the week…
        </p>
      ) : null}

      <div className="space-y-3">
        {DAYS.map((day) => (
          <section key={day} className="sticker p-3" style={{ ['--tilt' as string]: '0deg' }}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-[1.05rem]">{day}</h2>
              <button type="button" className="btn" disabled={generating}>
                redo<span className="sr-only"> {day}</span>
              </button>
            </div>

            <ul className="mt-2 grid gap-1.5 p-0 list-none sm:grid-cols-2">
              {SLOTS.map((slot) => {
                const filled = grid[day]?.[slot];
                return (
                  <li key={slot} className="flex gap-2 text-[0.92rem]">
                    <span className="w-24 shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {slot}
                    </span>
                    <span>{filled?.title ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Screen>
  );
}
