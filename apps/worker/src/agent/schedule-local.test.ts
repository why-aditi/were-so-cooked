import { describe, expect, it } from 'vitest';
import { nextLocalHour, offsetMinutes } from './schedule-local.js';

/**
 * Section 5's "daily, 09:00 in the user's time zone", on a UTC runtime.
 *
 * The bug this file exists to prevent is seasonal: a fixed UTC cron is right
 * in January and an hour out in July, and the two zones most of these users
 * are in — Asia/Kolkata and UTC — have no DST, so it would never show up in
 * testing.
 */

const KOLKATA = 'Asia/Kolkata';
const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

/** The wall clock in a zone, as an ISO-ish string, for readable assertions. */
function wallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

/* -------------------------------- offsets --------------------------------- */

describe('zone offsets', () => {
  it('handles a half-hour zone', () => {
    // India is +05:30. A whole-hours assumption breaks here first.
    expect(offsetMinutes(KOLKATA, new Date('2026-06-15T00:00:00Z'))).toBe(330);
  });

  it('is zero for UTC', () => {
    expect(offsetMinutes('UTC', new Date('2026-06-15T00:00:00Z'))).toBe(0);
  });

  it('moves with British summer time', () => {
    expect(offsetMinutes(LONDON, new Date('2026-01-15T12:00:00Z'))).toBe(0);
    expect(offsetMinutes(LONDON, new Date('2026-07-15T12:00:00Z'))).toBe(60);
  });

  it('is negative west of Greenwich', () => {
    expect(offsetMinutes(NEW_YORK, new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(offsetMinutes(NEW_YORK, new Date('2026-07-15T12:00:00Z'))).toBe(-240);
  });
});

/* ------------------------------ next occurrence ---------------------------- */

describe('the next 09:00 local', () => {
  it('lands on 09:00 wall clock in a half-hour zone', () => {
    const next = nextLocalHour(KOLKATA, 9, new Date('2026-06-15T01:00:00Z'));
    expect(wallClock(next, KOLKATA)).toBe('15/06/2026, 09:00');
  });

  it('rolls to tomorrow when the hour has already passed', () => {
    // 10:00 IST on the 15th, so the next 09:00 is the 16th.
    const next = nextLocalHour(KOLKATA, 9, new Date('2026-06-15T04:30:00Z'));
    expect(wallClock(next, KOLKATA)).toBe('16/06/2026, 09:00');
  });

  it('rolls forward rather than firing again at exactly the hour', () => {
    // A job running at 09:00 re-arms for tomorrow. Without the strict
    // comparison it would schedule itself for the instant it is already at
    // and spin.
    const atNine = new Date('2026-06-15T03:30:00Z'); // 09:00 IST
    expect(wallClock(atNine, KOLKATA)).toBe('15/06/2026, 09:00');
    const next = nextLocalHour(KOLKATA, 9, atNine);
    expect(wallClock(next, KOLKATA)).toBe('16/06/2026, 09:00');
  });

  it('is always in the future', () => {
    for (const zone of [KOLKATA, LONDON, NEW_YORK, 'UTC', 'Australia/Eucla']) {
      for (const hour of [0, 9, 17, 23]) {
        const now = new Date('2026-06-15T12:34:56Z');
        expect(nextLocalHour(zone, hour, now).getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it('stays on 09:00 wall clock across a spring-forward', () => {
    // BST begins 2026-03-29. The UTC instant must shift by an hour so the
    // wall clock does not.
    const before = nextLocalHour(LONDON, 9, new Date('2026-03-27T10:00:00Z'));
    const after = nextLocalHour(LONDON, 9, new Date('2026-03-30T10:00:00Z'));
    expect(wallClock(before, LONDON)).toBe('28/03/2026, 09:00');
    expect(wallClock(after, LONDON)).toBe('31/03/2026, 09:00');
    // Same wall clock, different UTC hour: the whole point.
    expect(before.getUTCHours()).toBe(9);
    expect(after.getUTCHours()).toBe(8);
  });

  it('stays on 09:00 wall clock across a fall-back', () => {
    // BST ends 2026-10-25.
    const before = nextLocalHour(LONDON, 9, new Date('2026-10-23T10:00:00Z'));
    const after = nextLocalHour(LONDON, 9, new Date('2026-10-26T10:00:00Z'));
    expect(wallClock(before, LONDON)).toBe('24/10/2026, 09:00');
    expect(wallClock(after, LONDON)).toBe('27/10/2026, 09:00');
    expect(before.getUTCHours()).toBe(8);
    expect(after.getUTCHours()).toBe(9);
  });

  it('handles the 17:00 job too', () => {
    const next = nextLocalHour(NEW_YORK, 17, new Date('2026-07-15T12:00:00Z'));
    expect(wallClock(next, NEW_YORK)).toBe('15/07/2026, 17:00');
  });

  it('falls back to UTC for a zone it does not recognise', () => {
    // A bad zone must not throw inside an alarm handler, where the failure
    // is invisible. The nudge arrives at the wrong hour rather than never.
    const next = nextLocalHour('Mars/Olympus_Mons', 9, new Date('2026-06-15T01:00:00Z'));
    expect(next.getUTCHours()).toBe(9);
  });
});
