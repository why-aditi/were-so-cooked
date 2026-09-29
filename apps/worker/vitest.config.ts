import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests run in workerd with real Durable Objects, real D1 and the
 * real wrangler.jsonc binding surface (section 13). Nothing here is a mock of
 * Cloudflare — the point is to catch the things a mocked D1 would not, such as
 * a foreign key that does not behave the way the schema implies.
 *
 * On vitest 4 and pool 0.21 the pool is a Vite plugin rather than a
 * `defineWorkersConfig` wrapper. The upgrade was not optional: the Agents SDK
 * needs `ctx.id.name`, which the workerd bundled with pool 0.10 does not
 * expose at any compatibility date it supports.
 *
 * The migrations and the seed are read at config time and handed over as
 * bindings, because they need Node's filesystem and the tests run inside the
 * sandbox.
 */
const migrations = await readD1Migrations('../../migrations');

// Only the agent and recipe tests apply these, so they are not in setup.ts —
// 810 inserts would be dead weight on every other file.
const seedSql = readFileSync('../../seed/010_ingredients.sql', 'utf8');
const substitutionsSql = readFileSync('../../seed/020_substitutions.sql', 'utf8');

export default defineConfig({
  plugins: [
    cloudflareTest({
      // A trimmed config, not the real one: Workers AI and Vectorize have no
      // local emulation and the pool would try to open a remote preview
      // session for them. See the comment in test/wrangler.test.jsonc.
      wrangler: { configPath: './test/wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_SEED_SQL: seedSql,
          TEST_SUBSTITUTIONS_SQL: substitutionsSql,
          SESSION_SIGNING_KEY: 'test-signing-key-not-a-real-secret',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
