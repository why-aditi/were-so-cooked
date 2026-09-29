import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Section 10's budget meter, on the chat screen.
 *
 * Section 12 gives each user a daily neuron cap, and section 8 drops chat to
 * a cheaper model below 20% — so this is not a vanity number, it is the
 * warning that answers "why did it get worse". Below 20% it says so in
 * words, because a bar changing colour is not information anyone can act on.
 *
 * `neuronsLeftToday` also arrives on the agent's synced state, but that only
 * updates when a turn finishes; this polls so an idle tab is not stale.
 */
export function BudgetMeter() {
  const { data, isError } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isError || !data) return null;

  const { used, limit } = data.user;
  const fraction = limit > 0 ? Math.min(1, used / limit) : 0;
  const percentLeft = Math.round((1 - fraction) * 100);
  const lowPower = percentLeft < 20;
  const resetTime = new Date(data.resetsAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="flex items-center gap-2.5 text-[0.8rem]">
      <div
        role="meter"
        aria-valuenow={percentLeft}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Daily AI budget: ${percentLeft} percent left, resets at ${resetTime}`}
        className="relative h-2.5 w-24 overflow-hidden rounded-full border-2"
        style={{ borderColor: 'var(--text-primary)', background: 'var(--surface-page)' }}
      >
        <div
          className="h-full"
          style={{
            width: `${percentLeft}%`,
            background: lowPower ? 'var(--color-chilli)' : 'var(--color-mint)',
          }}
        />
      </div>

      {/* Colour alone would fail AA and would fail anyone not looking for it. */}
      <span style={{ color: lowPower ? 'var(--text-warn)' : 'var(--text-muted)' }}>
        {lowPower ? `low-power mode · back at ${resetTime}` : `${percentLeft}% left today`}
      </span>
    </div>
  );
}
