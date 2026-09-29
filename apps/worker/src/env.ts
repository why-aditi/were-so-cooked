/**
 * Every binding declared in wrangler.jsonc. Keep this in step with all three
 * environment blocks in that file — wrangler does not inherit bindings into
 * named environments, so a binding present in one and missing in another is a
 * runtime failure that typechecks fine.
 */
export interface Env {
  /* vars */
  ENVIRONMENT: 'dev' | 'staging' | 'production';
  /** Section 9: local fake login. Never set outside dev; CI asserts that. */
  DEV_AUTH?: string;

  /* storage */
  DB: D1Database;
  RECIPES_INDEX: VectorizeIndex;
  UPLOADS: R2Bucket;

  /* compute */
  AI: Ai;
  ASSETS: Fetcher;
  KITCHEN_AGENT: DurableObjectNamespace;
  BUDGET_KEEPER: DurableObjectNamespace;
  WEEKLY_PLAN: Workflow;
  PHOTO_SCAN: Workflow;
  VIRAL_RECIPES: Workflow;

  /* secrets, set with `wrangler secret put` — never in wrangler.jsonc */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SIGNING_KEY?: string;
  ADMIN_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
}
