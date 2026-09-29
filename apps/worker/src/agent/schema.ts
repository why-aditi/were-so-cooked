/**
 * The KitchenAgent's own SQLite, one database per user (section 4).
 *
 * This is where every piece of per-user kitchen data lives. Section 9's
 * isolation rule depends on that: the shared D1 holds accounts and the recipe
 * catalog and nothing personal, so a bug in a D1 query cannot leak one user's
 * pantry to another. The blast radius of a bug in here is one user.
 *
 * Executed in `blockConcurrencyWhile`, so no request can observe a half-built
 * schema. Every statement is `IF NOT EXISTS`, so it is safe on every start.
 */
export const AGENT_SCHEMA: string[] = [
  // Small facts the agent needs synchronously, so they cannot be async storage
  // keys: which user this instance belongs to, and whether that user is a demo
  // account. A Durable Object cannot recover the name it was addressed by, so
  // the first caller tells it and it remembers.
  `CREATE TABLE IF NOT EXISTS agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  // Single row, enforced by the CHECK rather than by convention.
  `CREATE TABLE IF NOT EXISTS profile (
     id               INTEGER PRIMARY KEY CHECK (id = 1),
     diets            TEXT NOT NULL DEFAULT '[]',
     allergens        TEXT NOT NULL DEFAULT '[]',
     exclusions       TEXT NOT NULL DEFAULT '[]',
     cuisines         TEXT NOT NULL DEFAULT '[]',
     max_cook_minutes INTEGER NOT NULL DEFAULT 45,
     servings         INTEGER NOT NULL DEFAULT 2,
     spice_level      TEXT NOT NULL DEFAULT 'medium',
     time_zone        TEXT NOT NULL DEFAULT 'UTC',
     updated_at       TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS pantry_items (
     id             TEXT PRIMARY KEY,
     -- NULL when the normalizer could not resolve the name. The safety engine
     -- treats such an item as unverifiable, which is the point: it must stay
     -- nullable rather than being backfilled with a guess.
     canonical_id   TEXT,
     display_name   TEXT NOT NULL,
     category       TEXT NOT NULL,
     quantity       REAL NOT NULL,
     unit           TEXT NOT NULL,
     qty_confidence TEXT NOT NULL CHECK (qty_confidence IN ('exact', 'approx')),
     added_at       TEXT NOT NULL,
     expires_at     TEXT,
     expiry_source  TEXT NOT NULL CHECK (expiry_source IN ('estimated', 'user', 'label')),
     source         TEXT NOT NULL CHECK (source IN ('chat', 'photo', 'manual')),
     -- Soft delete keeps history for undo (section 4). Every read filters on it.
     deleted_at     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pantry_live ON pantry_items (deleted_at, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pantry_canonical ON pantry_items (canonical_id)`,

  `CREATE TABLE IF NOT EXISTS cooking_log (
     id           TEXT PRIMARY KEY,
     recipe_id    TEXT,
     recipe_title TEXT NOT NULL,
     cooked_at    TEXT NOT NULL,
     deducted     TEXT NOT NULL DEFAULT '[]'
   )`,
  // Powers the no-repeat-within-7-days rule in section 6.
  `CREATE INDEX IF NOT EXISTS idx_cooking_log_when ON cooking_log (cooked_at DESC)`,

  // Section 4's taste memory. Stays here rather than in Vectorize: at most
  // 300 short rows per user, so brute-force cosine beats a shared index on
  // both latency and privacy.
  `CREATE TABLE IF NOT EXISTS taste_memory (
     id         TEXT PRIMARY KEY,
     text       TEXT NOT NULL,
     kind       TEXT NOT NULL CHECK (kind IN ('like', 'dislike', 'note')),
     -- Taxonomy id where one resolves, else the raw name. This is what
     -- section 7 matches against a recipe to raise a soft violation; the
     -- prose in \`text\` is for the model to read, not to match on.
     subject    TEXT,
     recipe_id  TEXT,
     weight     REAL NOT NULL DEFAULT 1,
     -- Float32Array of 1024 dimensions from bge-m3. A BLOB rather than JSON:
     -- 4KB packed against roughly 20KB as text, read in full on every search.
     -- NULL when the embedding call failed, which makes the row invisible to
     -- semantic search but still readable.
     embedding  BLOB,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_taste_created ON taste_memory (created_at DESC)`,
  // Section 7 reads dislikes on every safety check, so the filter is indexed.
  `CREATE INDEX IF NOT EXISTS idx_taste_kind ON taste_memory (kind)`,

  // Section 4's weekly plan and the grocery list derived from it.
  //
  // Nothing writes these yet — that is `WeeklyPlanWorkflow` — but the read
  // routes and the plan and grocery screens are built against them, so a
  // plan landing later needs no migration and no second shape.
  `CREATE TABLE IF NOT EXISTS plans (
     id          TEXT PRIMARY KEY,
     week_start  TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating', 'ready', 'failed', 'partial')),
     workflow_id TEXT,
     plan        TEXT NOT NULL DEFAULT '{}',
     created_at  TEXT NOT NULL
   )`,
  // Section 4: "One active plan per week."
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_week ON plans (week_start)`,

  `CREATE TABLE IF NOT EXISTS grocery_items (
     id           TEXT PRIMARY KEY,
     plan_id      TEXT NOT NULL,
     canonical_id TEXT,
     display_name TEXT NOT NULL,
     category     TEXT NOT NULL DEFAULT 'other',
     quantity     REAL,
     unit         TEXT,
     checked      INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_grocery_plan ON grocery_items (plan_id)`,

  // Section 4's photo scans, one row per photo.
  //
  // `status` is load-bearing rather than convenience, and section 6 says so:
  // a Workflow parked on `waitForEvent` reports `running`, never `waiting`,
  // so there is no runtime state to poll for. This column is the only place
  // that knows a scan is sitting in front of a user waiting to be confirmed.
  `CREATE TABLE IF NOT EXISTS scans (
     id          TEXT PRIMARY KEY,
     workflow_id TEXT,
     r2_key      TEXT NOT NULL,
     items       TEXT NOT NULL DEFAULT '[]',
     status      TEXT NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'awaiting_confirm', 'done', 'failed')),
     error       TEXT,
     created_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_scans_status ON scans (status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS inbox (
     id         TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     title      TEXT NOT NULL,
     body       TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     read_at    TEXT,
     -- Stops the daily expiry job nudging about the same item twice.
     dedupe_key TEXT NOT NULL UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_unread ON inbox (read_at, created_at DESC)`,
];
