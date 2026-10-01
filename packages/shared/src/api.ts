import { z } from 'zod';
import {
  CookingLogEntry,
  GroceryItem,
  Id,
  InboxItem,
  IsoDate,
  IsoDateTime,
  MealSlot,
  PantryItem,
  PantryItemInput,
  PantryItemPatch,
  PipelineRun,
  Plan,
  PlanStatus,
  Profile,
  ProfileInput,
  Recipe,
  SafetyCheck,
  Scan,
  ScanItem,
  SubstituteResult,
  TasteMemory,
  TimeZone,
  User,
} from './domain.js';

/* --------------------------------- errors -------------------------------- */

// ponytail: `internal_error` is not in the section 11 table, but an unhandled
// throw still has to serialise into the one error shape. Everything else is
// exactly the spec's list.
export const ErrorCode = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'budget_exhausted',
  'rate_limited',
  'upstream_error',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The only error body this API ever returns (section 11). */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  budget_exhausted: 429,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
};

/** Response body for routes whose only answer is "it worked". */
export const Ok = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof Ok>;

/* ---------------------------------- auth ---------------------------------- */

// GET /auth/github takes no body and answers with a 302 to GitHub.

/** GET /auth/github/callback */
export const AuthGithubCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  /** Sent by the sign-in page so the profile starts in the right zone. */
  tz: TimeZone.optional(),
});
export type AuthGithubCallbackQuery = z.infer<typeof AuthGithubCallbackQuery>;

/** POST /auth/demo */
export const PostDemoRequest = z.object({ tz: TimeZone.optional() });
export type PostDemoRequest = z.infer<typeof PostDemoRequest>;

export const PostDemoResponse = z.object({
  user: User,
  /** Demo accounts expire 24 hours after creation (section 2, F1). */
  expiresAt: IsoDateTime,
});
export type PostDemoResponse = z.infer<typeof PostDemoResponse>;

/** POST /auth/logout */
export const PostLogoutResponse = Ok;
export type PostLogoutResponse = z.infer<typeof PostLogoutResponse>;

/* ----------------------------------- me ----------------------------------- */

/** GET /api/me */
export const GetMeResponse = z.object({ user: User });
export type GetMeResponse = z.infer<typeof GetMeResponse>;

/** DELETE /api/me */
export const DeleteMeResponse = Ok;
export type DeleteMeResponse = z.infer<typeof DeleteMeResponse>;

/* --------------------------------- profile -------------------------------- */

/** GET /api/profile */
export const GetProfileResponse = z.object({ profile: Profile });
export type GetProfileResponse = z.infer<typeof GetProfileResponse>;

/** PUT /api/profile — a full replace, not a patch. */
export const PutProfileRequest = ProfileInput;
export type PutProfileRequest = z.infer<typeof PutProfileRequest>;

export const PutProfileResponse = z.object({ profile: Profile });
export type PutProfileResponse = z.infer<typeof PutProfileResponse>;

/* ---------------------------------- pantry -------------------------------- */

/** GET /api/pantry */
export const GetPantryQuery = z.object({
  expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  includeDeleted: z.stringbool().optional(),
});
export type GetPantryQuery = z.infer<typeof GetPantryQuery>;

export const GetPantryResponse = z.object({ items: z.array(PantryItem) });
export type GetPantryResponse = z.infer<typeof GetPantryResponse>;

/** POST /api/pantry — free text ("bought 1kg paneer") or already-structured items. */
export const PostPantryRequest = z.union([
  z.object({ text: z.string().min(1).max(2000) }),
  z.object({ items: z.array(PantryItemInput).min(1) }),
]);
export type PostPantryRequest = z.infer<typeof PostPantryRequest>;

export const PostPantryResponse = z.object({ items: z.array(PantryItem) });
export type PostPantryResponse = z.infer<typeof PostPantryResponse>;

/** PATCH /api/pantry/:id */
export const PatchPantryItemRequest = PantryItemPatch;
export type PatchPantryItemRequest = z.infer<typeof PatchPantryItemRequest>;

export const PatchPantryItemResponse = z.object({ item: PantryItem });
export type PatchPantryItemResponse = z.infer<typeof PatchPantryItemResponse>;

/** DELETE /api/pantry/:id — soft delete, so undo stays possible. */
export const DeletePantryItemResponse = Ok;
export type DeletePantryItemResponse = z.infer<typeof DeletePantryItemResponse>;

/* -------------------------------- uploads --------------------------------- */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** POST /api/uploads — `multipart/form-data` with one `file` field. */
export const PostUploadResponse = z.object({ scanId: Id });
export type PostUploadResponse = z.infer<typeof PostUploadResponse>;

/* ---------------------------------- scans --------------------------------- */

/** GET /api/scans/:id */
export const GetScanResponse = z.object({ scan: Scan });
export type GetScanResponse = z.infer<typeof GetScanResponse>;

/** POST /api/scans/:id/confirm — the user's edited list; nothing is saved before this. */
export const PostScanConfirmRequest = z.object({ items: z.array(ScanItem) });
export type PostScanConfirmRequest = z.infer<typeof PostScanConfirmRequest>;

export const PostScanConfirmResponse = z.object({ items: z.array(PantryItem) });
export type PostScanConfirmResponse = z.infer<typeof PostScanConfirmResponse>;

/* ---------------------------------- plans --------------------------------- */

/** POST /api/plans */
export const PostPlanRequest = z.object({
  /** Omitted means today, in the profile's time zone. */
  weekStart: IsoDate.optional(),
  /** Omitted means all four slots (section 2, F8). */
  slots: z.array(MealSlot).min(1).optional(),
  cuisines: z.array(z.string().min(1)).optional(),
});
export type PostPlanRequest = z.infer<typeof PostPlanRequest>;

export const PostPlanResponse = z.object({ planId: Id, status: PlanStatus });
export type PostPlanResponse = z.infer<typeof PostPlanResponse>;

/** GET /api/plans/current */
export const GetCurrentPlanResponse = z.object({ plan: Plan.nullable() });
export type GetCurrentPlanResponse = z.infer<typeof GetCurrentPlanResponse>;

/** POST /api/plans/:id/days/:day/regenerate */
export const RegenerateDayParams = z.object({ id: Id, day: IsoDate });
export type RegenerateDayParams = z.infer<typeof RegenerateDayParams>;

export const PostRegenerateDayResponse = z.object({ plan: Plan });
export type PostRegenerateDayResponse = z.infer<typeof PostRegenerateDayResponse>;

/* --------------------------------- grocery -------------------------------- */

/** GET /api/grocery — defaults to the current plan. */
export const GetGroceryQuery = z.object({ planId: Id.optional() });
export type GetGroceryQuery = z.infer<typeof GetGroceryQuery>;

export const GetGroceryResponse = z.object({ items: z.array(GroceryItem) });
export type GetGroceryResponse = z.infer<typeof GetGroceryResponse>;

/** PATCH /api/grocery/:itemId */
export const PatchGroceryItemRequest = z.object({ checked: z.boolean() });
export type PatchGroceryItemRequest = z.infer<typeof PatchGroceryItemRequest>;

export const PatchGroceryItemResponse = z.object({ item: GroceryItem });
export type PatchGroceryItemResponse = z.infer<typeof PatchGroceryItemResponse>;

/* --------------------------------- recipes -------------------------------- */

/**
 * GET /api/recipes/:id — steps are generated on first open, so `recipe.steps`
 * is populated by the time this returns. The `check` rides along because no
 * recipe reaches a user before passing it (section 7).
 */
export const GetRecipeResponse = z.object({ recipe: Recipe, check: SafetyCheck });
export type GetRecipeResponse = z.infer<typeof GetRecipeResponse>;

/** POST /api/recipes/:id/substitute — always against the caller's own profile. */
export const PostSubstituteRequest = z.object({}).optional();
export type PostSubstituteRequest = z.infer<typeof PostSubstituteRequest>;

export const PostSubstituteResponse = SubstituteResult;
export type PostSubstituteResponse = z.infer<typeof PostSubstituteResponse>;

/** POST /api/recipes/:id/feedback */
export const PostFeedbackRequest = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    note: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.rating !== undefined || v.note !== undefined, {
    message: 'Send a rating, a note, or both.',
  });
export type PostFeedbackRequest = z.infer<typeof PostFeedbackRequest>;

export const PostFeedbackResponse = z.object({ memory: TasteMemory.nullable() });
export type PostFeedbackResponse = z.infer<typeof PostFeedbackResponse>;

/** POST /api/recipes/:id/cooked */
export const PostCookedRequest = z.object({
  servings: z.number().int().min(1).max(20).optional(),
  cookedAt: IsoDateTime.optional(),
});
export type PostCookedRequest = z.infer<typeof PostCookedRequest>;

export const PostCookedResponse = z.object({
  log: CookingLogEntry,
  /** Pantry rows as they stand after the deduction. */
  pantry: z.array(PantryItem),
});
export type PostCookedResponse = z.infer<typeof PostCookedResponse>;

/* -------------------------------- trending -------------------------------- */

/** GET /api/trending */
export const GetTrendingQuery = z.object({
  /** `me` keeps only recipes that pass the profile or can be substituted. */
  fits: z.literal('me').optional(),
  cuisine: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type GetTrendingQuery = z.infer<typeof GetTrendingQuery>;

export const TrendingEntry = z.object({
  recipe: Recipe,
  check: SafetyCheck,
  /** True when the recipe only fits after `substitute` runs. */
  needsSubstitution: z.boolean(),
});
export type TrendingEntry = z.infer<typeof TrendingEntry>;

export const GetTrendingResponse = z.object({ recipes: z.array(TrendingEntry) });
export type GetTrendingResponse = z.infer<typeof GetTrendingResponse>;

/* ---------------------------------- inbox --------------------------------- */

/** GET /api/inbox */
export const GetInboxQuery = z.object({ unreadOnly: z.stringbool().optional() });
export type GetInboxQuery = z.infer<typeof GetInboxQuery>;

export const GetInboxResponse = z.object({
  items: z.array(InboxItem),
  unread: z.number().int().nonnegative(),
});
export type GetInboxResponse = z.infer<typeof GetInboxResponse>;

/** POST /api/inbox/:id/read */
export const PostInboxReadResponse = z.object({ item: InboxItem });
export type PostInboxReadResponse = z.infer<typeof PostInboxReadResponse>;

/* --------------------------------- budget --------------------------------- */

export const NeuronBudget = z.object({
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
  left: z.number().nonnegative(),
});
export type NeuronBudget = z.infer<typeof NeuronBudget>;

/** GET /api/budget */
export const GetBudgetResponse = z.object({
  user: NeuronBudget,
  account: NeuronBudget,
  resetsAt: IsoDateTime,
});
export type GetBudgetResponse = z.infer<typeof GetBudgetResponse>;

/* ------------------------------ status & admin ---------------------------- */

/** GET /api/status/pipeline */
export const GetPipelineStatusResponse = z.object({ runs: z.array(PipelineRun) });
export type GetPipelineStatusResponse = z.infer<typeof GetPipelineStatusResponse>;

export const HealthCheck = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

/** GET /healthz — public; 200 when healthy, 503 with the same body when not. */
export const HealthzResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({ d1: HealthCheck, agent: HealthCheck, ai: HealthCheck }),
});
export type HealthzResponse = z.infer<typeof HealthzResponse>;

/** POST /admin/pipeline/run — guarded by `ADMIN_TOKEN`. */
export const PostAdminPipelineRunResponse = z.object({ runId: Id, workflowId: Id });
export type PostAdminPipelineRunResponse = z.infer<typeof PostAdminPipelineRunResponse>;

/* -------------------------------- websocket ------------------------------- */

/**
 * State the KitchenAgent syncs to every open tab (section 5). Badges and
 * banners read this instead of polling.
 */
export const AgentState = z.object({
  pantryCount: z.number().int().nonnegative(),
  expiringSoonCount: z.number().int().nonnegative(),
  unreadInbox: z.number().int().nonnegative(),
  activePlanStatus: PlanStatus.nullable(),
  neuronsLeftToday: z.number().nonnegative(),
});
export type AgentState = z.infer<typeof AgentState>;

/** Custom broadcasts on `/agents/kitchen-agent/{userId}` (section 11). */
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('plan.progress'),
    planId: Id,
    step: z.string(),
    status: z.enum(['started', 'done', 'failed']),
  }),
  z.object({
    type: z.literal('scan.ready'),
    scanId: Id,
    itemCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('inbox.new'), item: InboxItem }),
  z.object({ type: z.literal('budget.low'), percentLeft: z.number().min(0).max(100) }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
