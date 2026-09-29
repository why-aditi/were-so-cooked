import type { Profile, Recipe, SafetyRule, SafetyViolation, Swap } from '@cooked/shared';
import { type CheckOptions, type CheckResult, check } from './check.js';
import { DIET_RULES } from './diets.js';
import { type ResolvedIngredient, type Taxonomy, resolveAll } from './taxonomy.js';

/**
 * `substitute(recipe, profile)` from section 7.
 *
 * The guarantee this file exists to provide:
 *
 *   "for any recipe and profile, the output of `substitute` either passes
 *    `check` or is dropped."
 *
 * That holds *by construction*, not by care: the final `check` at the bottom is
 * unconditional, and a failing result is converted into a drop. No path returns
 * a recipe that has not just been re-checked. A candidate from the LLM, from
 * the table, or from nowhere at all is treated identically — all of them have
 * to survive the same gate.
 */

/** A row of the curated D1 `substitutions` table (section 4). */
export interface SubstitutionRow {
  fromId: string;
  toId: string;
  /** The constraint this swap addresses: a diet, an allergen, or `exclusion:x`. */
  rule: string;
  ratioNote: string | null;
  explanation: string;
}

export interface ProposeRequest {
  ingredient: ResolvedIngredient;
  violations: SafetyViolation[];
  profile: Pick<Profile, 'diets' | 'allergens' | 'exclusions'>;
  /**
   * Section 7 step 3: the LLM is "restricted to taxonomy IDs". Passing the
   * allowed set explicitly means a proposer cannot invent an ingredient, and
   * anything outside it is discarded below regardless.
   */
  allowedIds: string[];
}

export interface ProposedSwap {
  toId: string;
  /**
   * `| undefined` is explicit because the repo runs with
   * `exactOptionalPropertyTypes`, which distinguishes an absent property from
   * one present and undefined. A proposer building objects programmatically
   * hits the second case.
   */
  explanation?: string | undefined;
  /** Technique note. Nullable because the D1 `ratioNote` column is. */
  note?: string | null | undefined;
}

/**
 * Section 7 step 3's LLM fallback, injected rather than imported. The package
 * performs no I/O of its own; the caller supplies this and owns the model call.
 * Its output is never trusted — every proposal goes through the same check as a
 * curated row.
 */
export type Proposer = (req: ProposeRequest) => Promise<ProposedSwap[]>;

export interface SubstituteDeps {
  taxonomy: Taxonomy;
  substitutions: SubstitutionRow[];
  propose?: Proposer;
  checkOptions?: CheckOptions;
}

export type SubstituteOutcome =
  | { dropped: false; recipe: Recipe; swaps: Swap[]; check: CheckResult }
  | { dropped: true; reason: string; check: CheckResult; swaps: Swap[] };

const hard = (v: SafetyViolation): boolean => v.severity === 'hard';

/** Which ingredient names currently have a hard violation against them. */
function offenders(result: CheckResult): Set<string> {
  return new Set(result.violations.filter(hard).map((v) => v.ingredientName));
}

function replaceIngredient(recipe: Recipe, index: number, toId: string, toName: string): Recipe {
  const ingredients = recipe.ingredients.map((ing, i) =>
    i === index ? { ...ing, canonicalId: toId, name: toName } : ing,
  );
  return { ...recipe, ingredients };
}

export async function substitute(
  recipe: Recipe,
  profile: Pick<Profile, 'diets' | 'allergens' | 'exclusions'>,
  deps: SubstituteDeps,
): Promise<SubstituteOutcome> {
  const { taxonomy, checkOptions } = deps;

  // Step 1. If it already passes, the ingredients are returned untouched —
  // but the tags are still recomputed. Section 7's rule that the engine owns
  // `allergenTags` and `dietTags` has no exception for a recipe that happened
  // to pass: an LLM-written recipe claiming `dietTags: ["vegan"]` passes an
  // empty profile untouched, gets stored, and is then served to an actual
  // vegan by a tag filter. Computing them here closes that.
  const initial = check(recipe, profile, taxonomy, checkOptions);
  if (initial.ok) {
    return { dropped: false, recipe: withComputedTags(recipe, taxonomy), swaps: [], check: initial };
  }

  let working = recipe;
  let current = initial;
  const swaps: Swap[] = [];

  // Step 2 and 3, one offending ingredient at a time. Re-checking after each
  // swap matters: fixing one ingredient can create a new problem elsewhere
  // (kosher-style's meat-with-dairy is the obvious case), and a swap that
  // helped locally but broke the dish must not be kept.
  for (let index = 0; index < working.ingredients.length; index += 1) {
    const resolved = resolveAll(working.ingredients, taxonomy)[index] as ResolvedIngredient;
    if (!offenders(current).has(resolved.name)) continue;

    const relevant = current.violations.filter(
      (v) => hard(v) && v.ingredientName === resolved.name,
    );
    const candidates = await candidatesFor(resolved, relevant, profile, deps);

    for (const candidate of candidates) {
      const entry = taxonomy.byId(candidate.toId);
      // A candidate outside the taxonomy cannot be verified, so it cannot be
      // used — the same rule that blocks an unknown ingredient in the original.
      if (!entry) continue;

      const trial = replaceIngredient(working, index, entry.canonicalId, entry.name);
      const trialCheck = check(trial, profile, taxonomy, checkOptions);

      const stillOffends = offenders(trialCheck).has(entry.name);
      const fewerProblems =
        trialCheck.violations.filter(hard).length < current.violations.filter(hard).length;

      // Both conditions, not either. "Fewer problems" alone would accept a swap
      // that trades two violations for one; "no longer offends" alone would
      // accept one that cleans this ingredient and breaks two others.
      if (stillOffends || !fewerProblems) continue;

      swaps.push({
        fromName: resolved.name,
        fromCanonicalId: resolved.canonicalId,
        toName: entry.name,
        toCanonicalId: entry.canonicalId,
        constraint: (relevant[0]?.rule ?? 'vegan') as SafetyRule,
        explanation:
          candidate.explanation ??
          `Swapped ${resolved.name} for ${entry.name} to satisfy your profile.`,
        note: candidate.note ?? null,
      });
      working = trial;
      current = trialCheck;
      break;
    }
  }

  // Step 4. Unconditional. This is the line the invariant rests on.
  const final = check(working, profile, taxonomy, checkOptions);
  if (!final.ok) {
    const reasons = final.violations
      .filter(hard)
      .map((v) => v.message)
      .slice(0, 4);
    return {
      dropped: true,
      reason:
        reasons.length > 0
          ? `Could not make this fit your profile: ${reasons.join(' ')}`
          : 'Could not make this fit your profile.',
      check: final,
      swaps,
    };
  }

  // Step 5. Section 7: tags on a stored recipe are computed by the engine.
  return { dropped: false, recipe: withComputedTags(working, taxonomy), swaps, check: final };
}

/**
 * Curated table first, LLM second (section 7 step 3). Table rows whose `rule`
 * matches a violation come before the rest, so a swap chosen for the right
 * reason is tried before an incidental one.
 */
async function candidatesFor(
  ing: ResolvedIngredient,
  violations: SafetyViolation[],
  profile: Pick<Profile, 'diets' | 'allergens' | 'exclusions'>,
  deps: SubstituteDeps,
): Promise<ProposedSwap[]> {
  const fromId = ing.canonicalId;
  const rows = fromId ? deps.substitutions.filter((r) => r.fromId === fromId) : [];
  const ruleNames = new Set(violations.map((v) => String(v.rule)));

  const ranked = [
    ...rows.filter((r) => ruleNames.has(r.rule)),
    ...rows.filter((r) => !ruleNames.has(r.rule)),
  ];

  const fromTable: ProposedSwap[] = ranked.map((r) => ({
    toId: r.toId,
    explanation: r.explanation,
    note: r.ratioNote,
  }));

  if (fromTable.length > 0 || !deps.propose) return fromTable;

  try {
    const proposed = await deps.propose({
      ingredient: ing,
      violations,
      profile,
      allowedIds: deps.taxonomy.all().map((i) => i.canonicalId),
    });
    return Array.isArray(proposed) ? proposed : [];
  } catch {
    // A failing proposer must not fail the substitution. Without a candidate
    // the recipe gets dropped, which is the safe outcome.
    return [];
  }
}

/**
 * Recomputes `allergenTags` and `dietTags` from the taxonomy.
 *
 * Section 7: "Allergen tags on stored recipes are computed by the engine;
 * LLM-provided tags are discarded." Whatever the input recipe claimed is
 * overwritten here rather than merged.
 */
export function withComputedTags(recipe: Recipe, taxonomy: Taxonomy): Recipe {
  const resolved = resolveAll(recipe.ingredients, taxonomy);
  const allergenTags = [...new Set(resolved.flatMap((r) => r.entry?.allergens ?? []))].sort();

  const dietTags = (Object.keys(DIET_RULES) as (keyof typeof DIET_RULES)[]).filter(
    (diet) =>
      check(recipe, { diets: [diet], allergens: [], exclusions: [] }, taxonomy).ok,
  );

  return { ...recipe, allergenTags, dietTags };
}
