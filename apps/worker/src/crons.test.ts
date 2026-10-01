import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The cron strings in wrangler.jsonc against the handler that dispatches on
 * them. `scheduled()` matches `event.cron` exactly, so a schedule edited in one
 * place and not the other fires into the "unknown" branch and does nothing —
 * silently, once a week. And Cloudflare refuses day-of-week 0, but only after
 * the Worker has already deployed.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
const handler = readFileSync(join(ROOT, 'apps', 'worker', 'src', 'index.ts'), 'utf8');

const crons = [
  ...new Set(
    [...config.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((c) => c[1] as string),
    ),
  ),
];

describe('cron triggers', () => {
  it('declares some', () => {
    expect(crons.length).toBeGreaterThan(0);
  });

  it.each(crons)('"%s" is one scheduled() recognises', (cron) => {
    expect(handler).toContain(`event.cron === '${cron}'`);
  });

  it.each(crons)('"%s" names its weekday rather than using 0', (cron) => {
    const dayOfWeek = cron.trim().split(/\s+/)[4];
    expect(dayOfWeek).not.toMatch(/(^|,|-)0($|,|-)/);
  });
});
