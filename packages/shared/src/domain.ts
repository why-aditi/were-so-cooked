import { z } from 'zod';

/* ------------------------------- primitives ------------------------------ */

export const Id = z.string().min(1).max(128);
/** ISO 8601 instant, e.g. 2026-09-23T04:00:00Z. */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Calendar date, YYYY-MM-DD. Used for week starts and plan days. */
export const IsoDate = z.iso.date();
/** IANA zone captured from the browser at sign-in (section 5). */
export const TimeZone = z.string().min(1).max(64);

/* ---------------------------------- enums --------------------------------- */

/** The 14 EU allergens, which already include sesame (section 7). */
export const Allergen = z.enum([
  'milk',
  'egg',
  'fish',
  'crustaceans',
  'molluscs',
  'peanuts',
  'tree_nuts',
  'gluten',
  'soy',
  'sesame',
  'mustard',
  'celery',
  'lupin',
  'sulphites',
]);
export type Allergen = z.infer<typeof Allergen>;

/** Every diet in the section 7 table. Diets combine; a recipe must satisfy all. */
export const Diet = z.enum([
  'vegetarian',
  'eggetarian',
  'ovo_vegetarian',
  'lacto_vegetarian',
  'vegan',
  'jain',
  'sattvic',
  'pescatarian',
  'halal',
  'kosher_style',
  'no_beef',
  'no_pork',
  'gluten_free',
  'dairy_free',
  'keto_friendly',
  'paleo',
  'low_fodmap',
  'navratri',
]);
export type Diet = z.infer<typeof Diet>;

/**
 * Flags carried by a taxonomy entry. Diet rules are predicates over these, so
 * the set is closed: a new diet must be expressible in existing flags or add one.
 */
export const IngredientFlag = z.enum([
  'meat',
  'poultry',
  'pork',
  'beef',
  'fish',
  'shellfish',
  'egg',
  'dairy',
  'honey',
  'animal_derived',
  'alcohol',
  'allium',
  'root',
  'grain',
  'gluten',
  'legume',
  'nut',
  'refined_sugar',
  'starchy',
  'high_fodmap',
  'vrat_ok',
]);
export type IngredientFlag = z.infer<typeof IngredientFlag>;

export const IngredientCategory = z.enum([
  'produce',
  'dairy',
  'meat',
  'seafood',
  'grains',
  'legumes',
  'spices',
  'condiments',
  'bakery',
  'frozen',
  'beverages',
  'sweets',
  'other',
]);
export type IngredientCategory = z.infer<typeof IngredientCategory>;

// ponytail: fixed unit list, because the grocery diff merges "by canonical
// ingredient and unit" (section 6) and free-text units would never merge.
// Add a unit here rather than letting one in through parsing.
export const Unit = z.enum([
  'g',
  'kg',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'cup',
  'piece',
  'bunch',
  'packet',
  'pinch',
  'to_taste',
]);
export type Unit = z.infer<typeof Unit>;

export const SpiceLevel = z.enum(['none', 'mild', 'medium', 'hot']);
export type SpiceLevel = z.infer<typeof SpiceLevel>;

/* ---------------------------- taxonomy & safety --------------------------- */

/** A row of the shared D1 `ingredients` taxonomy. */
export const Ingredient = z.object({
  canonicalId: Id,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  category: IngredientCategory,
  /**
   * The unit to record when a phrase names this ingredient without one.
   * "dhaniya" is a bunch, "milk" is a litre, "paneer" is grams. A per-category
   * guess cannot tell coriander from a carrot, so it lives per ingredient.
   */
  defaultUnit: Unit,
  defaultShelfDays: z.number().int().positive().nullable(),
  allergens: z.array(Allergen),
  dietFlags: z.array(IngredientFlag),
});
export type Ingredient = z.infer<typeof Ingredient>;

/** An ingredient as it appears inside a recipe or plan entry. */
export const RecipeIngredient = z.object({
  canonicalId: Id.nullable(),
  name: z.string().min(1),
  quantity: z.number().positive().nullable(),
  unit: Unit.nullable(),
  note: z.string().nullable(),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredient>;

export const SafetySeverity = z.enum(['hard', 'unknown', 'soft']);
export type SafetySeverity = z.infer<typeof SafetySeverity>;

/** What a check broke: an allergen, a diet, or a custom `exclusion:<term>`. */
export const SafetyRule = z.union([Allergen, Diet, z.templateLiteral(['exclusion:', z.string()])]);
export type SafetyRule = z.infer<typeof SafetyRule>;

export const SafetyViolation = z.object({
  ingredientName: z.string(),
  canonicalId: Id.nullable(),
  rule: SafetyRule,
  severity: SafetySeverity,
  message: z.string(),
});
export type SafetyViolation = z.infer<typeof SafetyViolation>;

/** Return shape of `check(recipe, profile)` (section 7). */
export const SafetyCheck = z.object({
  ok: z.boolean(),
  violations: z.array(SafetyViolation),
  /** Ingredient names that did not resolve to the taxonomy. */
  unknowns: z.array(z.string()),
});
export type SafetyCheck = z.infer<typeof SafetyCheck>;

/** One replacement made by `substitute(recipe, profile)`. */
export const Swap = z.object({
  fromName: z.string(),
  fromCanonicalId: Id.nullable(),
  toName: z.string(),
  toCanonicalId: Id.nullable(),
  /** The rule that forced the swap. */
  constraint: SafetyRule,
  explanation: z.string(),
  /** Technique note, e.g. "Press tofu 20 minutes before marinating". */
  note: z.string().nullable(),
});
export type Swap = z.infer<typeof Swap>;

/* --------------------------------- profile -------------------------------- */

/** The single `profile` row in the user's KitchenAgent SQLite. */
export const Profile = z.object({
  diets: z.array(Diet),
  allergens: z.array(Allergen),
  /** Free-text exclusions such as "coriander"; enforced like an allergen. */
  exclusions: z.array(z.string().min(1)),
  /** Preferred cuisines. Empty means any cuisine. */
  cuisines: z.array(z.string().min(1)),
  maxCookMinutes: z.number().int().min(5).max(480),
  servings: z.number().int().min(1).max(20),
  spiceLevel: SpiceLevel,
  timeZone: TimeZone,
  updatedAt: IsoDateTime,
});
export type Profile = z.infer<typeof Profile>;

/** What a client may send. `updatedAt` is server-owned. */
export const ProfileInput = Profile.omit({ updatedAt: true });
export type ProfileInput = z.infer<typeof ProfileInput>;

/* --------------------------------- pantry --------------------------------- */

export const QuantityConfidence = z.enum(['exact', 'approx']);
export type QuantityConfidence = z.infer<typeof QuantityConfidence>;

export const ExpirySource = z.enum(['estimated', 'user', 'label']);
export type ExpirySource = z.infer<typeof ExpirySource>;

export const PantryItemSource = z.enum(['chat', 'photo', 'manual']);
export type PantryItemSource = z.infer<typeof PantryItemSource>;

export const PantryItem = z.object({
  id: Id,
  canonicalId: Id.nullable(),
  displayName: z.string().min(1),
  category: IngredientCategory,
  quantity: z.number().nonnegative(),
  unit: Unit,
  qtyConfidence: QuantityConfidence,
  addedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  expirySource: ExpirySource,
  source: PantryItemSource,
  /** Soft delete keeps history for undo (section 4). */
  deletedAt: IsoDateTime.nullable(),
});
export type PantryItem = z.infer<typeof PantryItem>;

/** A structured item a client may add directly, skipping free-text parsing. */
export const PantryItemInput = PantryItem.omit({
  id: true,
  addedAt: true,
  deletedAt: true,
}).partial({
  canonicalId: true,
  category: true,
  qtyConfidence: true,
  expiresAt: true,
  expirySource: true,
  source: true,
});
export type PantryItemInput = z.infer<typeof PantryItemInput>;

export const PantryItemPatch = PantryItemInput.partial();
export type PantryItemPatch = z.infer<typeof PantryItemPatch>;

/* --------------------------------- recipes -------------------------------- */

export const RecipeSource = z.enum(['seed', 'llm', 'youtube']);
export type RecipeSource = z.infer<typeof RecipeSource>;

export const Recipe = z.object({
  id: Id,
  source: RecipeSource,
  title: z.string().min(1),
  cuisine: z.string().min(1),
  ingredients: z.array(RecipeIngredient),
  /** Empty until the user opens the recipe; steps are generated on first open. */
  steps: z.array(z.string()),
  minutes: z.number().int().positive(),
  servings: z.number().int().positive(),
  /** Always computed by the safety engine. LLM-provided tags are discarded. */
  dietTags: z.array(Diet),
  allergenTags: z.array(Allergen),
  sourceUrl: z.url().nullable(),
  creator: z.string().nullable(),
  thumbnailUrl: z.url().nullable(),
  trendingUntil: IsoDateTime.nullable(),
  contentHash: z.string(),
  createdAt: IsoDateTime,
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * What a model is allowed to return when it invents a recipe (section 8:
 * "Every non-chat call returns JSON validated against a Zod schema in
 * `packages/shared`").
 *
 * Note what is missing: `dietTags`, `allergenTags` and `id`. Section 7 is
 * explicit that "allergen tags on stored recipes are computed by the engine;
 * LLM-provided tags are discarded", so the schema does not accept them at
 * all. A model cannot claim a dish is vegan here, only list what is in it —
 * and the engine decides what that means.
 *
 * Ingredient names are free text on purpose. Section 8: "Recipes generated by
 * the model use taxonomy IDs where it can; free-text ingredient names go
 * through normalization before `check`." Listing 800 canonical IDs in the
 * prompt would cost more tokens than the recipe.
 */
export const RecipeDraft = z.object({
  title: z.string().min(1).max(120),
  cuisine: z.string().min(1).max(40),
  minutes: z.number().int().positive().max(600),
  servings: z.number().int().positive().max(20),
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        quantity: z.number().positive().nullable().default(null),
        unit: Unit.nullable().default(null),
        note: z.string().max(200).nullable().default(null),
      }),
    )
    .min(1)
    .max(30),
  steps: z.array(z.string().min(1).max(600)).max(25).default([]),
});
export type RecipeDraft = z.infer<typeof RecipeDraft>;

/**
 * Result of `substitute`. The section 7 invariant is encoded in the type: a
 * returned recipe always carries the `check` that proves it passes, and a
 * dropped recipe carries the reason instead.
 */
export const SubstituteResult = z.discriminatedUnion('dropped', [
  z.object({
    dropped: z.literal(false),
    recipe: Recipe,
    swaps: z.array(Swap),
    check: SafetyCheck,
  }),
  z.object({
    dropped: z.literal(true),
    reason: z.string(),
    check: SafetyCheck,
  }),
]);
export type SubstituteResult = z.infer<typeof SubstituteResult>;

/* ----------------------------- plans & grocery ---------------------------- */

export const MealSlot = z.enum(['breakfast', 'lunch', 'dinner', 'treat']);
export type MealSlot = z.infer<typeof MealSlot>;

export const PlanStatus = z.enum(['queued', 'running', 'ready', 'failed']);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PlanMeal = z.object({
  slot: MealSlot,
  /** Null for a dish the planner proposed that is not in the catalog yet. */
  recipeId: Id.nullable(),
  title: z.string().min(1),
  ingredients: z.array(RecipeIngredient),
  minutes: z.number().int().positive(),
  /** 0-1: how much of this meal the pantry already covers. */
  pantryCoverage: z.number().min(0).max(1),
  swaps: z.array(Swap),
});
export type PlanMeal = z.infer<typeof PlanMeal>;

export const PlanDay = z.object({
  date: IsoDate,
  meals: z.array(PlanMeal),
});
export type PlanDay = z.infer<typeof PlanDay>;

export const Plan = z.object({
  id: Id,
  weekStart: IsoDate,
  status: PlanStatus,
  workflowId: Id.nullable(),
  /** Which slots the user left switched on for this plan. */
  slots: z.array(MealSlot).min(1),
  cuisines: z.array(z.string().min(1)),
  days: z.array(PlanDay),
  createdAt: IsoDateTime,
});
export type Plan = z.infer<typeof Plan>;

export const GroceryItem = z.object({
  id: Id,
  planId: Id,
  canonicalId: Id.nullable(),
  name: z.string().min(1),
  quantity: z.number().positive(),
  unit: Unit,
  checked: z.boolean(),
});
export type GroceryItem = z.infer<typeof GroceryItem>;

/* ------------------------------- photo scans ------------------------------ */

export const ScanStatus = z.enum(['processing', 'awaiting_confirm', 'done', 'failed']);
export type ScanStatus = z.infer<typeof ScanStatus>;

export const ScanItem = z.object({
  name: z.string().min(1),
  canonicalId: Id.nullable(),
  quantity: z.number().positive().nullable(),
  unit: Unit.nullable(),
  /** Vision-model confidence; below 0.5 the UI shows the row unticked. */
  confidence: z.number().min(0).max(1),
  /** Printed expiry date read off the packaging, if any. */
  expiresAt: IsoDateTime.nullable(),
  selected: z.boolean(),
});
export type ScanItem = z.infer<typeof ScanItem>;

export const Scan = z.object({
  id: Id,
  workflowId: Id.nullable(),
  r2Key: z.string(),
  status: ScanStatus,
  items: z.array(ScanItem),
  createdAt: IsoDateTime,
  error: z.string().nullable(),
});
export type Scan = z.infer<typeof Scan>;

/* --------------------------- inbox & taste memory ------------------------- */

export const InboxKind = z.enum(['expiry', 'tonight', 'plan_ready', 'trending', 'system']);
export type InboxKind = z.infer<typeof InboxKind>;

export const InboxItem = z.object({
  id: Id,
  kind: InboxKind,
  title: z.string().min(1),
  body: z.string(),
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
  /** Stops repeat nudges for the same item (section 4). */
  dedupeKey: z.string(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const TasteMemoryKind = z.enum(['like', 'dislike', 'note']);
export type TasteMemoryKind = z.infer<typeof TasteMemoryKind>;

// ponytail: the Float32 `embedding` BLOB is deliberately absent. It never
// crosses the wire; cosine search happens inside the agent (section 4).
export const TasteMemory = z.object({
  id: Id,
  text: z.string().min(1),
  kind: TasteMemoryKind,
  /**
   * The thing the memory is about: a taxonomy id where one resolves, else the
   * raw ingredient name. Separate from `text` because `text` is prose the
   * model wrote ("hates mushrooms in a creamy sauce") and section 7's soft
   * violations need something matchable against a recipe's ingredients.
   * Null for a memory about a dish or a technique rather than an ingredient.
   */
  subject: z.string().nullable(),
  recipeId: Id.nullable(),
  weight: z.number().min(0).max(1),
  createdAt: IsoDateTime,
});
export type TasteMemory = z.infer<typeof TasteMemory>;

/* --------------------------- cooking log & users -------------------------- */

export const DeductedItem = z.object({
  pantryItemId: Id,
  canonicalId: Id.nullable(),
  name: z.string(),
  quantity: z.number(),
  unit: Unit,
});
export type DeductedItem = z.infer<typeof DeductedItem>;

export const CookingLogEntry = z.object({
  id: Id,
  recipeId: Id.nullable(),
  recipeTitle: z.string().min(1),
  cookedAt: IsoDateTime,
  deducted: z.array(DeductedItem),
});
export type CookingLogEntry = z.infer<typeof CookingLogEntry>;

export const User = z.object({
  id: Id,
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  isDemo: z.boolean(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

/** A row of D1 `pipeline_runs`, shown on the pipeline status page. */
export const PipelineRun = z.object({
  id: Id,
  workflow: z.string(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  status: z.enum(['running', 'ok', 'failed']),
  found: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
  extracted: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  neurons: z.number().nonnegative(),
  errors: z.array(z.string()),
});
export type PipelineRun = z.infer<typeof PipelineRun>;
