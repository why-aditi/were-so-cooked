-- 0002_demo_signups — rate-limit ledger for demo account creation.
--
-- Section 9 caps demo accounts at 5 per IP per hour and 50 per day in total.
-- Both counts need a record that survives after the account it created has been
-- deleted by the nightly cron, so this cannot be derived from `users`: an
-- attacker who waits for cleanup would get a fresh allowance every night.
--
-- The IP is stored as a salted SHA-256, never in the clear. The salt is
-- SESSION_SIGNING_KEY, so these rows are useless without it and the column
-- cannot be reversed with a rainbow table over the IPv4 space.

CREATE TABLE IF NOT EXISTS demo_signups (
  id         TEXT PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Both rate-limit queries filter on created_at, and the per-IP one also
-- filters on ip_hash. This index serves both.
CREATE INDEX IF NOT EXISTS idx_demo_signups_window ON demo_signups (created_at);
CREATE INDEX IF NOT EXISTS idx_demo_signups_ip ON demo_signups (ip_hash, created_at);
