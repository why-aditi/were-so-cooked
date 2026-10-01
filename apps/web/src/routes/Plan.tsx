import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api, type PlanMealView, type PlanSlot, type PlanView } from '../lib/api';

/**
 * Section 10: "7-day grid, regenerate one day, open recipe, plan status
 * while generating."
 *
 * Renders the plan `WeeklyPlanWorkflow` wrote, polling only while it is
 * still being built. A slot nothing safe could fill shows as open rather
 * than being hidden, so a short week never passes for a whole one.
 *
 * ponytail: "regenerate one day" waits on
 * `POST /api/plans/:id/days/:day/regenerate`, which is not built; "start
 * again" replans the whole week in the meantime.
 */

const SLOT_LABEL: Record<PlanSlot, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  treat: 'sweet treat',
};

/** "mon 6 oct", read in UTC because plan days are calendar dates, not instants. */
function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${weekday} ${day}`.toLowerCase();
}

export function Plan() {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ['plan'],
    queryFn: api.currentPlan,
    // Poll only while a Workflow is actually running.
    refetchInterval: (query) => (query.state.data?.plan?.status === 'running' ? 3_000 : false),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plan'] });
  const start = useMutation({
    mutationFn: api.startPlan,
    onSuccess: () => {
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['grocery'] });
    },
  });

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
  const startError = start.isError ? (
    <p role="alert" className="mt-3 text-[0.9rem]" style={{ color: 'var(--text-warn)' }}>
      {start.error instanceof Error ? start.error.message : 'That did not start.'}
    </p>
  ) : null;

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
          {startError}
        </Empty>
      </Screen>
    );
  }

  const generating = current.status === 'running';

  return (
    <Screen
      title="this week"
      lede={lede(current)}
      action={
        <button
          type="button"
          className="btn"
          onClick={() => start.mutate()}
          disabled={generating || start.isPending}
        >
          start again
        </button>
      }
    >
      {startError}

      {generating ? (
        <p aria-live="polite" className="mb-4" style={{ color: 'var(--text-work)' }}>
          working through the week…
        </p>
      ) : null}

      {current.status === 'failed' ? (
        <p role="alert" className="mb-4" style={{ color: 'var(--text-warn)' }}>
          That plan did not come together. Start again to retry.
        </p>
      ) : null}

      {current.status === 'ready' && current.unfilled.length > 0 ? (
        <p className="mb-4 text-[0.92rem]" style={{ color: 'var(--text-muted)' }}>
          {current.unfilled.length} {current.unfilled.length === 1 ? 'slot has' : 'slots have'}{' '}
          nothing that fits your profile yet, so{' '}
          {current.unfilled.length === 1 ? 'it is' : 'they are'} left open.
          {current.catalogOnly
            ? ' The AI budget was used up, so this week came from saved recipes only.'
            : ''}
        </p>
      ) : null}

      <div className="space-y-3">
        {current.days.map((day) => (
          <section key={day.date} className="sticker p-3" style={{ ['--tilt' as string]: '0deg' }}>
            <h2 className="text-[1.05rem]">{dayLabel(day.date)}</h2>

            <ul className="mt-2 grid gap-1.5 p-0 list-none sm:grid-cols-2">
              {current.slots.map((slot) => (
                <li key={slot} className="flex gap-2 text-[0.92rem]">
                  <span className="w-24 shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {SLOT_LABEL[slot]}
                  </span>
                  <MealLine meal={day.meals.find((m) => m.slot === slot)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Screen>
  );
}

function lede(plan: PlanView): string {
  if (plan.status === 'running') return 'letting him cook…';
  if (plan.status === 'failed') return 'that one did not cook';
  return "the week is planned. you're not cooked. dinner is. 🍳";
}

function MealLine({ meal }: { meal: PlanMealView | undefined }) {
  if (!meal) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <span>
      {meal.title}
      <span style={{ color: 'var(--text-muted)' }}> · {meal.minutes} min</span>
      {meal.swaps.length > 0 ? (
        <span style={{ color: 'var(--text-muted)' }}>
          {' '}
          · {meal.swaps.length} {meal.swaps.length === 1 ? 'swap' : 'swaps'}
        </span>
      ) : null}
    </span>
  );
}
