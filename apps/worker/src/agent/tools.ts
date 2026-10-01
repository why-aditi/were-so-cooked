import {
  Allergen,
  Diet,
  MealSlot,
  type PantryItem,
  type Profile,
  type Recipe,
  type Swap,
  type TasteMemory,
  Unit,
} from '@cooked/shared';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type {
  SubstituteRequest,
  SubstituteToolOutcome,
  SuggestOutcome,
  SuggestRequest,
} from '../recipes/suggest.js';
import { PLAN_STEPS, type PlanView } from '../plan/record.js';
import type { RequiredIngredient } from './deduct.js';

/**
 * The section 5 tools, as AI SDK tools the `AIChatAgent` turn registers.
 *
 * Three things are deliberate here.
 *
 * The descriptions are prompt text. Spike 3 measured 24/24 correct tool
 * choice against wording close to this, so editing one is a change to model
 * behaviour, not a comment tidy-up.
 *
 * `needsApproval` is the AI SDK's own human-in-the-loop flag, so the pause is
 * the SDK's rather than something this codebase reimplements: the tool call
 * is persisted in `approval-requested` state, the client renders Approve /
 * Reject, and `execute` runs only after the client sends the approval back.
 * The two gated tools are section 5's two: `log_cooked` and `update_profile`.
 *
 * Tools talk to `PantryOps`, not to the Durable Object, so a turn can be
 * tested against a fake kitchen with a mocked model.
 *
 * Every section 5 tool is here.
 */

/* ------------------------------ what a tool sees ---------------------------- */

export interface PantryOps {
  addPantryItems(
    text: string,
    options?: { source?: 'chat' | 'photo' | 'manual' },
  ): Promise<{ added: PantryItem[]; unresolved: string[]; modelCalled: boolean }>;
  listPantry(options?: {
    expiringWithinDays?: number;
    includeDeleted?: boolean;
  }): Promise<PantryItem[]>;
  updatePantryItem(
    id: string,
    patch: Partial<{
      displayName: string;
      quantity: number;
      unit: z.infer<typeof Unit>;
      expiresAt: string | null;
    }>,
  ): Promise<PantryItem | null>;
  removePantryItems(ids: string[]): Promise<{ removed: string[] }>;
  restorePantryItems(ids: string[]): Promise<{ restored: string[] }>;
  previewCooked(recipe: {
    title: string;
    ingredients: RequiredIngredient[];
    servingsMultiplier?: number;
  }): Promise<{ recipeTitle: string; summary: string[] }>;
  logCooked(recipe: {
    recipeId?: string | null;
    title: string;
    ingredients: RequiredIngredient[];
    servingsMultiplier?: number;
  }): Promise<{ logId: string; plan: unknown; pantry: PantryItem[] }>;
  getProfile(): Promise<Profile>;
  setProfile(profile: Omit<Profile, 'updatedAt'>): Promise<Profile>;
  findRecipe(
    idOrTitle: string,
  ): Promise<{ id: string; title: string; ingredients: RequiredIngredient[] } | null>;
  suggestRecipes(req: Omit<SuggestRequest, 'pantry' | 'profile'>): Promise<SuggestOutcome>;
  substituteRecipe(req: SubstituteRequest): Promise<SubstituteToolOutcome>;
  rememberTaste(memory: {
    text: string;
    kind: TasteMemory['kind'];
    subject?: string | null;
    recipeId?: string | null;
  }): Promise<TasteMemory>;
  startWeeklyPlan(options?: {
    weekStart?: string | undefined;
    slots?: MealSlot[] | undefined;
    cuisines?: string[] | undefined;
  }): Promise<{ planId: string; weekStart: string; alreadyRunning: boolean }>;
  currentPlan(): Promise<PlanView | null>;
  groceryItems(): Promise<
    {
      id: string;
      displayName: string;
      category: string;
      quantity: number | null;
      unit: string | null;
      checked: boolean;
    }[]
  >;
  checkGroceryItem(itemId: string, checked: boolean): Promise<{ id: string; checked: boolean } | null>;
  searchTrending(req: { query?: string | undefined; limit?: number | undefined }): Promise<{
    results: {
      recipe: Recipe;
      swaps: Swap[];
      have: string[];
      missing: string[];
      /** The safety engine's warnings, passed through as suggest_recipes does. */
      advisories: string[];
    }[];
    hidden: { title: string; reason: string }[];
  }>;
}

/* --------------------------------- schemas --------------------------------- */

/**
 * An optional number that takes Llama 3.3 as it is.
 *
 * It sends numeric arguments as strings — `"count": "4"` in production — and a
 * strict schema turned that into a tool error and a wasted step. It also fills
 * optional arguments it does not mean to set with `null` or `""`, which must
 * read as "not given": `z.coerce.number()` made them 0, so renaming a pantry
 * item would have zeroed its quantity. Anything else non-numeric is still
 * rejected, and the JSON schema the model sees is the plain number.
 */
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;
export const optionalNumber = (n: z.ZodNumber) =>
  z.preprocess(
    (v) => (v === null || v === '' ? undefined : typeof v === 'string' && NUMERIC.test(v) ? Number(v) : v),
    n.optional(),
  );

export const AddArgs = z.object({
  text: z
    .string()
    .min(1)
    .describe('The raw phrase describing what was bought, e.g. "1kg paneer and 6 eggs".'),
});

export const ListArgs = z.object({
  expiring_within_days: optionalNumber(z.number().positive().max(365)).describe(
    'Only return items expiring within this many days.',
  ),
});

export const UpdateArgs = z.object({
  id: z.string().min(1).describe('The pantry item id from an earlier tool result.'),
  display_name: z.string().min(1).optional(),
  quantity: optionalNumber(z.number().nonnegative()),
  unit: Unit.optional(),
  expires_at: z.iso.datetime().optional().describe('ISO date. Marks the expiry as user-set.'),
});

export const IdsArgs = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50).describe('Ids from an earlier tool result.'),
});

export const CookedArgs = z.object({
  recipe_id: z.string().min(1).optional().describe('From an earlier suggestion, if there was one.'),
  recipe_title: z.string().min(1),
  servings: optionalNumber(z.number().positive().max(50)).describe('Multiplies the recipe quantities.'),
});

export const ProfileArgs = z.object({
  diets: z.array(Diet).optional(),
  allergens: z.array(Allergen).optional(),
  exclusions: z.array(z.string().min(1)).optional(),
  cuisines: z.array(z.string().min(1)).optional(),
  max_cook_minutes: optionalNumber(z.number().int().positive().max(600)),
  servings: optionalNumber(z.number().int().positive().max(20)),
  spice_level: z.enum(['none', 'mild', 'medium', 'hot']).optional(),
});

export const SuggestArgs = z.object({
  // Empty is allowed: Llama sends "" for "what can I make", and an empty
  // query is what the 17:00 tonight-suggestion already uses to mean anything
  // the pantry covers.
  query: z
    .string()
    .max(300)
    .describe('What they asked for, e.g. "something korean" or "use up the palak". Empty for anything.'),
  max_minutes: optionalNumber(z.number().int().positive().max(600)),
  count: optionalNumber(z.number().int().positive().max(6)).describe('How many to propose. Default 4.'),
});

export const SubstituteArgs = z.object({
  recipe_id: z.string().min(1).optional(),
  recipe_title: z.string().min(1).max(200),
  diets: z
    .array(Diet)
    .optional()
    .describe('Extra diets for this dish only, e.g. vegan in "butter chicken but vegan".'),
  allergens: z.array(Allergen).optional(),
  avoid: z.array(z.string().min(1)).optional().describe('Extra ingredients to keep out.'),
});

export const RememberArgs = z.object({
  text: z.string().min(1).max(300).describe('One short sentence in your own words.'),
  kind: z.enum(['like', 'dislike', 'note']),
  subject: z
    .string()
    .min(1)
    .optional()
    .describe('The single ingredient it is about, if it is about one. Omit otherwise.'),
  recipe_id: z.string().min(1).optional(),
});

export const PlanArgs = z.object({
  week_start: z.iso
    .date()
    .optional()
    .describe('First day of the plan, YYYY-MM-DD. Omit to start today.'),
  slots: z
    .array(MealSlot)
    .min(1)
    .optional()
    .describe('Meals to plan. Omit for all four: breakfast, lunch, dinner and treat.'),
  cuisines: z
    .array(z.string().min(1))
    .optional()
    .describe('Only when the user limits the week to particular cuisines.'),
});

export const CheckGroceryArgs = z.object({
  item_id: z.string().min(1).describe('The id from a get_grocery_list result.'),
  checked: z.boolean().describe('True once bought; false to put it back on the list.'),
});

export const TrendingArgs = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('A dish, ingredient or cuisine to narrow to. Omit for the top of the week.'),
  count: optionalNumber(z.number().int().positive().max(10)).describe('How many. Default 5.'),
});

/** Every gated tool's args, for re-validating an approval before it runs. */
export const APPROVAL_ARGS: Record<string, z.ZodTypeAny> = {
  log_cooked: CookedArgs,
  update_profile: ProfileArgs,
};

/* --------------------------------- helpers --------------------------------- */

/** Only what the model needs. Full rows would eat the context window. */
function brief(i: PantryItem) {
  return {
    id: i.id,
    name: i.displayName,
    quantity: i.quantity,
    unit: i.unit,
    expires: i.expiresAt,
    approximate: i.qtyConfidence !== 'exact' || i.expirySource === 'estimated',
  };
}

/**
 * Ingredients come from the catalog, never from the model.
 *
 * The model knows the title; it does not know how much paneer the recipe
 * calls for, and a guessed quantity silently corrupts the pantry. A recipe
 * that is not in the catalog is logged with no deduction and says so.
 */
export async function resolveCooked(
  ops: PantryOps,
  a: z.infer<typeof CookedArgs>,
): Promise<{ recipeId: string | null; title: string; ingredients: RequiredIngredient[] }> {
  const found = await ops.findRecipe(a.recipe_id ?? a.recipe_title);
  if (found) return { recipeId: found.id, title: found.title, ingredients: found.ingredients };
  return { recipeId: null, title: a.recipe_title, ingredients: [] };
}

/**
 * A partial patch, not a replacement.
 *
 * The model sends only what changes, so a turn about going vegan must not be
 * able to clear an allergy set months ago. Every absent field keeps its
 * stored value.
 */
export async function patchedProfile(
  ops: PantryOps,
  a: z.infer<typeof ProfileArgs>,
): Promise<Omit<Profile, 'updatedAt'>> {
  const current = await ops.getProfile();
  return {
    diets: a.diets ?? current.diets,
    allergens: a.allergens ?? current.allergens,
    exclusions: a.exclusions ?? current.exclusions,
    cuisines: a.cuisines ?? current.cuisines,
    maxCookMinutes: a.max_cook_minutes ?? current.maxCookMinutes,
    servings: a.servings ?? current.servings,
    spiceLevel: a.spice_level ?? current.spiceLevel,
    timeZone: current.timeZone,
  };
}

/* ------------------------------ approval cards ------------------------------ */

/**
 * What the Approve / Reject card says.
 *
 * Computed when the card is rendered rather than when the model called the
 * tool, because the pantry can move while the card is open — the agent
 * exposes this over RPC and the UI asks for it at render time. The same
 * recomputation happens again inside `execute`, so an approved card can never
 * apply a deduction that was planned against a pantry that has since changed.
 */
export async function approvalSummary(
  ops: PantryOps,
  toolName: string,
  rawInput: unknown,
): Promise<string[]> {
  if (toolName === 'log_cooked') {
    const a = CookedArgs.parse(rawInput);
    const r = await resolveCooked(ops, a);
    if (r.ingredients.length === 0) {
      return [`${r.title}: logged, but nothing deducted — this recipe is not in the catalog.`];
    }
    const { summary } = await ops.previewCooked({
      title: r.title,
      ingredients: r.ingredients,
      ...(a.servings !== undefined ? { servingsMultiplier: a.servings } : {}),
    });
    return summary;
  }

  if (toolName === 'update_profile') {
    const a = ProfileArgs.parse(rawInput);
    const before = await ops.getProfile();
    const after = await patchedProfile(ops, a);
    const lines: string[] = [];
    const diff = (label: string, from: string, to: string) => {
      if (from !== to) lines.push(`${label}: ${from || 'none'} -> ${to || 'none'}`);
    };
    diff('Allergens', before.allergens.join(', '), after.allergens.join(', '));
    diff('Diets', before.diets.join(', '), after.diets.join(', '));
    diff('Will not eat', before.exclusions.join(', '), after.exclusions.join(', '));
    diff('Cuisines', before.cuisines.join(', '), after.cuisines.join(', '));
    diff('Servings', String(before.servings), String(after.servings));
    diff('Time limit', `${before.maxCookMinutes} min`, `${after.maxCookMinutes} min`);
    diff('Spice', before.spiceLevel, after.spiceLevel);

    // Losing an allergen is the change worth spelling out, because it is the
    // one the user cannot detect later by looking at a recipe.
    const dropped = before.allergens.filter((x) => !after.allergens.includes(x));
    if (dropped.length > 0) {
      lines.push(
        `This removes ${dropped.join(' and ')} from your allergy list. Recipes containing ` +
          'them will no longer be hidden.',
      );
    }
    return lines.length > 0 ? lines : ['Nothing would change.'];
  }

  return ['This needs your confirmation.'];
}

/* ---------------------------------- tools ---------------------------------- */

export function buildTools(ops: PantryOps): ToolSet {
  return {
    add_pantry_items: tool({
      description:
        'Add newly bought ingredients to the pantry. Use when the user says they bought, got or ' +
        'now have food. Pass their phrase through whole — do not parse names, quantities or ' +
        'units yourself; the normalizer handles Hindi names, vague amounts and fractions.',
      inputSchema: AddArgs,
      execute: async (a) => {
        const r = await ops.addPantryItems(a.text, { source: 'chat' });
        return { added: r.added.map(brief), unverified: r.unresolved };
      },
    }),

    list_pantry: tool({
      description:
        'Read the pantry, optionally only items expiring within a number of days. Call this ' +
        'rather than asking the user what they have, and rather than guessing from earlier in ' +
        'the chat.',
      inputSchema: ListArgs,
      execute: async (a) => {
        const items = await ops.listPantry(
          a.expiring_within_days === undefined
            ? {}
            : { expiringWithinDays: a.expiring_within_days },
        );
        return { count: items.length, items: items.map(brief) };
      },
    }),

    update_pantry_item: tool({
      description:
        'Correct one pantry item: its name, quantity, unit or expiry date. Use when the user ' +
        'says an estimate was wrong. The id comes from a list_pantry or add_pantry_items result.',
      inputSchema: UpdateArgs,
      execute: async (a) => {
        const updated = await ops.updatePantryItem(a.id, {
          ...(a.display_name !== undefined ? { displayName: a.display_name } : {}),
          ...(a.quantity !== undefined ? { quantity: a.quantity } : {}),
          ...(a.unit !== undefined ? { unit: a.unit } : {}),
          ...(a.expires_at !== undefined ? { expiresAt: a.expires_at } : {}),
        });
        if (!updated) return { ok: false, reason: 'No pantry item with that id.' };
        return { ok: true, item: brief(updated) };
      },
    }),

    remove_pantry_items: tool({
      description:
        'Remove items from the pantry: used up, thrown away, or added by mistake. Not for a ' +
        'cooked meal — use log_cooked for that, which deducts the right amounts. Can be undone.',
      inputSchema: IdsArgs,
      execute: async (a) => {
        const { removed } = await ops.removePantryItems(a.ids);
        return { removed, notFound: a.ids.filter((id) => !removed.includes(id)) };
      },
    }),

    restore_pantry_items: tool({
      description:
        'Undo a removal: put items back in the pantry. Use when the user says they removed ' +
        'something by mistake.',
      inputSchema: IdsArgs,
      execute: async (a) => ops.restorePantryItems(a.ids),
    }),

    log_cooked: tool({
      description:
        'Record that a dish was cooked and deduct its ingredients from the pantry. Use when the ' +
        'user says they made, cooked or ate something they prepared. The exact deduction is ' +
        'shown to them for approval before anything changes.',
      inputSchema: CookedArgs,
      // Section 5: "Yes: shows the deduction first." A wrong deduction spans
      // several items and is tedious to undo, so the user sees it first.
      needsApproval: true,
      execute: async (a) => {
        // Recomputed here, not carried from the approval card: the pantry can
        // move while the card is open, and a stale plan would deduct from a
        // row the user has since removed.
        const r = await resolveCooked(ops, a);
        const { logId, plan } = await ops.logCooked({
          recipeId: r.recipeId,
          title: r.title,
          ingredients: r.ingredients,
          ...(a.servings !== undefined ? { servingsMultiplier: a.servings } : {}),
        });
        return { logId, title: r.title, plan };
      },
    }),

    update_profile: tool({
      description:
        'Change the diets, allergens, exclusions, cuisines, serving count, time limit or spice ' +
        'level on the profile. Safety critical: send only the fields that change. The user ' +
        'confirms it before it takes effect.',
      inputSchema: ProfileArgs,
      // Section 5: "Yes: safety-critical." Dropping an allergen on a
      // misunderstanding is the worst thing this app can do.
      needsApproval: true,
      execute: async (a) => {
        const saved = await ops.setProfile(await patchedProfile(ops, a));
        return { ok: true, profile: { diets: saved.diets, allergens: saved.allergens } };
      },
    }),

    suggest_recipes: tool({
      description:
        'Propose dishes the user could cook. Searches the saved catalog and invents new options ' +
        'when it comes up short, preferring what is already in their pantry and what is about ' +
        'to go off. Use for any "what can I make" request. Every result is safety-checked ' +
        'against their profile before you see it — report what comes back, and never write a ' +
        'recipe of your own.',
      inputSchema: SuggestArgs,
      execute: async (a) => {
        const out = await ops.suggestRecipes({
          query: a.query,
          ...(a.max_minutes !== undefined ? { maxMinutes: a.max_minutes } : {}),
          ...(a.count !== undefined ? { limit: a.count } : {}),
        });
        return {
          suggestions: out.suggestions.map((s) => ({
            id: s.recipe.id,
            title: s.recipe.title,
            cuisine: s.recipe.cuisine,
            minutes: s.recipe.minutes,
            have: s.have,
            missing: s.missing,
            swaps: s.swaps.map((w) => ({ from: w.fromName, to: w.toName, why: w.explanation })),
            advisories: s.advisories,
          })),
          // Section 10 has copy for this: "Removed this recipe because it
          // contains peanuts, which are on your allergy list."
          hidden: out.dropped,
        };
      },
    }),

    substitute: tool({
      description:
        'Rewrite one named dish so it fits the profile, listing each swap. Use when the user ' +
        'names a specific dish, with or without an extra constraint such as "butter chicken but ' +
        'vegan". The extra constraint applies to this dish only and does not change their saved ' +
        'profile. Report the swaps that come back; never invent one yourself.',
      inputSchema: SubstituteArgs,
      execute: async (a) => {
        const out = await ops.substituteRecipe({
          ...(a.recipe_id !== undefined ? { recipeId: a.recipe_id } : {}),
          recipeTitle: a.recipe_title,
          ...(a.diets !== undefined ? { extraDiets: a.diets } : {}),
          ...(a.allergens !== undefined ? { extraAllergens: a.allergens } : {}),
          ...(a.avoid !== undefined ? { extraExclusions: a.avoid } : {}),
        });

        if (out.status === 'not_found') {
          return { ok: false, reason: `Could not find or build a recipe for "${out.title}".` };
        }
        if (out.status === 'dropped') {
          return { ok: false, title: out.title, reason: out.reason };
        }
        return {
          ok: true,
          id: out.recipe.id,
          title: out.recipe.title,
          minutes: out.recipe.minutes,
          alreadyFitted: out.alreadyFitted,
          ingredients: out.recipe.ingredients.map((i) => i.name),
          swaps: out.swaps.map((w) => ({
            from: w.fromName,
            to: w.toName,
            because: String(w.constraint),
            why: w.explanation,
            note: w.note,
          })),
          advisories: out.advisories,
        };
      },
    }),

    remember_taste: tool({
      description:
        'Save a like, dislike or note to taste memory. Use when the user volunteers an opinion ' +
        'about food — "I love paneer", "too spicy last time", "not a fan of okra". A dislike ' +
        'lowers a dish in the rankings; it is NOT an allergy or a diet. If they say they cannot ' +
        'or must not eat something, call update_profile instead.',
      inputSchema: RememberArgs,
      execute: async (a) => {
        const saved = await ops.rememberTaste({
          text: a.text,
          kind: a.kind,
          subject: a.subject ?? null,
          recipeId: a.recipe_id ?? null,
        });
        return { ok: true, id: saved.id, kind: saved.kind };
      },
    }),

    start_weekly_plan: tool({
      description:
        'Start planning a week of meals. Use when the user asks for a meal plan or to plan their ' +
        'week. It runs in the background and is safety-checked against their profile; tell them ' +
        'it has started and that it will appear on the plan screen — do not describe meals ' +
        'yourself.',
      inputSchema: PlanArgs,
      execute: async (a) => {
        const started = await ops.startWeeklyPlan({
          weekStart: a.week_start,
          slots: a.slots,
          cuisines: a.cuisines,
        });
        return {
          planId: started.planId,
          weekStart: started.weekStart,
          alreadyRunning: started.alreadyRunning,
          // The plan progress card's initial state. `plan.progress`
          // broadcasts tick these off as the Workflow reaches each one.
          steps: PLAN_STEPS.map((name, i) => ({ name, status: i === 0 ? 'started' : 'pending' })),
        };
      },
    }),

    get_plan: tool({
      description:
        "Read this week's meal plan, or check whether one is still being built. Call this " +
        'rather than recalling a plan from earlier in the chat.',
      inputSchema: z.object({}),
      execute: async () => {
        const plan = await ops.currentPlan();
        if (!plan) return { exists: false };
        return {
          exists: true,
          status: plan.status,
          weekStart: plan.weekStart,
          complete: plan.complete,
          days: plan.days.map((d) => ({
            date: d.date,
            meals: d.meals.map((m) => ({ slot: m.slot, title: m.title, minutes: m.minutes })),
          })),
          openSlots: plan.unfilled.map((g) => `${g.date} ${g.slot}`),
          error: plan.error,
        };
      },
    }),

    get_grocery_list: tool({
      description:
        "Read the grocery list for this week's plan: what the plan needs minus what is already " +
        'in the pantry.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await ops.groceryItems();
        return {
          count: items.length,
          items: items.map((i) => ({
            id: i.id,
            name: i.displayName,
            quantity: i.quantity,
            unit: i.unit,
            aisle: i.category,
            checked: i.checked,
          })),
        };
      },
    }),

    check_grocery_item: tool({
      description:
        'Tick an item off the grocery list, or untick it. The id comes from get_grocery_list. ' +
        'This does not add it to the pantry — use add_pantry_items for that.',
      inputSchema: CheckGroceryArgs,
      execute: async (a) => {
        const item = await ops.checkGroceryItem(a.item_id, a.checked);
        if (!item) return { ok: false, reason: 'No grocery item with that id.' };
        return { ok: true, item };
      },
    }),

    search_trending: tool({
      description:
        "Search this week's trending recipes from YouTube creators. Use when the user asks " +
        "what is trending, viral or popular right now. Every result already fits their " +
        'profile. Always credit the creator by name when you mention one.',
      inputSchema: TrendingArgs,
      execute: async (a) => {
        const out = await ops.searchTrending({ query: a.query, limit: a.count });
        return {
          // Same field name and shape as suggest_recipes, so the same card
          // renders both — plus the credit section 6 requires.
          suggestions: out.results.map((r) => ({
            id: r.recipe.id,
            title: r.recipe.title,
            cuisine: r.recipe.cuisine,
            minutes: r.recipe.minutes,
            have: r.have,
            missing: r.missing,
            swaps: r.swaps.map((w) => ({ from: w.fromName, to: w.toName, why: w.explanation })),
            advisories: r.advisories,
            creator: r.recipe.creator,
            sourceUrl: r.recipe.sourceUrl,
          })),
          hidden: out.hidden,
        };
      },
    }),
  };
}

/** Names of the tools the SDK will pause on, for tests and for the UI. */
export const APPROVAL_TOOLS = Object.keys(APPROVAL_ARGS);
