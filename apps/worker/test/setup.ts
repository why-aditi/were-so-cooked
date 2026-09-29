import { applyD1Migrations, env } from 'cloudflare:test';

// Each test file gets an isolated D1, so the real migrations run against it
// first. Testing against a hand-written schema would let migrations/ and the
// tests drift apart silently.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
