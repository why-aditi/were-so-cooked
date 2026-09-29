/**
 * "Daily, 09:00 in the user's time zone" (section 5), on a runtime whose
 * alarms are UTC.
 *
 * A fixed UTC cron would be one line and wrong twice a year: 09:00 in
 * Europe/London is 09:00 UTC in January and 08:00 UTC in July. Half the
 * target users are in Asia/Kolkata, which has no DST and would never surface
 * the bug — which is exactly the kind of bug that ships.
 *
 * Hourly wakes with a "is it 9am there yet" check would also be correct, at
 * 24 alarms per user per day. So instead each job schedules one alarm for its
 * next occurrence and re-arms itself when it runs: one alarm per job per day,
 * and the next one is recomputed after the clocks change rather than before.
 */

/** Minutes that `timeZone` is ahead of UTC at `instant`. */
export function offsetMinutes(timeZone: string, instant: Date): number {
  // `en-US` with an explicit numeric format so the parts are stable across
  // ICU versions; reading the formatted parts is the only way to ask a
  // browser-standard runtime "what is the wall clock there right now".
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Hour 24 appears at midnight in some ICU builds under hour12:false.
  const hour = get('hour') % 24;

  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  // Round to the minute: the two clocks can straddle a second boundary.
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The next instant at which the wall clock in `timeZone` reads `hour`:00.
 *
 * Computed by guessing from the current offset and then correcting once with
 * the offset that actually applies at the guessed instant. One correction is
 * enough: a DST shift moves the answer by an hour, not by a day, and the
 * corrected guess is re-derived from the target's own offset.
 */
export function nextLocalHour(
  timeZone: string,
  hour: number,
  now: Date = new Date(),
): Date {
  const guess = (offset: number): number => {
    // Wall-clock "now" in the zone, as if it were UTC.
    const localNow = now.getTime() + offset * 60_000;
    const day = new Date(localNow);
    const target = Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hour,
      0,
      0,
      0,
    );
    // Strictly in the future, so a job running at exactly 09:00 re-arms for
    // tomorrow rather than immediately re-firing.
    const wall = target > localNow ? target : target + 86_400_000;
    return wall - offset * 60_000;
  };

  const first = guess(safeOffset(timeZone, now));
  // Re-derive using the offset in force at the guessed moment, which is what
  // makes the spring-forward and fall-back days come out right.
  return new Date(guess(safeOffset(timeZone, new Date(first))));
}

/**
 * An unknown or malformed zone must not stop the nudges entirely, and must
 * not throw inside an alarm handler where the failure is invisible. UTC is
 * the honest fallback: the user gets the nudge at the wrong hour rather than
 * never.
 */
function safeOffset(timeZone: string, at: Date): number {
  try {
    return offsetMinutes(timeZone, at);
  } catch {
    return 0;
  }
}
