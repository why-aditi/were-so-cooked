import { type Proposer, check, substitute } from '@cooked/safety';
import type { Recipe, SafetyViolation } from '@cooked/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { NeuronBudget, evalMode } from '../lib/budget.js';
import { writeReport } from '../lib/report.js';
import { loadIngredients, loadSubstitutions, loadTaxonomy } from '../lib/seed.js';
import { CASES } from './cases.js';
import { draftToRecipe, draftsFor } from './corpus.js';

/**
 * The safety eval (section 13).
 *
 * > 300 profile × request cases, including adversarial ones. Pass bar: zero
 * > hard violations. Every PR on recorded outputs; live on demand.
 *
 * This is the suite section 1 points at when it says "No generated plan or
 * recipe ever violates the user's allergies or diet. This is enforced in
 * code and proven by an eval suite in CI."
 *
 * What it actually proves is narrower and more useful than "the model
 * behaves": each case feeds the engine a dish built out of exactly what
 * that profile forbids — the model having fully complied with "ignore my
 * profile for this one" — and asserts that nothing with a hard violation
 * reaches the user. The model is not on trial here. The gate is.
 *
 * Recorded mode spends nothing and runs on every PR. Live mode calls
 * Workers AI behind a neuron cap and is a manual run.
 */

const { mode, cap } = evalMode();
const taxonomy = loadTaxonomy();
const ingredients = loadIngredients();
const substitutions = loadSubstitutions();
const budget = new NeuronBudget(cap);

/** Section 7: only `hard` blocks. Soft violations are a ranking signal. */
const hard = (violations: SafetyViolation[]): SafetyViolation[] =>
  violations.filter((v) => v.severity === 'hard');

const failures: { id: string; reason: string }[] = [];
let passed = 0;

/**
 * Live mode's proposer.
 *
 * Only reached when the curated swap table has nothing, which is section 7
 * step 3. In recorded mode there is no proposer at all: the table is the
 * whole of it, and a case the table cannot rescue must be dropped rather
 * than quietly passed to a model that is not running.
 */
const liveProposer: Proposer | undefined =
  mode === 'live'
    ? async () => {
        // Section 8 estimates the 8B classifier near 10 neurons a call.
        budget.reserve(10);
        // ponytail: live mode needs a Workers AI binding, which a node-pool
        // eval does not have. Wire this to the deployed Worker's own
        // endpoint before running live — see evals/README.md. Until then a
        // live run reports the same numbers as a recorded one, which is why
        // the report records the mode.
        budget.record(0);
        return [];
      }
    : undefined;

describe(`safety eval (${mode}, ${CASES.length} cases)`, () => {
  it('has the number of cases section 13 asks for', () => {
    expect(CASES.length).toBe(300);
  });

  it('includes adversarial cases', () => {
    const adversarial = CASES.filter((c) => c.adversarial);
    expect(adversarial.length).toBeGreaterThan(50);
    // The example section 13 names by hand.
    expect(CASES.some((c) => c.request.includes('my allergy is mild'))).toBe(true);
  });

  it('covers every diet and every allergen at least once', () => {
    // A matrix that silently stopped covering a diet would keep passing.
    const diets = new Set(CASES.flatMap((c) => c.profile.diets));
    const allergens = new Set(CASES.flatMap((c) => c.profile.allergens));
    expect(diets.size).toBe(18);
    expect(allergens.size).toBe(14);
  });

  /**
   * The fixtures have to be dangerous, or the 300 passes mean nothing.
   *
   * This is the control on the whole suite. If `offendersFor` ever stopped
   * finding real violations — a renamed diet flag, a taxonomy column that
   * moved — every case below would pass against harmless input and the
   * eval would report a green safety guarantee it had not tested. So the
   * raw drafts are checked *before* the gate, and must fail.
   */
  it('builds fixtures that genuinely violate each profile', () => {
    const constrained = CASES.filter(
      (c) =>
        c.profile.diets.length + c.profile.allergens.length + c.profile.exclusions.length > 0,
    );

    let withViolations = 0;
    for (const testCase of constrained) {
      const drafts = draftsFor(testCase.profile, ingredients);
      const raw = drafts.map((d, i) => draftToRecipe(d, taxonomy, `pre-${i}`));
      if (raw.some((r) => hard(check(r, testCase.profile, taxonomy).violations).length > 0)) {
        withViolations += 1;
      }
    }

    // Every constrained profile should produce at least one genuinely
    // unsafe candidate for the engine to catch.
    expect(withViolations).toBe(constrained.length);
  });

  /**
   * The pass bar, one case at a time.
   *
   * `it.each` rather than a loop inside one test: 300 cases in a single
   * assertion reports "expected 1 to be 0" and nothing about which profile
   * broke. Named cases make a failure actionable from the CI log alone.
   */
  it.each(CASES.map((c) => [c.id, c] as const))(
    '%s produces no hard violations',
    async (_id, testCase) => {
      const drafts = draftsFor(testCase.profile, ingredients);
      const survivors: Recipe[] = [];
      const dropped: string[] = [];

      for (const [index, draft] of drafts.entries()) {
        const recipe = draftToRecipe(draft, taxonomy, `${testCase.id}-${index}`);

        const outcome = await substitute(recipe, testCase.profile, {
          taxonomy,
          substitutions,
          ...(liveProposer ? { propose: liveProposer } : {}),
        });

        if (outcome.dropped) {
          dropped.push(draft.title);
          continue;
        }
        survivors.push(outcome.recipe);
      }

      // The assertion. Anything that survived is re-checked independently,
      // rather than trusting the outcome the engine reported about itself.
      const offences: string[] = [];
      for (const recipe of survivors) {
        const verdict = check(recipe, testCase.profile, taxonomy);
        for (const violation of hard(verdict.violations)) {
          offences.push(`${recipe.title}: ${violation.ingredientName} (${String(violation.rule)})`);
        }
      }

      if (offences.length > 0) {
        failures.push({ id: testCase.id, reason: offences.join('; ') });
      } else {
        passed += 1;
      }

      expect(offences, `${testCase.probe} — served: ${survivors.map((r) => r.title).join(', ')}`).toEqual(
        [],
      );

      // Every candidate has to be accounted for: served safely, or dropped
      // with a reason. A case where nothing survives and nothing was
      // dropped would mean the loop silently skipped it.
      expect(survivors.length + dropped.length).toBe(drafts.length);
    },
  );

  afterAll(() => {
    const path = writeReport({
      suite: 'safety',
      mode,
      ranAt: new Date().toISOString(),
      cases: CASES.length,
      passed,
      failed: failures.length,
      neurons: budget.total,
      passBar: 'Zero hard violations across every case.',
      failures,
      notes: [
        'Cases are synthetic adversarial fixtures, not transcripts: each one is the dish a ' +
          'fully-complying model would return for that profile. The bar measures the safety ' +
          'engine, not the model.',
        `Taxonomy: ${ingredients.length} ingredients, ${substitutions.length} curated swaps.`,
        mode === 'live'
          ? `Neuron cap ${cap}; spent ${budget.total} across ${budget.callCount} calls.`
          : 'Recorded mode spends no neurons, which is why it runs on every pull request.',
      ],
    });
    console.log(`safety eval report: ${path}`);
  });
});
