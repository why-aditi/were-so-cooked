# Week 1 spikes

Six throwaway Wrangler projects, one per row of the spike table in section 14 of the
spec. Each answers one question before the real code depends on the answer, and writes
that answer plus its measured numbers to `spikes/<n>/RESULT.md`.

| #   | Question                                                                    | Decides                                          | Neuron cost to run |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| 1   | Can a free account create and query a Vectorize index?                      | Vectorize vs the D1 fallback                     | ~1                 |
| 2   | Photo input tokens on Llama 3.2 Vision; is a licence acceptance needed?     | Photo budget; README setup step                  | ~200               |
| 3   | How reliably does Llama 3.3 70B call tools?                                 | Tool design; whether chat needs a pre-classifier | ~700               |
| 4   | Real neurons per chat turn and per plan                                     | Section 12 caps                                  | ~1,500             |
| 5   | Does `step.waitForEvent` work on the free plan?                             | PhotoScan design                                 | 0 (5 steps)        |
| 6   | Is AI Gateway caching available on the free plan?                           | Demo caching strategy                            | ~20                |

**Running all six costs roughly 2,400 of the 10,000 daily neurons** — about a quarter of
the day's budget. The cap resets at 00:00 UTC. Run them early in the day, and not while
anything else on the account is calling Workers AI.

## Running

```sh
npx wrangler login          # once; these measure a live account
node spikes/run.mjs 4       # one spike
node spikes/run.mjs all     # all six, in order
```

The runner provisions what the spike needs, starts `wrangler dev` with the AI and
Vectorize bindings marked `"remote": true` so they hit real Cloudflare rather than a
local simulation, calls the Worker once, saves the markdown it returns to `RESULT.md`,
and tears down. It reads readiness from wrangler's output, never by calling the Worker:
a spike Worker runs its whole experiment on any request, so an HTTP health probe would
start one experiment per poll. A spike that fails still writes
a `RESULT.md` — a failure is an answer, and for spikes 1, 5 and 6 a refusal is *the*
answer.

### Optional credentials

Spikes 4 and 6 read the account over the REST and GraphQL APIs. Copy the template and
fill it in — the runner loads `spikes/.env` before anything else, and the environment
wins if a variable is set in both:

```sh
cp spikes/.env.example spikes/.env
```

`.env.example` documents where each value comes from. `.env` is gitignored.

Without them:

- **Spike 4** falls back from billed neurons to measured tokens times the published
  rate, and says so in `RESULT.md`. It never invents a neuron figure.
- **Spike 6** cannot create the gateway, so it reports whether an existing one caches.

## Why these are not in the workspace

`pnpm-workspace.yaml` covers `apps/*` and `packages/*` only. The spikes are throwaway by
design (section 14: "a throwaway branch that answers one question"), take no
dependencies, and share nothing with the app but `_lib/report.ts`. Nothing in `apps/` or
`packages/` imports them, and deleting the whole directory after week 1 breaks nothing.

## What each spike deliberately does not cover

| #   | Not covered                                                                                   |
| --- | --------------------------------------------------------------------------------------------- |
| 1   | Index size at 4,800 recipes; this inserts 5 vectors.                                          |
| 2   | Real receipt photographs. Images are synthesised, because tokens scale with pixels, not content. |
| 3   | The `AIChatAgent` Durable Object and streaming layer. This measures the model, not the SDK.   |
| 4   | Sustained load. Three chat turns and one plan, run once.                                      |
| 5   | The 24-hour timeout path, which needs a day to exercise. Needs `wrangler deploy`, not `dev`: Workflows have no remote binding. |
| 6   | Cache behaviour across gateway restarts or TTL expiry.                                        |
