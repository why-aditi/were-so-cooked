import type { Profile, Recipe, SafetyCheck, SafetyRule, SafetyViolation } from '@cooked/shared';
import { DIET_RULES } from './diets.js';
import { type ResolvedIngredient, type Taxonomy, resolveAll } from './taxonomy.js';

/**
 * `check(recipe, profile)` from section 7.
 *
 * Deterministic, synchronous, no I/O. Returns `{ ok, violations[], unknowns[] }`
 * where each violation names the ingredient, the rule and a severity:
 *
 *   hard     allergen, diet or custom exclusion. Blocks the recipe.
 *   unknown  the ingredient does not resolve to the taxonomy. Blocks the
 *            recipe for anyone with a declared allergy; flagged otherwise.
 *   soft     a dislike from taste memory. Never blocks; lowers ranking.
 *
 * `ok` is true only when there are no hard violations. An unresolved
 * ingredient becomes hard the moment the profile lists any allergen, because
 * the engine cannot rule out that the unknown thing contains it — section 7's
 * "anything the engine can't verify is blocked".
 */

export interface CheckOptions {
  /**
   * Dislikes from taste memory (section 4). Produce soft violations only, so a
   * ranking signal can never silently become a safety decision.
   */
  dislikes?: string[];
}

export interface CheckResult extends SafetyCheck {
  /** Non-blocking guidance, e.g. halal's "use halal-certified meat". */
  advisories: string[];
}

const norm = (s: string): string => s.trim().toLowerCase();

function violation(
  ing: ResolvedIngredient,
  rule: SafetyRule,
  severity: SafetyViolation['severity'],
  message: string,
): SafetyViolation {
  return { ingredientName: ing.name, canonicalId: ing.canonicalId, rule, severity, message };
}

/**
 * Does this free-text exclusion match the ingredient?
 *
 * Matches the canonical id, the display name, any alias, and a whole-word
 * substring of the recipe's own wording — so "mushroom" catches "button
 * mushrooms" but "nut" does not catch "nutmeg" or "coconut". Substring
 * matching without the word boundary is how an exclusion engine starts
 * refusing half the catalog.
 */
export function exclusionMatches(exclusion: string, ing: ResolvedIngredient): boolean {
  const needle = norm(exclusion);
  if (!needle) return false;

  const candidates = [ing.name, ing.canonicalId ?? '', ing.entry?.name ?? '', ...(ing.entry?.aliases ?? [])];
  for (const candidate of candidates) {
    const hay = norm(candidate);
    if (!hay) continue;
    if (hay === needle) return true;
    // Whole-word match, tolerating a trailing plural on either side.
    const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
    for (const w of words) {
      if (w === needle || w === `${needle}s` || `${w}s` === needle) return true;
    }
  }
  return false;
}

export function check(
  recipe: Pick<Recipe, 'ingredients'>,
  profile: Pick<Profile, 'diets' | 'allergens' | 'exclusions'>,
  taxonomy: Taxonomy,
  options: CheckOptions = {},
): CheckResult {
  const resolved = resolveAll(recipe.ingredients, taxonomy);
  const violations: SafetyViolation[] = [];
  const unknowns: string[] = [];
  const advisories: string[] = [];

  // An unresolved ingredient is only "flagged" for a user with no allergens.
  // For anyone with one, it is indistinguishable from a hidden allergen.
  const hasAllergens = profile.allergens.length > 0;

  for (const ing of resolved) {
    if (!ing.entry) {
      unknowns.push(ing.name);
      violations.push(
        violation(
          ing,
          // The rule slot wants an allergen, a diet or `exclusion:<term>`.
          // An unknown belongs to no rule, so it is reported against the
          // profile's own uncertainty.
          `exclusion:unknown-ingredient` as SafetyRule,
          hasAllergens ? 'hard' : 'unknown',
          hasAllergens
            ? `"${ing.name}" is not in the ingredient taxonomy and you have allergies recorded, so it is blocked.`
            : `"${ing.name}" is not in the ingredient taxonomy, so it could not be verified.`,
        ),
      );
      continue;
    }

    // 1. Allergens. The highest-consequence rule, so it runs first.
    for (const allergen of profile.allergens) {
      if (ing.entry.allergens.includes(allergen)) {
        violations.push(
          violation(ing, allergen, 'hard', `${ing.name} contains ${allergen.replace('_', ' ')}.`),
        );
      }
    }

    // 2. Custom exclusions, enforced exactly like an allergen (section 7).
    for (const exclusion of profile.exclusions) {
      if (exclusionMatches(exclusion, ing)) {
        violations.push(
          violation(
            ing,
            `exclusion:${exclusion}` as SafetyRule,
            'hard',
            `${ing.name} matches your exclusion "${exclusion}".`,
          ),
        );
      }
    }

    // 3. Diets. Every diet in the profile must be satisfied.
    for (const diet of profile.diets) {
      const rule = DIET_RULES[diet];
      if (!rule) continue;

      const blocked = rule.blockedFlags.filter((f) => ing.entry?.dietFlags.includes(f));
      if (blocked.length > 0) {
        violations.push(
          violation(ing, diet, 'hard', `${ing.name} is ${blocked.join(' and ')}, not ${rule.label}.`),
        );
      }

      const conditional = rule.ingredientRule?.(ing);
      if (conditional) {
        violations.push(violation(ing, diet, 'hard', `${ing.name} is ${conditional} (${rule.label}).`));
      }
    }
  }

  // 4. Whole-recipe diet rules, e.g. kosher-style's meat-with-dairy.
  for (const diet of profile.diets) {
    const rule = DIET_RULES[diet];
    if (!rule) continue;
    for (const found of rule.recipeRule?.(resolved) ?? []) {
      violations.push({
        ingredientName: found.ingredientName,
        canonicalId: resolved.find((r) => r.name === found.ingredientName)?.canonicalId ?? null,
        rule: diet,
        severity: 'hard',
        message: `${found.ingredientName}: ${found.reason}.`,
      });
    }
    const advisory = rule.advisory?.(resolved);
    if (advisory) advisories.push(advisory);
  }

  // 5. Taste-memory dislikes. Soft: they rank a recipe down, never block it.
  for (const dislike of options.dislikes ?? []) {
    for (const ing of resolved) {
      if (exclusionMatches(dislike, ing)) {
        violations.push(
          violation(
            ing,
            `exclusion:${dislike}` as SafetyRule,
            'soft',
            `${ing.name} is something you said you dislike.`,
          ),
        );
      }
    }
  }

  return {
    ok: !violations.some((v) => v.severity === 'hard'),
    violations,
    unknowns,
    advisories,
  };
}
