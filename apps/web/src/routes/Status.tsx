import { useQuery } from '@tanstack/react-query';
import { Empty, LoadError, Loading, Screen } from '../components/Screen';
import { api } from '../lib/api';

/**
 * Section 10: "Last 10 viral-recipe runs with counts, duration, neurons and
 * errors." Signed in only, and section 11 notes it reads D1 directly with no
 * agent involved.
 *
 * This is an operator's screen, so the voice drops: someone reading it is
 * trying to work out why Sunday's pipeline added four recipes instead of
 * thirty, and a joke between them and the error list does not help.
 */

function duration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running';
  const seconds = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STATUS_COLOUR: Record<string, string> = {
  ok: 'var(--text-go)',
  failed: 'var(--text-warn)',
  running: 'var(--text-work)',
};

export function Status() {
  const pipeline = useQuery({
    queryKey: ['pipeline'],
    queryFn: api.pipeline,
    refetchInterval: 30_000,
  });

  const runs = pipeline.data?.runs ?? [];

  return (
    <Screen title="Pipeline status" lede="The last 10 viral-recipe runs.">
      {pipeline.isPending ? <Loading what="recent runs" /> : null}
      {pipeline.isError ? <LoadError error={pipeline.error} onRetry={() => pipeline.refetch()} /> : null}

      {pipeline.isSuccess && runs.length === 0 ? (
        <Empty line="No runs recorded yet. The viral pipeline runs weekly." />
      ) : null}

      {runs.length > 0 ? (
        // A real table: this is tabular data, and a grid of divs would lose
        // the row and column relationships a screen reader uses to navigate.
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.9rem]">
            <caption className="sr-only">
              Recent viral-recipe pipeline runs, newest first
            </caption>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--text-primary)' }}>
                <th scope="col" className="py-2 pr-3 text-left">Started</th>
                <th scope="col" className="py-2 pr-3 text-left">Status</th>
                <th scope="col" className="py-2 pr-3 text-right">Found</th>
                <th scope="col" className="py-2 pr-3 text-right">Added</th>
                <th scope="col" className="py-2 pr-3 text-right">Dupes</th>
                <th scope="col" className="py-2 pr-3 text-right">Neurons</th>
                <th scope="col" className="py-2 text-right">Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <time dateTime={run.startedAt}>
                      {new Date(run.startedAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </td>
                  <td className="py-2 pr-3" style={{ color: STATUS_COLOUR[run.status] }}>
                    {run.status}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{run.found}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{run.added}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{run.duplicates}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{Math.round(run.neurons)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {duration(run.startedAt, run.finishedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {runs.some((run) => run.errors.length > 0) ? (
        <section className="mt-8">
          <h2 className="text-[1.1rem]">Errors</h2>
          {runs
            .filter((run) => run.errors.length > 0)
            .map((run) => (
              <div key={run.id} className="mt-3">
                <p className="m-0 text-[0.85rem]" style={{ color: 'var(--text-muted)' }}>
                  <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                </p>
                <ul className="mt-1 space-y-1 text-[0.9rem]">
                  {run.errors.map((error, index) => (
                    <li key={index} style={{ color: 'var(--text-warn)' }}>
                      {error}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ) : null}
    </Screen>
  );
}
