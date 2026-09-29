# We're So Cooked

**your fridge is chaos. dinner won't be.**

A chat-first, pantry-aware meal planner built entirely on Cloudflare's free tier. It remembers what is in your kitchen, what you can and cannot eat, and what you liked — then plans meals, suggests safe substitutions, and surfaces trending recipes.

Built as the optional fast-track assignment for the Cloudflare Software Engineer application (infrastructure platforms and tooling).

**Live URL:** not deployed yet. `pnpm bootstrap && pnpm deploy:production` stands it up; the URL goes here and in `.github/workflows/main.yml` once it exists.

---

## What it does

Tell it what you bought, in whatever words you use — `2 pyaaz`, `1.5kg aloo`, `a bunch of dhaniya`. Photograph a receipt or an open fridge and tick what it got right. Ask what you can make tonight and get dishes that have already been checked against your allergies and diets. Say "butter chicken but vegan" and get it rebuilt, with each swap explained.

The one thing it will not do is suggest something you cannot eat. That is enforced in code, not in a prompt, and proven by [an eval suite](#evals) that runs on every pull request.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
  browser           │  Worker  (Hono)                      │
  ┌──────────┐      │                                      │
  │ React 19 │─────▶│  /auth/*     GitHub OAuth, sessions  │
  │   SPA    │ HTTP │  /api/*      REST (section 11)       │
  │          │      │  /healthz    D1 + agent + AI probe   │
  │          │      │                                      │
  │          │  WS  │  /agents/kitchen-agent/{userId}      │
  │          │═════▶│      │  session checked here first   │
  └──────────┘      └──────┼───────────────────────────────┘
       ▲                   │ routeAgentRequest
       │                   ▼
       │            ┌──────────────────────────┐
       │  state     │  KitchenAgent  (DO)      │   one per user
       └────────────│  AIChatAgent             │
                    │  ┌────────────────────┐  │
                    │  │ SQLite             │  │   pantry · profile
                    │  │                    │  │   cooking_log · taste
                    │  └────────────────────┘  │   scans · inbox · plans
                    │  10 tools, Zod-validated │
                    └───┬──────────┬───────┬───┘
                        │          │       │
        ┌───────────────┘          │       └──────────────┐
        ▼                          ▼                      ▼
┌───────────────┐        ┌──────────────────┐   ┌──────────────────┐
│ BudgetKeeper  │        │  packages/safety │   │  Workers AI      │
│ (DO, global)  │        │                  │   │                  │
│ reserve →     │        │  check()         │   │  Llama 3.3 70B   │
│ commit        │        │  substitute()    │   │  Gemma 4 26B     │
│ 10k neurons / │        │  pure, no I/O    │   │  Qwen3.8 27B     │
│ rolling 24h   │        │                  │   │  Llama 3.1 8B    │
└───────────────┘        └──────────────────┘   │  bge-m3          │
                                                └──────────────────┘
        ┌──────────────────────────────────────────────┐
        │  D1  cooked-db        users · sessions       │
        │                       ingredients (810)      │
        │                       substitutions (92)     │
        │                       recipes · pipeline_runs│
        ├──────────────────────────────────────────────┤
        │  R2  cooked-uploads   photos, 1-day lifecycle│
        ├──────────────────────────────────────────────┤
        │  Vectorize  recipes   1024-dim, bge-m3       │
        └──────────────────────────────────────────────┘

  Workflows:  PhotoScanWorkflow ✅   WeeklyPlanWorkflow ⬜   ViralRecipesWorkflow ⬜
```

Every user gets one `KitchenAgent` Durable Object, addressed by their user ID. The Worker checks the session on every request and rejects any where the agent name in the URL is not the session's user — that check is the single most important line in the app, and it has [its own test](apps/worker/test/auth.test.ts).

### Repository layout

| Path | What lives there |
| --- | --- |
| `apps/web` | React 19 SPA — landing, chat, and every screen in section 10 |
| `apps/worker` | Hono Worker, `KitchenAgent`, `BudgetKeeper`, Workflows, routes |
| `packages/safety` | The safety engine. Pure TypeScript, no I/O, 90% line coverage |
| `packages/shared` | Zod schemas and API types, shared by both sides of the wire |
| `packages/prompts` | Runtime prompts, versioned `id@vN` |
| `evals/` | Safety eval suite and its committed reports |
| `e2e/` | Playwright, run against a deploy |
| `seed/` | The ingredient taxonomy and swap table, as editable TSV |
| `migrations/` | Numbered D1 migrations |
| `spikes/` | Week 1 spikes, each with measured results |

---

## Setup

Needs Node 22+, pnpm 10+, and a Cloudflare account on the free plan.

```bash
pnpm install

# Creates D1, the Vectorize index, the R2 bucket with its lifecycle rule and
# the AI Gateway, then loads the seed. Safe to run twice.
pnpm bootstrap

# Local: the Worker on :8787, the SPA on :5173 proxying to it.
pnpm --filter @cooked/worker exec wrangler dev
pnpm dev:web
```

Local sign-in uses `DEV_AUTH=true`, which skips GitHub OAuth. CI fails the build if it is ever set for production.

```bash
pnpm typecheck      # tsc -b across every package
pnpm lint
pnpm test           # node pool + workerd pool
pnpm test:worker    # just the workerd integration suite
pnpm vitest run evals   # the safety eval, recorded mode, no neurons
pnpm build:web
```

End-to-end, against any deploy:

```bash
pnpm exec playwright install chromium
E2E_BASE_URL=https://your-preview.workers.dev pnpm exec playwright test
```

---

## Design decisions

**The safety engine is pure and the LLM is untrusted input.**
`packages/safety` does no I/O and calls no model. A model that proposes a substitution is a *proposer*: its suggestion is resolved against the taxonomy, discarded if it is not a real ingredient, and then put through the same `check()` as everything else. The invariant — `substitute` output either passes `check` or is dropped — holds by construction, because the final check is unconditional and a failing result becomes a drop. [Property tests](packages/safety/src/invariant.test.ts) hammer it with random recipes and profiles.

**Safety sobers the interface.**
Section 10 says safety, allergy and data-loss copy stays plain and sentence-case while everything else is lowercase and chaotic. That rule is also visual: playful cards tilt and carry hard offset shadows, and anything with a safety consequence sits square and flat. A card that can cost someone an allergen never looks like a joke. [`apps/web/src/index.css`](apps/web/src/index.css) has both halves.

**Reserve before spending, commit what was spent.**
`BudgetKeeper` is one global Durable Object, so the ledger is single-threaded and two callers cannot both read "room for 900" and both proceed. Callers reserve an estimate, make the call, then commit the real cost from the returned token counts.

**The neuron limit is a rolling window, not a daily reset.**
The dashboard says the 10,000 free neurons reset at 00:00 UTC. They do not. On 2026-09-23 a runaway probe burned 50,583 neurons in an hour; the next morning the GraphQL API reported 0 used "today" and every call still returned `AiError 4006`. The account ceiling is enforced over a rolling 24 hours, and the per-user caps over the UTC day, because the first mirrors a limiter we do not control and the second is our own fairness policy. That is a deliberate divergence from the spec's wording, and [the reasoning is in the code](apps/worker/src/budget/policy.ts).

**Taxonomy first, model only for misses.**
`bought 1kg paneer, 6 eggs and a bunch of dhaniya` resolves entirely from the 810-entry taxonomy with no inference at all. Only names it misses reach the 8B model, batched into one call rather than one per name. The model picks from a shortlist and anything outside the taxonomy is discarded — a hallucinated canonical ID would carry a real allergen set belonging to a different ingredient.

**Taste memory is in the agent's SQLite, not Vectorize.**
At most 300 short memories per user, so a brute-force cosine scan over 1024-dim vectors is cheaper than a round trip and keeps one person's dislikes out of a shared index.

---

## Tradeoffs

**Deliberate shortcuts, and what would change them.**

| Shortcut | Why | When to revisit |
| --- | --- | --- |
| 810 seed ingredients, not the 1,500 the spec asked for | Padding the list would triple the review burden without adding coverage; every entry was checked by hand and the uncertain ones are flagged in [`seed/REVIEW.md`](seed/REVIEW.md) | Section 15 grows the taxonomy from logged unknown ingredients, which is better data than guessing |
| Recipe search is SQL over D1, not Vectorize | Semantic search needs an embedding per recipe, and the only thing that writes those is `ViralRecipesWorkflow` | Both sit behind one `RecipeSearch` interface; swap the implementation when the pipeline lands |
| Four-chars-per-token heuristic for the context window | A real tokenizer is a WASM blob for a number that only has to be right enough to trim on | If a turn ever actually overflows 24K |
| Test compatibility date trails production's | It tracks the workerd bundled with the test pool, which lags | When the pool ships a newer runtime |
| Web bundle is 737 kB (211 kB gzipped) | Almost entirely the Agents and AI SDKs | Code-split before launch |

**Known gaps.** `WeeklyPlanWorkflow` and `ViralRecipesWorkflow` are not built, so the plan and grocery screens render a real empty state rather than a fabricated week, and `POST /api/plans` returns a 502 that says so. Three of section 5's twelve tools depend on those Workflows and are deliberately not registered — a tool the model can call but the server cannot answer is worse than a missing one.

---

## Testing

| Layer | Tooling | Count |
| --- | --- | --- |
| Unit | Vitest, node pool | 540 |
| Property-based | fast-check | 12 properties × 500 runs |
| Integration | `@cloudflare/vitest-pool-workers` | 168, real DO SQLite + D1 + ledger |
| Safety eval | Vitest | 300 cases, zero hard violations |
| End-to-end | Playwright | demo flow, against a deploy |

Workers AI is mocked at the provider seam with `MockLanguageModelV4`, so the SDK's real turn loop, tool dispatch and approval pause all execute — the tests prove the SDK calls our tools, not merely that our tools work when called.

### Evals

```bash
pnpm vitest run evals                                  # recorded, free, runs on every PR
EVAL_LIVE=true EVAL_NEURON_CAP=300 pnpm vitest run evals   # live, capped, manual
```

The recorded cases are **synthetic adversarial fixtures, not transcripts**, and that distinction matters. A recording of a well-behaved model passes because the model behaved, and would keep passing if the safety engine were deleted. Instead each case is the dish a *fully complying* model would return for that profile — the model having done exactly what "just a little peanut butter, my allergy is mild" asked. The bar then measures the only thing that protects anyone.

Verified by mutation: removing the final unconditional `check` in `substitute` fails 217 of 304 cases.

Reports land in [`evals/reports/`](evals/reports/) and are committed.

---

## Observability

Structured JSON on every request and AI call: `requestId`, user ID, route, latency, model, prompt ID and version, token counts, outcome. Errors always logged, everything else sampled at 20%.

`/healthz` probes D1, an agent ping and the AI binding — shallow by default so the hourly synthetic check does not spend neurons, deep with `?deep=1`. `/api/budget` reports neurons left for the user and the account. `/status` lists recent pipeline runs.

---

## Prompt history

[`PROMPTS.md`](PROMPTS.md) records every AI-assisted session. Read its preamble before relying on it: the planning conversation that produced the spec happened outside this repo and its verbatim prompts were not captured at the time.

---

## Licence

Not yet chosen.
