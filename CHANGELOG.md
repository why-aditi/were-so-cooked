# Changelog

Notable changes to We're So Cooked. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses Conventional Commits.

Nothing is released yet, so everything sits under Unreleased. The first tag will be cut when the MVP deploys.

## [Unreleased]

### Added

- **Frontend.** React 19 SPA on Vite, Tailwind and React Router: landing page, app shell with a bottom tab bar on phones and a rail from `md`, and every screen in section 10 — chat, pantry, plan, grocery, trending, inbox, profile and pipeline status. Dark theme by default with a light theme.
- **Chat.** `KitchenAgent` built on `AIChatAgent` from `@cloudflare/ai-chat`, with the SDK's message persistence, resumable streaming, WebSocket transport and human-in-the-loop approvals. All six of section 10's card types render from structured tool output.
- **Tools.** Every section 5 tool except `search_trending`, each with a Zod input schema. `log_cooked` and `update_profile` are gated behind the SDK's approval flow.
- **Weekly plans.** `WeeklyPlanWorkflow`: load context, reserve, build, grocery diff, save. Safety-gated, no repeats within 7 days, soon-to-expire stock first, the cook-time limit. A slot nothing safe fits stays open and is reported rather than filled with an invented meal. `POST /api/plans`, the plan screen, the grocery list, a plan-ready inbox item, and live `plan.progress` ticks on the chat card. When the budget refuses the reservation the run goes ahead catalog-only instead of being deferred, because the catalog costs no neurons.
- **Safety engine.** `packages/safety`: `check()`, `substitute()`, 18 diets, 14 allergens, severity levels. Pure TypeScript, no I/O. The invariant — substitute output either passes check or is dropped — holds by construction and is covered by property tests.
- **Taxonomy.** 810 hand-reviewed ingredients with aliases including romanized Hindi, plus 92 curated substitutions, authored as TSV and built into JSON and SQL.
- **Normalizer.** Free text to canonical pantry items: quantities, units, expiry estimates. Handles `a bunch`, `2 packets`, `1.5kg`, `½ cup`, `dhaniya`, `2 pyaaz`. Taxonomy first; the 8B model only for misses, batched into one call.
- **Photo scans.** `PhotoScanWorkflow`: validate, vision-extract on Qwen3.8 27B, normalize, wait for confirmation with a 24-hour timeout, commit through the agent, clean up on every path.
- **Budget.** `BudgetKeeper` Durable Object with reserve-then-commit, per-user and per-pool caps, and costs computed from real token counts. `GET /api/budget` and an on-screen meter.
- **Taste memory.** Per-user, in the agent's own SQLite, searched with in-process cosine over at most 300 vectors.
- **Scheduled work.** Daily expiry nudges at 09:00 and a "you can make X tonight" suggestion at 17:00, both in the user's own time zone and correct across daylight saving.
- **Auth.** GitHub OAuth, hashed session tokens in D1, demo accounts with rate limits and a 24-hour expiry, nightly cleanup, `DELETE /api/me`, and a local `DEV_AUTH` bypass.
- **API.** Every route in section 11 that does not depend on an unbuilt Workflow.
- **Infrastructure.** `wrangler.jsonc` with every binding, cron, Durable Object migration and three environments; numbered D1 migrations; an idempotent `pnpm bootstrap`.
- **CI/CD.** Pull request, main, gitleaks and hourly synthetic workflows.
- **Tests.** 540 unit and property tests, 168 integration tests against real Durable Objects and D1, a 300-case safety eval, and a Playwright suite against a deploy.
- **Docs.** README with architecture, setup, decisions and tradeoffs. `PROMPTS.md`. This file.

### Changed

- **Migrated `KitchenAgent` from a plain Durable Object to `AIChatAgent`.** Deleted the hand-rolled turn loop, WebSocket transport, message table and approval table — the SDK owns all four, and it brings resumable streaming, which the hand-rolled version did not have.
- **Upgraded the test stack to Vitest 4 and `@cloudflare/vitest-pool-workers` 0.21.** Not cosmetic: the Agents SDK needs `ctx.id.name`, which the workerd bundled with pool 0.10 does not expose at any compatibility date it supports.
- Moved ingredient default units out of the normalizer's hardcoded maps and into the taxonomy. A parser is the wrong place for facts about ingredients, and a per-category default cannot tell coriander from a carrot.

### Fixed

- **`substitute()` kept LLM-supplied diet and allergen tags on recipes that already passed.** Section 7 gives the engine sole ownership of those tags with no exception, so a model-written recipe claiming `vegan` could pass an empty profile untouched, get stored with the claim, and later be served to an actual vegan by a tag filter. Tags are now recomputed on every path.
- **`destroy()` left the agent without its schema.** `deleteAll()` drops the SQL tables but the constructor does not run again for a live instance, so any later call hit `no such table`. Now handled by the SDK, which deletes the facet outright.
- **The Worker could not return two of section 11's error codes.** `auth.ts` defined its own narrower `ErrorCode` that omitted `budget_exhausted` (429) and `upstream_error` (502). It now uses the shared enum.
- **Unhandled errors escaped section 11's error shape.** A throw with no handler returned plain-text `Internal Server Error` with no request ID. Found by the E2E suite when a missing local table surfaced as an unparseable body.
- **The 8B classifier was never wired to a model.** `Classifier` was a type nothing implemented, so section 12's "taxonomy first, model only for misses" had nothing behind it and `add_pantry_items` never called a model at all.
- **Vision extraction lost items when the model returned a bare array.** The JSON extractor scanned for `{`…`}` and sliced the first object out of a top-level array, silently dropping everything after it.
- **Taste memory evicted arbitrary rows.** Ordering on `created_at` alone ties when several memories are written in the same millisecond, so the 300-row cap could drop a memory the user had just given.
- **`UNKNOWN_MODEL_RATE` underpriced unknown models.** It was not the per-axis maximum, so a model absent from the rate table could cost more than reserved.
- **A Hono `:param` route did not cover the Agents SDK's HTTP sub-paths**, so those requests bypassed section 9's isolation guard entirely.

### Security

- Section 9's isolation rule — user A's session gets 403 on user B's agent — is enforced on every HTTP request and WebSocket upgrade, including the SDK's own sub-paths, and has a dedicated test.
- Uploads are typed by magic bytes rather than `Content-Type`, and capped at 5 MB before anything is written to R2.
- gitleaks runs on every push. `.dev.vars` and `.env*` are git-ignored.
- LLM output is never trusted: proposed substitutions must resolve to a real taxonomy entry, generated recipes cannot assert diet or allergen tags, and untrusted text is quoted as data in every extraction prompt.

### Known gaps

- `ViralRecipesWorkflow` is not built, so `search_trending` is deliberately unregistered.
- Regenerating a single plan day is not built; "start again" replans the whole week.
- Vectorize recipe search is behind a `RecipeSearch` interface but unimplemented — nothing writes embeddings yet.
- Not deployed, so the README has no live URL.
