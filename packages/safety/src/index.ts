export { check, exclusionMatches, type CheckOptions, type CheckResult } from './check.js';
export { ALL_DIETS, DIET_RULES, type DietRule } from './diets.js';
export {
  substitute,
  withComputedTags,
  type ProposeRequest,
  type ProposedSwap,
  type Proposer,
  type SubstituteDeps,
  type SubstituteOutcome,
  type SubstitutionRow,
} from './substitute.js';
export {
  createTaxonomy,
  resolveAll,
  type ResolvedIngredient,
  type Taxonomy,
} from './taxonomy.js';
