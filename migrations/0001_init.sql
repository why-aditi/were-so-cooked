-- 0001_init — the shared D1 schema from section 4.
--
-- Scope: this database holds only shared and account data. Per-user kitchen
-- data (pantry, profile, cooking log, taste memory, plans, grocery list, scans,
-- inbox) lives in each user's KitchenAgent SQLite and is deliberately absent
-- here — section 9's isolation rule depends on that separation.
--
-- Timestamps are ISO-8601 TEXT so they match the IsoDateTime schema in
-- packages/shared rather than needing a conversion at every boundary.
-- Booleans are INTEGER 0/1, which is what SQLite actually stores.

-- ---------------------------------------------------------------- accounts --

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  github_id   TEXT UNIQUE,              -- NULL for demo accounts
  login       TEXT NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  -- Not in the section 4 table, but section 9 gives demo accounts a 24-hour
  -- expiry and the 00:15 cron deletes them. Without a column to sort on, that
  -- job has nothing to select. NULL means "never expires" (a real account).
  expires_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_expiry ON users (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the cookie value. The token itself is never stored (section 9).
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------- taxonomy --

CREATE TABLE IF NOT EXISTS ingredients (
  canonical_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  aliases            TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  category           TEXT NOT NULL,
  default_shelf_days INTEGER,
  allergens          TEXT NOT NULL DEFAULT '[]',  -- JSON Allergen[]
  diet_flags         TEXT NOT NULL DEFAULT '[]'   -- JSON IngredientFlag[]
);

CREATE INDEX IF NOT EXISTS idx_ingredients_name ON ingredients (name);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients (category);

CREATE TABLE IF NOT EXISTS substitutions (
  from_id     TEXT NOT NULL REFERENCES ingredients (canonical_id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES ingredients (canonical_id) ON DELETE CASCADE,
  -- "constraint" is a reserved word in SQL, so the column is named for what it
  -- holds: the rule that forces the swap (vegan, dairy_free, tree_nuts, …).
  rule        TEXT NOT NULL,
  ratio_note  TEXT,
  explanation TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, rule)
);

CREATE INDEX IF NOT EXISTS idx_substitutions_lookup ON substitutions (from_id, rule);

-- ----------------------------------------------------------------- catalog --

CREATE TABLE IF NOT EXISTS recipes (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('seed', 'llm', 'youtube')),
  title          TEXT NOT NULL,
  cuisine        TEXT NOT NULL,
  ingredients    TEXT NOT NULL,               -- JSON RecipeIngredient[]
  steps          TEXT NOT NULL DEFAULT '[]',  -- JSON string[]; empty until first open
  minutes        INTEGER NOT NULL,
  servings       INTEGER NOT NULL,
  -- Always written by the safety engine. LLM-supplied tags are discarded
  -- (section 7), so nothing else may write these two columns.
  diet_tags      TEXT NOT NULL DEFAULT '[]',
  allergen_tags  TEXT NOT NULL DEFAULT '[]',
  source_url     TEXT,
  creator        TEXT,
  thumbnail_url  TEXT,
  trending_until TEXT,
  content_hash   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipes_cuisine ON recipes (cuisine);
CREATE INDEX IF NOT EXISTS idx_recipes_trending ON recipes (trending_until) WHERE trending_until IS NOT NULL;
-- The viral pipeline dedupes on this before embedding, so it is a hot lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_content_hash ON recipes (content_hash);

-- ---------------------------------------------------------------- pipeline --

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  found       INTEGER NOT NULL DEFAULT 0,
  filtered    INTEGER NOT NULL DEFAULT 0,
  extracted   INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  neurons     REAL NOT NULL DEFAULT 0,
  errors      TEXT NOT NULL DEFAULT '[]'  -- JSON string[]
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs (started_at DESC);

-- Section 6: "D1 gets one more table for this: seen_videos, so a video is
-- never processed twice."
CREATE TABLE IF NOT EXISTS seen_videos (
  video_id   TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  outcome    TEXT NOT NULL
);
