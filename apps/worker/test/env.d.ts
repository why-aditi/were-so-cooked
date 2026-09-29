import type { Env as WorkerEnv } from '../src/env.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends WorkerEnv {
    TEST_MIGRATIONS: D1Migration[];
    /** seed/010_ingredients.sql, for tests that need the real taxonomy in D1. */
    TEST_SEED_SQL: string;
    /** seed/020_substitutions.sql, for tests that need the real swap table. */
    TEST_SUBSTITUTIONS_SQL: string;
  }
}
