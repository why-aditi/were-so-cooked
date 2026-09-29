Worker entry, Hono routes, Durable Objects (sections 3, 5, 6, 9, 12).

- `src/index.ts` — Hono app, static assets, `/healthz`, the cron handler.
- `src/auth.ts`, `src/routes/` — GitHub OAuth, sessions, demo accounts, and the isolation guard on `/agents/kitchen-agent/{userId}` (section 9).
- `src/budget/` — neuron rates and the pure budget policy (section 12).
- `src/normalize/` — free text to canonical pantry items; taxonomy first, the 8B model only for misses.
- `src/agent/` — the `KitchenAgent`, one Durable Object per user, built on `AIChatAgent` from `@cloudflare/ai-chat`:
  - `kitchen-agent.ts` — the agent: the section 4 SQLite, the turn, taste memory, the scheduled jobs and the synced state.
  - `tools.ts` — the ten section 5 tools as AI SDK tools, with Zod input schemas and the SDK's own `needsApproval` on `log_cooked` and `update_profile`.
  - `context.ts` — the section 5 context window, with the per-slot token caps enforced.
  - `taste.ts` — taste memory: cosine search over at most 300 in-process vectors (section 4 keeps this out of Vectorize on purpose).
  - `schedule-local.ts` — "09:00 in the user's time zone" on a UTC runtime, DST included.
  - `adapters.ts` — the non-streaming Workers AI edge and the `BudgetKeeper` ledger.
  - `deduct.ts` — the `log_cooked` arithmetic.

The SDK owns message persistence, resumable streaming, the WebSocket transport and the approval round trip. What this repo adds is the budget gate before the model call, the context window, the safety gate on anything that returns food, and the section 4 tables.
- `src/photo/` — the `PhotoScanWorkflow` pipeline (section 6):
  - `validate.ts` — 5 MB cap and JPEG/PNG/WebP by magic bytes, not by `Content-Type`.
  - `extract.ts` — the vision call on Qwen3.8 27B (spike 2's choice), schema-validated, plus strict parsing of printed expiry dates.
  - `scan.ts` — the normalize step and section 6's low-confidence rule.
- `src/normalize/classify.ts` — the 8B fallback for names the taxonomy missed, shared by chat and photo scans.
- `src/recipes/` — the two tools that return food, and the safety gate section 5 step 4 requires:
  - `store.ts` — the D1 catalog behind the `RecipeSearch` interface section 12 asks for, plus the curated swap table.
  - `generate.ts` — inventing a dish and proposing a replacement ingredient, both on the cheap model, both schema-validated and neither trusted.
  - `suggest.ts` — `suggest_recipes` and `substitute`: search, generate, then every candidate through `substitute()` and its unconditional final `check`.

`PhotoScanWorkflow` is implemented; `WeeklyPlanWorkflow` and `ViralRecipesWorkflow` still throw.

Not implemented yet: `start_weekly_plan`, `get_plan` / `get_grocery_list` / `check_grocery_item` and `search_trending`, and the Workflows behind them. They are deliberately not registered — a tool the model can call but the server cannot answer is worse than a missing one.

Tests split two ways. Pure logic runs in the node pool from the repo root (`pnpm vitest run`); anything that needs real Durable Object SQLite, real D1 or the real ledger runs in workerd (`pnpm test:worker`). The workerd suite mocks Workers AI at the provider seam with `MockLanguageModelV4` (`test/fixtures/model.ts`), so the SDK's real turn loop, tool dispatch and approval pause all run.

The test `compatibility_date` trails the real one because it tracks the workerd bundled with the test pool; see the comment in `test/wrangler.test.jsonc`.
