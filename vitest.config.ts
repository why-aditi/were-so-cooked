import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/worker has its own config: those tests run inside workerd via
    // @cloudflare/vitest-pool-workers, which cannot share a pool with these.
    // apps/worker/src holds pure logic (budget maths, policy) that needs no
    // Cloudflare runtime, so it runs here in the fast node pool. Only
    // apps/worker/test needs workerd, and that has its own config.
    include: [
      'packages/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
      // The web app's only node-pool test: it reads index.css and checks
      // every colour pair against WCAG AA, so section 10's contrast claim
      // cannot quietly stop being true.
      'apps/web/src/**/*.test.ts',
      'evals/**/*.eval.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/safety/src/**', 'packages/shared/src/**', 'apps/worker/src/budget/**'],
      // Fixtures and tests are scaffolding, not code under test.
      exclude: ['**/*.test.ts', '**/fixtures.ts', '**/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        // Section 13 sets 90% line coverage on packages/safety specifically.
        // It is the only package where a gap in a branch is a safety question
        // rather than a quality one.
        'packages/safety/src/**': { lines: 90, functions: 90, statements: 90 },
      },
    },
  },
});
