# Evals

Section 13's eval suites. `*.eval.ts` files are picked up by the root vitest config.

```bash
pnpm eval                                              # recorded, free, runs on every PR
EVAL_LIVE=true EVAL_NEURON_CAP=300 pnpm eval           # live, capped, manual
```

Live runs are also a manual GitHub Actions job (`.github/workflows/eval-live.yml`) which checks the account's remaining neurons before it starts and commits the report afterwards.

## Suites

| Suite | Cases | Pass bar | Runs |
| --- | --- | --- | --- |
| `safety/` | 300 profile × request | Zero hard violations | Every PR, recorded. Live on demand |
| Plan quality | 20 profiles | Repeat rate 0, judged coverage | Not built yet |
| Viral extraction | 30 labelled descriptions | 90% ingredient accuracy | Not built yet |
| Photo extraction | 20 labelled photos | 80% precision and recall | Not built — needs labelled photos |

## What "recorded" means here

**The recorded cases are synthetic adversarial fixtures, not transcripts.** That distinction is the whole design, so it is worth stating plainly.

A recording of a real, well-behaved model proves very little. Section 5 already tells the model never to make a safety claim, and spike 3 measured it choosing correctly 24 times out of 24. An eval built on those recordings passes because the model behaved — and would keep passing if `packages/safety` were deleted entirely.

So each case is the model at its **worst** for that specific profile: a dish assembled from exactly the ingredients that profile forbids, drawn from the real seed, as though the model had fully complied with *"just a little peanut butter, my allergy is mild"*. The pass bar then measures the only thing that actually protects anyone, which is the engine downstream of the model.

Three candidates per case:

1. every forbidden ingredient at once,
2. one forbidden ingredient hidden among safe ones — the subtler catch,
3. an ingredient the taxonomy cannot resolve, which section 7 treats as hard for anyone with an allergy.

The offenders are selected from `seed/ingredients.json` by allergen and diet flag rather than hardcoded, so a taxonomy entry that gains an allergen starts appearing in the corpus without anyone editing this suite.

### The control

`safety.eval.ts` checks the raw fixtures *before* the gate and asserts every constrained profile produces at least one genuine violation. Without that, a renamed diet flag would make the corpus harmless and all 300 cases would pass against safe input — reporting a green safety guarantee that had tested nothing.

### Verified by mutation

Removing the final unconditional `check()` in `substitute()` fails **217 of 304** cases. The suite is known to fail when the guarantee is broken, which is the only evidence that a passing run means anything.

## Live mode

Live mode calls Workers AI behind a hard neuron cap (`evals/lib/budget.ts`). The cap is checked *before* each call, not after — a run that notices it overspent has already overspent. During the week 1 spikes a runaway probe burned 50,583 neurons, five times the daily allowance, and blocked every call for a day; that is the failure this exists to prevent.

`evals/lib/budget.ts` is wired, but the live proposer is a stub: a node-pool eval has no Workers AI binding, so a live run needs to go through the deployed Worker. Until that is wired, a live run reports the same numbers as a recorded one — which is why the report records its mode.

## Reports

`evals/reports/` is committed.

- **Recorded** reports carry no timestamp and are byte-for-byte reproducible. CI fails if a run does not reproduce the committed one, which catches an engine or taxonomy change that moved the result without anyone refreshing the baseline.
- **Live** reports are timestamped and kept per run, because each one is evidence about a specific moment and a specific spend.
