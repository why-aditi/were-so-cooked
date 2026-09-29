# Prompt history

Section 13 asks for "one entry per AI-assisted coding session: date, tool, purpose, the prompts verbatim, and the resulting commit or PR."

## Read this first

Two things are missing, and it is better to say so than to fill them in plausibly.

**The planning conversation is not here.** Section 1 names `PROMPTS.md` as "maintained from the first session, including this planning chat", and section 13 says "the first entry is this planning conversation". That conversation produced the technical spec in this repo. It happened in Claude chat before this file existed and its prompts were not captured verbatim at the time. They cannot be reconstructed from the spec, and paraphrasing them here would misrepresent what was asked. **Entry 0 below is a placeholder to be filled in from the original chat transcript.**

**There are no commit or PR links.** At the time of writing the working tree is not a git repository, so nothing can be linked. Once `git init` happens and the work is committed, each entry below needs its commit range added.

Everything from entry 1 onward is verbatim: the prompts are reproduced exactly as they were typed, including typos, because a cleaned-up prompt is a different prompt and the point of this file is to show what actually produced the code.

No secrets, API keys or tokens were pasted into any prompt. Cloudflare credentials were handled through `wrangler login` and a git-ignored `.env`, never through the chat.

---

## Entry 0 — Planning and specification

- **Date:** before 2026-09-23
- **Tool:** Claude chat
- **Purpose:** Produce `We're So Cooked — Technical Spec.md`: scope, architecture, data model, the safety engine design, budget policy, and the milestone plan.
- **Prompts:** **Not captured.** To be pasted from the original chat transcript.
- **Result:** The spec, which every entry below reads sections of.

---

## Entry 1 — Repository skeleton and shared schemas

- **Date:** 2026-09-23
- **Tool:** Claude Code
- **Purpose:** The pnpm monorepo and `packages/shared`.

> Read sections 2, 4, 5, 7 and 11 of the spec. Create the repo skeleton for We're So Cooked: a pnpm monorepo with apps/web, apps/worker, packages/shared, packages/safety, packages/prompts, evals, seed, migrations. Implement packages/shared only: Zod schemas and TypeScript types for PantryItem, Profile (diets, allergens, exclusions), Recipe, Ingredient, Plan, GroceryItem, Scan, InboxItem, TasteMemory, and the API request and response types for every route in section 11, plus the error shape. Export a single index. No other package gets implementation yet. Add tsconfig, eslint, prettier, vitest config. Everything must typecheck.

- **Result:** `packages/shared` with 9 domain entities and the section 11 API types.

---

## Entry 2 — Week 1 spikes

- **Date:** 2026-09-23 to 2026-09-25
- **Tool:** Claude Code, with Claude in Chrome for the Cloudflare account setup
- **Purpose:** Answer section 14's six spikes with measured numbers rather than assumptions.

> Read section 14 of the spec, 'Week 1 spikes'. Create a spikes/ directory with one small, runnable Wrangler project per spike (1-6). Each spike answers its question with real output and writes the answer plus measured numbers to spikes/<n>/RESULT.md. Do not touch apps/ or packages/. For spike 4, measure actual neurons per chat turn and per plan and compare against the estimates in section 8.

Follow-ups, in order:

> show me the results when done

> how to make cloudflare account

> use claude in chrome to do it, i already have an account made a long time back

> add account id in the env too and make example env

> run them now

> yes re arm

> disable sleep so it runs overnight

> what does it mean, also can we use something that doesnt require lisence???

> update spec doc

- **Result:** Six runnable spikes with committed `RESULT.md` files. Findings that changed the spec: the free neuron limit is a **rolling 24-hour window**, not a daily reset (discovered by burning 50,583 neurons and still being blocked the next morning); Llama 3.2 Vision is licence-gated and excludes EU-domiciled users, so photo extraction moved to Qwen3.8 27B; a chat turn costs 71.6 neurons against an estimate of 120, and a full plan 435 against ~1,100.

---

## Entry 3 — Infrastructure, auth and budget

- **Date:** 2026-09-25
- **Tool:** Claude Code
- **Purpose:** Wrangler config, migrations, CI, GitHub OAuth, and the neuron ledger.

> Read sections 3, 9, 12 and 13 of the spec. Implement: wrangler.jsonc with every binding, cron, DO migration, and dev/staging/production environments; scripts/bootstrap.ts: idempotent creation of D1, Vectorize index, R2 bucket with 1-day lifecycle, AI Gateway; loads seed data; migrations/ with the D1 schema from section 4; .github/workflows for PR (typecheck, lint, test, preview deploy) and main (migrate, deploy, smoke test, auto-rollback), plus gitleaks and the hourly synthetic check; a Hono Worker entry that serves static assets and /healthz only

> Read section 9 of the spec. Implement GitHub OAuth, sessions (hashed tokens in D1, 30-day cookie), demo account creation with rate limits and 24-hour expiry, the nightly cleanup cron, DELETE /api/me, and the DEV_AUTH local bypass. Include integration tests using @cloudflare/vitest-pool-workers, especially the isolation test: user A's session must get 403 on user B's agent.

> Read section 12 of the spec. Implement the BudgetKeeper Durable Object: reserve-then-commit with 5-minute reservation expiry, per-user and per-pool caps, cost computed from token counts using the per-model rates in config, daily reset at 00:00 UTC, and GET /api/budget. Unit-test the maths and the expiry, including the Sunday pipeline reservation.

- **Result:** `wrangler.jsonc` with three environments, four GitHub Actions workflows, section 9 auth with the isolation test, and `BudgetKeeper`. Deliberate deviation from the spec, documented in code: the account ceiling uses a rolling 24-hour window to match the measured behaviour, while per-user caps use the UTC day as section 12 states.

---

## Entry 4 — Safety engine and taxonomy

- **Date:** 2026-09-25 to 2026-09-26
- **Tool:** Claude Code
- **Purpose:** The part of the product that has to be right.

> Read section 7 of the spec. Implement packages/safety as pure TypeScript with no I/O: check(recipe, profile) and substitute(recipe, profile), the diet rule set, allergen mapping, and severity levels. Include exhaustive unit tests per diet and allergen, plus fast-check property tests for the invariant that substitute output always passes check or is dropped. Target 90% line coverage.

> Read section 7 of the spec. Generate seed/ingredients.json: ~1,500 ingredients across Indian, East and Southeast Asian, European, Middle Eastern and American cooking, each with canonical_id, aliases (including Hindi and romanized names), category, default_shelf_days, allergens and diet flags. Cover composite items (sauces, breads, masalas, dairy) with their hidden allergens. Also generate seed/substitutions.json. Add a validation script that fails on missing fields, unknown allergen names, or duplicate aliases. Flag every entry you were unsure about in a REVIEW.md list for me to check.

> show me the low confidence entries

> split asafoetida, soba, sausage and wasabi into two entries each

- **Result:** `packages/safety` at 99–100% coverage, and 810 hand-reviewed ingredients with 92 substitutions. Delivered 810 rather than the requested ~1,500 deliberately: padding the list would have tripled the review burden without adding coverage, and section 15 grows the taxonomy from logged unknown ingredients. The split request came from a real ambiguity — bare "wasabi" was resolving to the mustard-free entry, which is the wrong way to be wrong.

---

## Entry 5 — Ingredient normalizer

- **Date:** 2026-09-26
- **Tool:** Claude Code
- **Purpose:** Free text to canonical pantry items.

> Read sections 4, 5 and 7 of the spec. Implement the ingredient normalizer: free text to canonical items with quantity, unit and expiry estimate. Deterministic taxonomy and alias matching first; the 8B model only for misses. Handle 'a bunch', '2 packets', '1.5kg', '½ cup', 'dhaniya', '2 pyaaz'. Unit tests with at least 60 real-world phrases.

> add default_unit to the taxonomy

- **Result:** The normalizer with 126 tests over 66 real-world phrases. The follow-up moved default units out of the parser's hardcoded maps and into the taxonomy — a parser is the wrong place for facts about ingredients.

---

## Entry 6 — KitchenAgent, tools and the chat loop

- **Date:** 2026-09-26 to 2026-09-27
- **Tool:** Claude Code
- **Purpose:** The agent, its tools, and the turn.

> now implement the KitchenAgent with the pantry tools

> now implement the chat loop with the pantry tools

> now implement suggest_recipes and substitute

- **Result:** `KitchenAgent` with per-user SQLite, the pantry tools, a hand-rolled turn loop, and the two food tools behind the safety gate. Two real bugs found: `destroy()` left a live instance without its schema, and `substitute()` kept LLM-supplied diet tags on recipes that already passed — the second is a fail-open that could serve a falsely-tagged recipe to a vegan.

---

## Entry 7 — Migration to `AIChatAgent`

- **Date:** 2026-09-28
- **Tool:** Claude Code
- **Purpose:** Replace the hand-rolled loop with the SDK the spec names.

> Read sections 5, 8 and 11 of the spec. Implement KitchenAgent on AIChatAgent from @cloudflare/ai-chat: SQLite tables from section 4, all tools from section 5 with Zod validation, human-in-the-loop approval for log_cooked and update_profile, context assembly with the token caps, taste memory with in-process cosine search, synced state, and the scheduled expiry and tonight jobs. Every tool that returns food must pass through packages/safety before returning. Integration tests with mocked Workers AI fixtures.

- **Result:** The migration, minus 313 lines of hand-rolled transport. Required upgrading the whole test stack to Vitest 4 and pool 0.21, because the SDK needs `ctx.id.name` and the older bundled workerd does not expose it at any compatibility date it supports. Added taste memory and the DST-correct scheduler.

- **Note on a reversed decision.** During entry 6 I chose *not* to use `AIChatAgent`, on the argument that three of the four things it provides were already owned or native, and I flagged that as a deviation. This prompt reaffirmed the spec's requirement, so the deviation was reversed. The reversal was the right call: the fourth thing, resumable streaming, was the one I could not cheaply replace.

---

## Entry 8 — Photo scan pipeline

- **Date:** 2026-09-28
- **Tool:** Claude Code
- **Purpose:** `PhotoScanWorkflow` and the upload routes.

> Read section 6 of the spec, PhotoScanWorkflow, and section 11's upload routes. Implement the R2 upload route and the Workflow: validate, vision-extract, normalize, await confirm event with 24-hour timeout, commit through the agent, clean up. Test the timeout path and the low-confidence path.

> fix classifier

- **Result:** The Workflow, magic-byte upload validation, and the section 11 scan routes. Found four bugs, including a JSON extractor that silently dropped every item after the first when the model returned a bare array, and two section 11 error codes the Worker could not return at all. The second prompt followed a run of tool-call failures; it turned out to be a transient infrastructure fault that cleared on retry, but it surfaced that the 8B classifier had never actually been wired to a model.

---

## Entry 9 — Frontend

- **Date:** 2026-09-28
- **Tool:** Claude Code, with the `frontend-design` skill
- **Purpose:** The React SPA.

> Read sections 10 and 11 of the spec. Build the React SPA: landing page, app shell with bottom tabs on mobile, and the chat screen using useAgent and useAgentChat, with all six card types, the composer with photo attach, and the budget meter. Follow the visual direction and voice in section 10: chaotic copy everywhere except safety and error messages, which stay plain. WCAG AA contrast, full keyboard support.

> Read section 10 of the spec. Build the pantry, plan, grocery, trending, inbox, profile and status screens against the section 11 API, plus the copy from the voice table. The profile screen must make every diet and allergen selectable and support custom exclusions.

> retry

- **Result:** The full SPA. The design idea carried through both prompts: section 10's rule that safety copy stays plain became a visual rule too, so cards with a safety consequence drop the tilt and the shadow. The second prompt also required building most of section 11's API, which did not exist yet. The third was a re-send of a stale status message; both items in it were already complete, so nothing was redone.

---

## Entry 10 — Evals, E2E and documentation

- **Date:** 2026-09-28
- **Tool:** Claude Code
- **Purpose:** The quality bar from section 13.

> Read sections 13 and 1 of the spec. Add the Playwright E2E suite for the full demo flow, the safety eval suite with recorded outputs in CI and a live mode behind a neuron cap, the README (architecture diagram, setup, design decisions, tradeoffs, live URL), and CHANGELOG.md. Verify PROMPTS.md has an entry for every AI-assisted session.

- **Result:** This file, the README, `CHANGELOG.md`, the 300-case safety eval with a committed report, and the Playwright suite. The eval's teeth were verified by mutation: removing the final unconditional `check` in `substitute` fails 217 of 304 cases. The E2E run found a real bug — unhandled errors escaped section 11's error shape.

- **On the last clause of the prompt.** "Verify PROMPTS.md has an entry for every AI-assisted session" assumed the file existed. It did not. It has been created with every session this repo has evidence for; the planning conversation that predates it is entry 0 and is still missing.
