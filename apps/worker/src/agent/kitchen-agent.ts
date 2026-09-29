import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { createTaxonomy, type SubstitutionRow, type Taxonomy } from '@cooked/safety';
import { CHAT_SYSTEM } from '@cooked/prompts';
import type {
  Ingredient,
  PantryItem,
  Profile,
  RecipeIngredient,
  Scan,
  ScanItem,
  TasteMemory,
  Unit,
} from '@cooked/shared';
import {
  type GenerateTextOnFinishCallback,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
  streamText,
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { TokenUsage } from '../budget/rates.js';
import type { Env } from '../env.js';
import { CLASSIFY_MODEL, classifyWithModel } from '../normalize/classify.js';
import { type Classifier, normalizeWithModel } from '../normalize/index.js';
import { GENERATE_MODEL, generateRecipes, llmProposer } from '../recipes/generate.js';
import { d1RecipeSearch, loadSubstitutions, saveRecipe } from '../recipes/store.js';
import {
  type SubstituteRequest,
  type SubstituteToolOutcome,
  type SuggestDeps,
  type SuggestOutcome,
  type SuggestRequest,
  substituteRecipe,
  suggestRecipes,
} from '../recipes/suggest.js';
import { budgetKeeper, budgetKeeperGate, workersAiRunner, type ModelRunner } from './adapters.js';
import { SLOT_CAPS, clampToTokens, renderPantry, renderProfile } from './context.js';
import {
  type DeductionPlan,
  type PantryRow,
  type RequiredIngredient,
  describePlan,
  planDeduction,
} from './deduct.js';
import { type ExtractedItem } from '../photo/extract.js';
import { type NormalizeScanResult, confirmPhrase, normalizeScan } from '../photo/scan.js';
import { nextLocalHour } from './schedule-local.js';
import { AGENT_SCHEMA } from './schema.js';
import {
  type StoredMemory,
  MAX_MEMORIES,
  TOP_K,
  dislikesFrom,
  packEmbedding,
  renderTaste,
  search as searchTaste,
  unpackEmbedding,
} from './taste.js';
import { APPROVAL_ARGS, type PantryOps, approvalSummary, buildTools } from './tools.js';

/**
 * One per user, addressed by user ID (sections 3 and 5).
 *
 * Built on `AIChatAgent`, so message persistence, resumable streaming, the
 * WebSocket transport and the human-in-the-loop approval protocol come from
 * the SDK rather than from this file. What is left here is the part that is
 * actually this product: the section 4 SQLite, the section 5 context window,
 * the safety gate on anything that returns food, and the scheduled nudges.
 *
 * Section 9's isolation rule is what makes the per-user split matter — the
 * shared D1 holds accounts and the recipe catalog and nothing personal, so
 * the blast radius of a bug in here is one user.
 */

const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** Section 8: below 20% of the daily cap, chat drops to the cheap model. */
const LOW_POWER_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const LOW_POWER_THRESHOLD = 0.2;
const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/**
 * Reserved before a turn. Spike 4 measured 71.6 neurons for a real turn with
 * tools; a tool call adds a second model call, so this covers two with
 * headroom. The commit replaces it with the billed figure moments later.
 */
const TURN_ESTIMATE_NEURONS = 160;

/** Section 5 step 4: tools run server-side, then the model answers once. */
const MAX_STEPS = 4;

/** Section 5's expiry nudge window. */
const EXPIRING_SOON_DAYS = 2;

interface PantryRowSql {
  id: string;
  canonical_id: string | null;
  display_name: string;
  category: string;
  quantity: number;
  unit: string;
  qty_confidence: string;
  added_at: string;
  expires_at: string | null;
  expiry_source: string;
  source: string;
  deleted_at: string | null;
}

export interface AddPantryResult {
  added: PantryItem[];
  /** Names the taxonomy could not resolve, kept but unverifiable. */
  unresolved: string[];
  modelCalled: boolean;
}

export interface CookedPreview {
  recipeTitle: string;
  plan: DeductionPlan;
  /** One line per change, for the approval card section 5 requires. */
  summary: string[];
}

export interface AgentSnapshot {
  pantryCount: number;
  expiringSoonCount: number;
  unreadInbox: number;
  activePlanStatus: string | null;
  neuronsLeftToday: number;
}

export class KitchenAgent extends AIChatAgent<Env> implements PantryOps {
  /** Built once per instance from the shared D1 taxonomy. */
  private taxonomyCache: Taxonomy | null = null;
  /** Same trade as the taxonomy: ~90 curated rows, changed weekly at most. */
  private substitutionCache: SubstitutionRow[] | null = null;

  /**
   * Injected by tests so a turn runs against a fixture instead of Workers AI.
   * An AI SDK `LanguageModel`, because that is what `streamText` takes — the
   * raw `ModelRunner` shape is for the non-streaming JSON calls elsewhere.
   */
  private modelOverride: LanguageModel | null = null;

  /** Test seam: point this turn at a mock model. */
  useModel(model: LanguageModel | null): void {
    this.modelOverride = model;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Blocking so no request — and no SDK hydration — can observe a
    // half-built schema. The SDK owns its own tables; these are section 4's.
    ctx.blockConcurrencyWhile(async () => initSchema(ctx));
  }

  /* ------------------------------- liveness ------------------------------- */

  async ping(): Promise<{ ok: true; storedAt: number }> {
    const now = Date.now();
    await this.ctx.storage.put('lastPing', now);
    return { ok: true, storedAt: now };
  }

  /**
   * Wipes this user's kitchen. Called by DELETE /api/me and the demo cron.
   *
   * Delegated entirely to the SDK, which cancels this agent's schedule rows,
   * clears its own tables and then deletes the facet. That last step aborts
   * this isolate, so nothing written after the call would run and the call
   * itself may not return cleanly — the SDK documents it as fire-and-forget,
   * and callers must treat a rejection as success.
   *
   * On the plain Durable Object this method had to rebuild the schema by
   * hand, because `deleteAll` dropped the tables while the instance stayed
   * alive and every later query hit "no such table". That cannot happen now:
   * the instance does not survive, and the next request constructs a fresh
   * one whose constructor runs `initSchema`.
   */
  override async destroy(): Promise<void> {
    await super.destroy();
  }

  /* ------------------------------- taxonomy ------------------------------- */

  /**
   * The ingredient taxonomy, read from the shared D1 and held for the life of
   * the instance.
   *
   * ~800 rows is small enough to keep in memory and re-reading it on every
   * pantry add would put a D1 query on the hot path of every chat turn. A
   * Durable Object is long-lived, so the taxonomy going stale means a
   * newly-seeded ingredient is missed until the instance restarts — which is
   * the right trade while the taxonomy changes weekly, not hourly.
   */
  private async taxonomy(): Promise<Taxonomy> {
    if (this.taxonomyCache) return this.taxonomyCache;
    const { results } = await this.env.DB.prepare(
      'SELECT canonical_id, name, aliases, category, default_unit, default_shelf_days, allergens, diet_flags FROM ingredients',
    ).all<{
      canonical_id: string;
      name: string;
      aliases: string;
      category: string;
      default_unit: string;
      default_shelf_days: number | null;
      allergens: string;
      diet_flags: string;
    }>();

    const ingredients: Ingredient[] = (results ?? []).map((r) => ({
      canonicalId: r.canonical_id,
      name: r.name,
      aliases: JSON.parse(r.aliases) as string[],
      category: r.category as Ingredient['category'],
      defaultUnit: r.default_unit as Unit,
      defaultShelfDays: r.default_shelf_days,
      allergens: JSON.parse(r.allergens) as Ingredient['allergens'],
      dietFlags: JSON.parse(r.diet_flags) as Ingredient['dietFlags'],
    }));

    this.taxonomyCache = createTaxonomy(ingredients);
    return this.taxonomyCache;
  }

  /* ---------------------------- add_pantry_items --------------------------- */

  /**
   * Section 5: "Parse free text into normalized items with estimated expiry."
   * No approval; adding something wrong is one tap to remove.
   *
   * `classify` is the 8B fallback for names the taxonomy misses, injected by
   * the caller so the budget reservation happens outside this class.
   */
  async addPantryItems(
    text: string,
    options: { source?: 'chat' | 'photo' | 'manual'; classify?: Classifier } = {},
  ): Promise<AddPantryResult> {
    const taxonomy = await this.taxonomy();
    const result = await normalizeWithModel(text, {
      taxonomy,
      source: options.source ?? 'chat',
      ...(options.classify ? { classify: options.classify } : {}),
    });

    const added: PantryItem[] = [];
    for (const item of result.items) {
      const id = crypto.randomUUID();
      const addedAt = nowIso();
      this.ctx.storage.sql.exec(
        `INSERT INTO pantry_items
           (id, canonical_id, display_name, category, quantity, unit, qty_confidence,
            added_at, expires_at, expiry_source, source, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        item.canonicalId,
        item.displayName,
        item.category,
        item.quantity,
        item.unit,
        item.qtyConfidence,
        addedAt,
        item.expiresAt,
        item.expirySource,
        item.source,
      );
      added.push({
        id,
        canonicalId: item.canonicalId,
        displayName: item.displayName,
        category: item.category,
        quantity: item.quantity,
        unit: item.unit,
        qtyConfidence: item.qtyConfidence,
        addedAt,
        expiresAt: item.expiresAt,
        expirySource: item.expirySource,
        source: item.source,
        deletedAt: null,
      });
    }

    return { added, unresolved: result.unresolved, modelCalled: result.modelCalled };
  }

  /* ------------------------------ list_pantry ----------------------------- */

  /** Section 5: read the pantry, optionally only what is going off soon. */
  async listPantry(
    options: { expiringWithinDays?: number; includeDeleted?: boolean } = {},
  ): Promise<PantryItem[]> {
    const clauses: string[] = [];
    const binds: unknown[] = [];

    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    if (options.expiringWithinDays !== undefined) {
      clauses.push('expires_at IS NOT NULL AND expires_at <= ?');
      binds.push(
        new Date(Date.now() + options.expiringWithinDays * 86_400_000).toISOString(),
      );
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Nulls last, so an item with no expiry does not masquerade as urgent.
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM pantry_items ${where}
         ORDER BY (expires_at IS NULL), expires_at ASC, added_at ASC`,
        ...binds,
      )
      .toArray() as unknown as PantryRowSql[];

    return rows.map(toPantryItem);
  }

  /* --------------------------- update_pantry_item -------------------------- */

  /**
   * Section 5: edit one item. Any field the user can see, they can correct —
   * section 2's F2 promises exactly that.
   */
  async updatePantryItem(
    id: string,
    patch: Partial<{
      displayName: string;
      quantity: number;
      unit: Unit;
      expiresAt: string | null;
      canonicalId: string | null;
    }>,
  ): Promise<PantryItem | null> {
    const existing = this.rowById(id);
    if (!existing || existing.deleted_at !== null) return null;

    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      binds.push(value);
    };

    if (patch.displayName !== undefined) set('display_name', patch.displayName);
    if (patch.quantity !== undefined) set('quantity', patch.quantity);
    if (patch.unit !== undefined) set('unit', patch.unit);
    if (patch.canonicalId !== undefined) set('canonical_id', patch.canonicalId);
    if (patch.expiresAt !== undefined) {
      set('expires_at', patch.expiresAt);
      // A date the user typed is no longer an estimate, and the UI stops
      // saying "about" (section 5).
      set('expiry_source', 'user');
    }
    if (sets.length === 0) return toPantryItem(existing);

    binds.push(id);
    this.ctx.storage.sql.exec(
      `UPDATE pantry_items SET ${sets.join(', ')} WHERE id = ?`,
      ...binds,
    );
    return toPantryItem(this.rowById(id) as PantryRowSql);
  }

  /* -------------------------- remove_pantry_items -------------------------- */

  /** Soft delete, so section 4's undo has something to restore. */
  async removePantryItems(ids: string[]): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    const at = nowIso();
    for (const id of ids) {
      const row = this.rowById(id);
      if (!row || row.deleted_at !== null) continue;
      this.ctx.storage.sql.exec('UPDATE pantry_items SET deleted_at = ? WHERE id = ?', at, id);
      removed.push(id);
    }
    return { removed };
  }

  /** Undo a soft delete. */
  async restorePantryItems(ids: string[]): Promise<{ restored: string[] }> {
    const restored: string[] = [];
    for (const id of ids) {
      const row = this.rowById(id);
      if (!row || row.deleted_at === null) continue;
      this.ctx.storage.sql.exec('UPDATE pantry_items SET deleted_at = NULL WHERE id = ?', id);
      restored.push(id);
    }
    return { restored };
  }

  /* ------------------------------- log_cooked ------------------------------ */

  /**
   * The approval half of `log_cooked` (section 5: "shows the deduction first").
   *
   * Changes nothing. The same plan is recomputed on commit rather than being
   * carried across the approval, because the pantry can move in between — a
   * stale plan could deduct an item the user removed while the card was open.
   */
  async previewCooked(recipe: {
    title: string;
    ingredients: RequiredIngredient[];
    servingsMultiplier?: number;
  }): Promise<CookedPreview> {
    const plan = planDeduction(
      recipe.ingredients,
      this.pantryRowsForDeduction(),
      recipe.servingsMultiplier ?? 1,
    );
    return { recipeTitle: recipe.title, plan, summary: describePlan(plan) };
  }

  /**
   * Applies the deduction and writes the cooking log.
   *
   * A shortfall does not block: someone who cooked with the last of the salt
   * still cooked the dish, and refusing to log it would lose the history that
   * section 6's no-repeat rule depends on. The shortfalls are returned so the
   * reply can mention them.
   */
  async logCooked(recipe: {
    recipeId?: string | null;
    title: string;
    ingredients: RequiredIngredient[];
    servingsMultiplier?: number;
    cookedAt?: string;
  }): Promise<{ logId: string; plan: DeductionPlan; pantry: PantryItem[] }> {
    const plan = planDeduction(
      recipe.ingredients,
      this.pantryRowsForDeduction(),
      recipe.servingsMultiplier ?? 1,
    );
    const at = recipe.cookedAt ?? nowIso();

    for (const d of plan.deductions) {
      if (d.emptied) {
        // Zero and soft-delete together: a row at quantity 0 that is still
        // live would show up in the pantry list as an item you do not have.
        this.ctx.storage.sql.exec(
          'UPDATE pantry_items SET quantity = 0, deleted_at = ? WHERE id = ?',
          at,
          d.pantryItemId,
        );
      } else {
        this.ctx.storage.sql.exec(
          'UPDATE pantry_items SET quantity = quantity - ? WHERE id = ?',
          d.quantity,
          d.pantryItemId,
        );
      }
    }

    const logId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO cooking_log (id, recipe_id, recipe_title, cooked_at, deducted) VALUES (?, ?, ?, ?, ?)',
      logId,
      recipe.recipeId ?? null,
      recipe.title,
      at,
      JSON.stringify(plan.deductions),
    );

    return { logId, plan, pantry: await this.listPantry() };
  }

  /** Recent meals, for section 6's no-repeat-within-7-days rule. */
  async cookingHistory(days = 14): Promise<{ recipeId: string | null; title: string; cookedAt: string }[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT recipe_id, recipe_title, cooked_at FROM cooking_log WHERE cooked_at >= ? ORDER BY cooked_at DESC',
        since,
      )
      .toArray() as unknown as { recipe_id: string | null; recipe_title: string; cooked_at: string }[];
    return rows.map((r) => ({ recipeId: r.recipe_id, title: r.recipe_title, cookedAt: r.cooked_at }));
  }

  /* ------------------------------- identity -------------------------------- */

  /**
   * The user this agent belongs to.
   *
   * `this.name` is the SDK's, and section 9 requires every agent to be named
   * after its user ID — so the name IS the user ID, and there is nothing to
   * remember. The plain Durable Object could not read back the name it was
   * addressed by; the SDK tracks it, so a whole round of bookkeeping goes
   * away. Falls back to the stored value for an instance reached by a raw
   * stub, which is how the cleanup cron and the tests get here.
   */
  private userId(): string {
    return this.name || this.getMeta('userId') || 'unknown';
  }

  /**
   * Demo flag, which the name cannot carry. Set by the Worker once per
   * connection, after it has verified the session.
   */
  identify(userId: string, isDemo: boolean): void {
    this.setMeta('userId', userId);
    this.setMeta('isDemo', isDemo ? '1' : '0');
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO agent_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value FROM agent_meta WHERE key = ?', key)
      .toArray()[0] as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  /* ------------------------------ recipe lookup ----------------------------- */

  /**
   * Looks a catalog recipe up by ID, else by exact title (section 4's shared
   * D1). `log_cooked` needs the real ingredient quantities; letting the model
   * supply them is how a pantry silently drifts from reality.
   */
  async findRecipe(
    idOrTitle: string,
  ): Promise<{ id: string; title: string; ingredients: RequiredIngredient[] } | null> {
    const row = await this.env.DB.prepare(
      'SELECT id, title, ingredients FROM recipes WHERE id = ? OR lower(title) = lower(?) LIMIT 1',
    )
      .bind(idOrTitle, idOrTitle)
      .first<{ id: string; title: string; ingredients: string }>();
    if (!row) return null;

    const parsed = JSON.parse(row.ingredients) as RecipeIngredient[];
    return {
      id: row.id,
      title: row.title,
      ingredients: parsed.map((i) => ({
        canonicalId: i.canonicalId,
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
      })),
    };
  }

  /* ------------------------------ food tools -------------------------------- */

  /**
   * The dependency bundle behind `suggest_recipes` and `substitute`.
   *
   * The model half is wrapped in its own reserve-then-commit rather than
   * riding the chat turn's reservation, for two reasons. Generation runs on
   * Gemma 4 26B and the turn is billed at Llama 3.3 70B's rate, so folding
   * them together would misprice both. And a refused reservation then
   * degrades instead of failing: `generate` is left undefined, the catalog
   * still answers, and the user gets fewer suggestions rather than an error.
   */
  private async recipeDeps(override?: ModelRunner): Promise<SuggestDeps> {
    const taxonomy = await this.taxonomy();
    const userId = this.userId();
    const isDemo = this.getMeta('isDemo') === '1';
    const gate = budgetKeeperGate(this.env, userId, isDemo);
    const model = override ?? workersAiRunner(this.env);

    const spend = async <T>(
      estimate: number,
      run: () => Promise<{ result: T; usage: TokenUsage }>,
    ): Promise<T | null> => {
      const reservation = await gate.reserve(estimate);
      if (!reservation.ok) return null;
      try {
        const { result, usage } = await run();
        await gate.commit(reservation.reservationId, { model: GENERATE_MODEL, usage });
        return result;
      } catch (e) {
        await gate.release(reservation.reservationId);
        throw e;
      }
    };

    // Section 8 estimates Gemma at ~25 neurons for 800/600 tokens; spike 2
    // measured 29 across four calls. Reserve generously — the commit replaces
    // it with the billed figure moments later.
    const GENERATE_ESTIMATE = 60;
    const PROPOSE_ESTIMATE = 20;

    return {
      taxonomy,
      search: d1RecipeSearch(this.env.DB),
      substitutions: await this.substitutionRows(),
      // Section 7: dislikes become *soft* violations. They lower a dish in
      // the ranking and never block it, which is why they are passed here
      // rather than folded into the profile's exclusions — an exclusion is a
      // hard rule, and "not a fan of okra" is not.
      dislikes: dislikesFrom(this.tasteMemories()),
      generate: async (req) => {
        const out = await spend(GENERATE_ESTIMATE, async () => {
          const r = await generateRecipes(req, { model });
          return { result: r, usage: r.usage };
        });
        return (
          out ?? {
            drafts: [],
            usage: { promptTokens: 0, completionTokens: 0 },
            attempts: 0,
            error: 'Out of budget for new ideas.',
          }
        );
      },
      propose: async (req) => {
        let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
        const proposer = llmProposer({
          model,
          taxonomy,
          onUsage: (u) => {
            usage = u;
          },
        });
        const out = await spend(PROPOSE_ESTIMATE, async () => {
          const result = await proposer(req);
          return { result, usage };
        });
        return out ?? [];
      },
    };
  }

  /** The curated swap table, held for the instance like the taxonomy. */
  private async substitutionRows(): Promise<SubstitutionRow[]> {
    this.substitutionCache ??= await loadSubstitutions(this.env.DB);
    return this.substitutionCache;
  }

  /**
   * Section 5: "Search the catalog and generate new options; always
   * safety-checked."
   *
   * Anything the model invented and that survived the safety gate is written
   * to the shared catalog, so the next person who asks gets it without a
   * model call (section 12: generated once, reused for every user). The write
   * is idempotent on `content_hash`.
   */
  async suggestRecipes(
    req: Omit<SuggestRequest, 'pantry' | 'profile'>,
    options: { model?: ModelRunner } = {},
  ): Promise<SuggestOutcome> {
    const deps = await this.recipeDeps(options.model);
    const outcome = await suggestRecipes(
      { ...req, pantry: await this.listPantry(), profile: await this.getProfile() },
      deps,
    );

    for (const s of outcome.suggestions) {
      if (s.source !== 'generated') continue;
      try {
        await saveRecipe(this.env.DB, s.recipe);
      } catch {
        // A failed cache write costs the next user a model call. It must not
        // cost this user their answer.
      }
    }
    return outcome;
  }

  /** Section 5: "Make a dish compliant with the profile, listing each swap." */
  async substituteRecipe(
    req: SubstituteRequest,
    options: { model?: ModelRunner } = {},
  ): Promise<SubstituteToolOutcome> {
    const outcome = await substituteRecipe(
      req,
      await this.getProfile(),
      await this.recipeDeps(options.model),
    );
    if (outcome.status === 'ok' && outcome.source === 'generated') {
      try {
        await saveRecipe(this.env.DB, outcome.recipe);
      } catch {
        // As above: a cache miss next time is not worth failing this call.
      }
    }
    return outcome;
  }


  /* ------------------------------ taste memory ------------------------------ */

  /**
   * Section 5's `remember_taste`.
   *
   * The embedding is best-effort: a memory whose embedding call failed is
   * still saved and still readable, it just will not surface in semantic
   * search. Losing the note entirely because an inference call hiccuped
   * would be the worse trade.
   */
  async rememberTaste(memory: {
    text: string;
    kind: TasteMemory['kind'];
    subject?: string | null;
    recipeId?: string | null;
  }): Promise<TasteMemory> {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const subject = memory.subject
      ? ((await this.taxonomy()).resolve(memory.subject)?.canonicalId ?? memory.subject)
      : null;

    const embedding = await this.embed(memory.text);

    this.ctx.storage.sql.exec(
      `INSERT INTO taste_memory (id, text, kind, subject, recipe_id, weight, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      memory.text,
      memory.kind,
      subject,
      memory.recipeId ?? null,
      embedding ? packEmbedding(embedding) : null,
      createdAt,
    );

    // Section 4 caps a user at 300. Evicting the oldest keeps the search
    // bounded without asking anyone to prune their own opinions.
    this.ctx.storage.sql.exec(
      // `rowid` breaks the tie. Several memories saved in one turn share a
      // millisecond, and ordering on `created_at` alone then picks an
      // arbitrary victim — which for an eviction means dropping a memory the
      // user just gave you while keeping an older one.
      `DELETE FROM taste_memory WHERE id NOT IN (
         SELECT id FROM taste_memory ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
      MAX_MEMORIES,
    );

    return {
      id,
      text: memory.text,
      kind: memory.kind,
      subject,
      recipeId: memory.recipeId ?? null,
      weight: 1,
      createdAt,
    };
  }

  /** Every memory, embeddings unpacked. At most 300 rows by construction. */
  private tasteMemories(): StoredMemory[] {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM taste_memory ORDER BY created_at DESC, rowid DESC')
      .toArray() as unknown as {
      id: string;
      text: string;
      kind: string;
      subject: string | null;
      recipe_id: string | null;
      weight: number;
      embedding: ArrayBuffer | Uint8Array | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind as TasteMemory['kind'],
      subject: r.subject,
      recipeId: r.recipe_id,
      weight: r.weight,
      createdAt: r.created_at,
      embedding: unpackEmbedding(r.embedding),
    }));
  }

  /** Read-only view for the UI and for tests. */
  async listTaste(): Promise<TasteMemory[]> {
    return this.tasteMemories().map(({ embedding: _embedding, ...rest }) => rest);
  }

  /**
   * Section 5's taste slot: "Top 5 memories most similar to the message".
   *
   * One embedding call per turn, on a model spike 1 measured at under a
   * neuron. If it fails the slot is simply empty — a turn without taste
   * context is worse, not broken.
   */
  private async relevantTaste(message: string): Promise<string[]> {
    const memories = this.tasteMemories();
    if (memories.length === 0) return [];
    const query = await this.embed(message);
    if (!query) return [];
    return renderTaste(searchTaste(query, memories, TOP_K));
  }

  private async embed(text: string): Promise<Float32Array | null> {
    try {
      const result = (await this.env.AI.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], {
        text: [text],
      } as never)) as { data?: number[][] };
      const vector = result.data?.[0];
      return vector ? new Float32Array(vector) : null;
    } catch {
      return null;
    }
  }

  /* ---------------------------- the context window --------------------------- */

  /**
   * Section 5's table, as one system message.
   *
   * The slots ride in the system block rather than as separate turns: spike 3
   * measured tool calling most reliable with a single system block, and a
   * "here is your pantry" user turn invites the model to answer that instead
   * of the real question. Each slot is clamped to its section 5 cap, because
   * the failure when one overflows is silent — the model just stops seeing
   * the end of the allergy list.
   */
  private async buildSystemPrompt(latestMessage: string): Promise<string> {
    const [profile, pantry, taste] = await Promise.all([
      this.getProfile(),
      this.listPantry(),
      this.relevantTaste(latestMessage),
    ]);

    const parts = [clampToTokens(CHAT_SYSTEM.text, SLOT_CAPS.system)];
    const slot = (label: string, body: string, cap: number) => {
      const text = clampToTokens(body, cap);
      if (text.trim()) parts.push(`--- ${label} ---\n${text}`);
    };
    slot('profile', renderProfile(profile), SLOT_CAPS.profile);
    slot('pantry', renderPantry(pantry, Date.now()), SLOT_CAPS.pantry);
    slot('what they like', taste.join('\n'), SLOT_CAPS.taste);
    return parts.join('\n\n');
  }

  /* -------------------------------- the turn --------------------------------- */

  /**
   * Section 5's turn lifecycle, steps 2 to 6.
   *
   * The SDK owns the transport, the persistence and the approval pause. What
   * this adds is the budget gate before the model is called, the section 5
   * context window, and the usage report after.
   */
  override async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const userId = this.userId();
    const isDemo = this.getMeta('isDemo') === '1';
    const gate = budgetKeeperGate(this.env, userId, isDemo);

    // Step 2: can they afford a turn at all?
    const reservation = await gate.reserve(TURN_ESTIMATE_NEURONS);
    if (!reservation.ok) {
      return new Response(reservation.message, {
        status: 429,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // Section 8: below 20% of the cap, chat drops to the cheap model.
    const fractionLeft = await gate.fractionLeft();
    const lowPower = fractionLeft < LOW_POWER_THRESHOLD;
    const modelId = lowPower ? LOW_POWER_MODEL : CHAT_MODEL;

    const system = await this.buildSystemPrompt(latestUserText(this.messages));
    // Section 12 routes chat through the AI Gateway too. A turn rarely
    // repeats byte for byte — the pantry slot changes as things are used up
    // — so this is not where the cache pays off. It matters for the demo
    // suggestion chips, which send identical context by design and are the
    // case section 12 calls out.
    const model =
      this.modelOverride ??
      createWorkersAI({
        binding: this.env.AI,
        ...(this.env.AI_GATEWAY_ID ? { gateway: { id: this.env.AI_GATEWAY_ID } } : {}),
      })(modelId as never);

    const result = streamText({
      model,
      system,
      messages: await convertToModelMessages(this.messages),
      tools: buildTools(this),
      // The SDK runs tools and loops back for the answer. Bounded so a model
      // that keeps reaching for tools cannot spin through the budget.
      stopWhen: stepCountIs(MAX_STEPS),
      onFinish: async (event) => {
        const usage: TokenUsage = {
          promptTokens: event.totalUsage?.inputTokens ?? 0,
          completionTokens: event.totalUsage?.outputTokens ?? 0,
        };
        // Step 6. Committed even on a partial turn: the tokens were billed
        // whether or not the answer arrived.
        await gate.commit(reservation.reservationId, { model: modelId, usage });

        // Section 8: every AI call logs the prompt ID and version.
        console.log(
          JSON.stringify({
            event: 'chat_turn',
            userId,
            model: modelId,
            prompt: CHAT_SYSTEM.ref,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            steps: event.steps?.length ?? 1,
            lowPower,
            continuation: options?.continuation ?? false,
          }),
        );

        await this.pushState();
        await onFinish(event as Parameters<GenerateTextOnFinishCallback<ToolSet>>[0]);
      },
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * The Approve / Reject card body for a tool the SDK has paused (section 5).
   *
   * Exposed over RPC and computed when the card renders rather than when the
   * model called the tool, so a card left open while the pantry changes shows
   * what would happen now. `execute` recomputes again on approval, so the
   * card is a preview and never the plan of record.
   */
  async previewApproval(toolName: string, input: unknown): Promise<string[]> {
    const schema = APPROVAL_ARGS[toolName];
    if (!schema) return ['This needs your confirmation.'];
    const parsed = schema.safeParse(input);
    if (!parsed.success) return ['Could not read what this would change.'];
    return approvalSummary(this, toolName, parsed.data);
  }

  /* ------------------------------ scheduled work ----------------------------- */

  /**
   * Arms the section 5 jobs on every wake.
   *
   * `idempotent` is not optional here and the SDK says so out loud: for a
   * `Date` schedule it defaults to false, so re-arming in `onStart` would
   * add a row every time the Durable Object woke and the 09:00 nudge would
   * fire once per restart that day.
   */
  override async onStart(): Promise<void> {
    await super.onStart?.();
    await this.armDailyJobs();
  }

  /**
   * One alarm per job per day, re-armed after each run.
   *
   * A fixed UTC cron would be simpler and wrong twice a year — see
   * `schedule-local.ts`. Re-arming after the run means the next occurrence is
   * computed with the offset that applies then, not the one that applied
   * yesterday.
   */
  private async armDailyJobs(): Promise<void> {
    const { timeZone } = await this.getProfile();
    await this.schedule(nextLocalHour(timeZone, 9), 'runExpiryCheck', {}, { idempotent: true });
    await this.schedule(
      nextLocalHour(timeZone, 17),
      'runTonightSuggestion',
      {},
      { idempotent: true },
    );
  }

  /**
   * 09:00 local: "inbox nudge for items expiring within 2 days". Section 5
   * says "None; template copy" for LLM use, so this spends no neurons.
   */
  async runExpiryCheck(): Promise<{ nudged: number }> {
    const soon = await this.listPantry({ expiringWithinDays: EXPIRING_SOON_DAYS });
    let nudged = 0;

    for (const item of soon) {
      // One nudge per item per day. The dedupe key carries the date, so
      // tomorrow's run can nudge again about the same still-unused spinach.
      const day = (item.expiresAt ?? nowIso()).slice(0, 10);
      const inserted = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO inbox (id, kind, title, body, created_at, read_at, dedupe_key)
         VALUES (?, 'expiry', ?, ?, ?, NULL, ?)`,
        crypto.randomUUID(),
        `${item.displayName} is on its way out`,
        // Section 10's voice: the joke roasts the fridge, never the user.
        `🚨 your ${item.displayName} is giving _last seen ${day}_`,
        nowIso(),
        `expiry:${item.id}:${day}`,
      );
      if (inserted.rowsWritten > 0) nudged += 1;
    }

    await this.armDailyJobs();
    await this.pushState();
    return { nudged };
  }

  /**
   * 17:00 local: "You can make X tonight".
   *
   * Section 5 budgets "one short blurb from the small model" — but the dish
   * itself comes from `suggestRecipes`, so it has already been through the
   * safety engine. Writing the inbox line from the returned title rather
   * than asking a model to phrase it keeps this at zero extra neurons, and a
   * template cannot hallucinate a dish the user cannot eat.
   */
  async runTonightSuggestion(): Promise<{ suggested: string | null }> {
    const pantry = await this.listPantry();
    if (pantry.length === 0) {
      await this.armDailyJobs();
      return { suggested: null };
    }

    let title: string | null = null;
    try {
      // Empty query on purpose. Section 5 wants the "best catalog match for
      // the current pantry", and a literal phrase like "something for
      // tonight" would text-filter the catalog down to nothing. With no
      // text filter every candidate is considered and the pantry-coverage
      // ranking picks the one they can actually cook.
      const out = await this.suggestRecipes({ query: '', limit: 1 });
      title = out.suggestions[0]?.recipe.title ?? null;
    } catch {
      // Out of budget, or the catalog is empty. No nudge is better than a
      // broken one, and tomorrow's run tries again.
    }

    if (title) {
      const day = nowIso().slice(0, 10);
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO inbox (id, kind, title, body, created_at, read_at, dedupe_key)
         VALUES (?, 'tonight', ?, ?, ?, NULL, ?)`,
        crypto.randomUUID(),
        `you can make ${title} tonight`,
        `🍳 ${title}, mostly from what you already have`,
        nowIso(),
        `tonight:${day}`,
      );
    }

    await this.armDailyJobs();
    await this.pushState();
    return { suggested: title };
  }

  /* ----------------------------- plan & grocery ----------------------------- */

  /**
   * The active plan, or null.
   *
   * Section 4 allows one plan per week; "current" is the newest, which is
   * the one the screen shows whether it is still generating or already
   * ready. Nothing writes this table yet — `WeeklyPlanWorkflow` will — so
   * today this is honestly null rather than a fabricated week.
   */
  async currentPlan(): Promise<{
    id: string;
    weekStart: string;
    status: string;
    plan: unknown;
    createdAt: string;
  } | null> {
    const row = this.ctx.storage.sql
      .exec('SELECT * FROM plans ORDER BY week_start DESC LIMIT 1')
      .toArray()[0] as unknown as
      | { id: string; week_start: string; status: string; plan: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      weekStart: row.week_start,
      status: row.status,
      plan: JSON.parse(row.plan) as unknown,
      createdAt: row.created_at,
    };
  }

  /** The current plan's grocery list. Empty until a plan exists. */
  async groceryItems(): Promise<
    {
      id: string;
      canonicalId: string | null;
      displayName: string;
      category: string;
      quantity: number | null;
      unit: string | null;
      checked: boolean;
    }[]
  > {
    const plan = await this.currentPlan();
    if (!plan) return [];

    const rows = this.ctx.storage.sql
      .exec(
        'SELECT * FROM grocery_items WHERE plan_id = ? ORDER BY category, display_name',
        plan.id,
      )
      .toArray() as unknown as {
      id: string;
      canonical_id: string | null;
      display_name: string;
      category: string;
      quantity: number | null;
      unit: string | null;
      checked: number;
    }[];

    return rows.map((r) => ({
      id: r.id,
      canonicalId: r.canonical_id,
      displayName: r.display_name,
      category: r.category,
      quantity: r.quantity,
      unit: r.unit,
      checked: r.checked === 1,
    }));
  }

  /** Ticks one grocery item. Returns null when the id is not this user's. */
  async checkGroceryItem(
    itemId: string,
    checked: boolean,
  ): Promise<{ id: string; checked: boolean } | null> {
    const result = this.ctx.storage.sql.exec(
      'UPDATE grocery_items SET checked = ? WHERE id = ?',
      checked ? 1 : 0,
      itemId,
    );
    if (result.rowsWritten === 0) return null;
    return { id: itemId, checked };
  }

  /* --------------------------------- scans ---------------------------------- */

  /**
   * Opens a scan row before the Workflow starts (section 4).
   *
   * Written here rather than by the Workflow's first step so that the upload
   * route can return a `scanId` the client can poll immediately — a Workflow
   * takes a moment to start, and a 202 pointing at a row that does not exist
   * yet is a race the UI would have to paper over.
   */
  async createScan(scanId: string, r2Key: string, workflowId: string | null): Promise<Scan> {
    const createdAt = nowIso();
    this.ctx.storage.sql.exec(
      `INSERT INTO scans (id, workflow_id, r2_key, items, status, error, created_at)
       VALUES (?, ?, ?, '[]', 'processing', NULL, ?)`,
      scanId,
      workflowId,
      r2Key,
      createdAt,
    );
    return {
      id: scanId,
      workflowId,
      r2Key,
      status: 'processing',
      items: [],
      error: null,
      createdAt,
    };
  }

  async getScan(scanId: string): Promise<Scan | null> {
    const row = this.ctx.storage.sql
      .exec('SELECT * FROM scans WHERE id = ?', scanId)
      .toArray()[0] as unknown as
      | {
          id: string;
          workflow_id: string | null;
          r2_key: string;
          items: string;
          status: string;
          error: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      workflowId: row.workflow_id,
      r2Key: row.r2_key,
      status: row.status as Scan['status'],
      items: JSON.parse(row.items) as ScanItem[],
      error: row.error,
      createdAt: row.created_at,
    };
  }

  /** Records the Workflow's id once it has been created. */
  async attachScanWorkflow(scanId: string, workflowId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'UPDATE scans SET workflow_id = ? WHERE id = ?',
      workflowId,
      scanId,
    );
  }

  /**
   * The extracted items, and the move to `awaiting_confirm`.
   *
   * Section 6 parks the Workflow on `waitForEvent` immediately after this,
   * and a parked instance reports `running` — so this write is the only
   * signal the UI gets that a confirm list is ready.
   */
  async setScanItems(scanId: string, items: ScanItem[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE scans SET items = ?, status = 'awaiting_confirm' WHERE id = ?",
      JSON.stringify(items),
      scanId,
    );
    await this.pushState();
  }

  /**
   * The normalize step, run inside the agent because that is where the
   * taxonomy cache and the budget gate already live.
   *
   * Writing the result is part of the same call: the Workflow parks on
   * `waitForEvent` on the next line, and a separate round trip to store the
   * items would be a window where the scan is neither processing nor
   * confirmable.
   */
  async normalizeScanItems(
    scanId: string,
    extracted: ExtractedItem[],
  ): Promise<NormalizeScanResult> {
    const taxonomy = await this.taxonomy();
    const userId = this.userId();
    const gate = budgetKeeperGate(this.env, userId, this.getMeta('isDemo') === '1');

    const result = await normalizeScan(extracted, taxonomy, {
      classify: async (req) => {
        // Section 12: taxonomy first, a model only for misses. The reserve
        // is small because so is the call — section 8 puts it near 10
        // neurons — and a refusal leaves the names unresolved rather than
        // failing the scan.
        const reservation = await gate.reserve(20);
        if (!reservation.ok) return {};
        try {
          const answers = await classifyWithModel(req, workersAiRunner(this.env));
          await gate.commit(reservation.reservationId, {
            model: CLASSIFY_MODEL,
            usage: answers.usage,
          });
          return answers.ids;
        } catch {
          await gate.release(reservation.reservationId);
          return {};
        }
      },
    });

    await this.setScanItems(scanId, result.items);
    return result;
  }

  async failScan(scanId: string, error: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE scans SET status = 'failed', error = ? WHERE id = ?",
      error.slice(0, 500),
      scanId,
    );
    await this.pushState();
  }

  /**
   * Commits the ticked items to the pantry (section 6's commit step).
   *
   * Each item goes in through `addPantryItems`, the same path chat uses, so
   * a photo item and a typed item get identical quantity, unit and expiry
   * handling. A printed date read off the packaging overrides the estimate
   * and is marked `label` rather than `estimated`, because it is a fact
   * about that packet rather than a guess about the category.
   *
   * Returns rather than throws on an empty list: closing a scan having
   * ticked nothing is a normal thing to do.
   */
  async commitScan(
    scanId: string,
    items: ScanItem[],
  ): Promise<{ added: number; scan: Scan | null }> {
    const chosen = items.filter((i) => i.selected);

    for (const item of chosen) {
      const { added } = await this.addPantryItems(confirmPhrase(item), { source: 'photo' });
      const row = added[0];
      if (!row) continue;

      if (item.expiresAt) {
        this.ctx.storage.sql.exec(
          "UPDATE pantry_items SET expires_at = ?, expiry_source = 'label' WHERE id = ?",
          item.expiresAt,
          row.id,
        );
      }
      // The taxonomy match the scan already made is more informed than a
      // re-parse of the rebuilt phrase, so it wins where they disagree.
      if (item.canonicalId && row.canonicalId !== item.canonicalId) {
        this.ctx.storage.sql.exec(
          'UPDATE pantry_items SET canonical_id = ? WHERE id = ?',
          item.canonicalId,
          row.id,
        );
      }
    }

    this.ctx.storage.sql.exec(
      "UPDATE scans SET items = ?, status = 'done' WHERE id = ?",
      JSON.stringify(items),
      scanId,
    );
    await this.pushState();
    return { added: chosen.length, scan: await this.getScan(scanId) };
  }

  /**
   * The 24-hour timeout from section 6.
   *
   * The scan is closed as `failed` and the user is told in the inbox, rather
   * than left as `awaiting_confirm` forever pointing at an R2 object that
   * the cleanup step has already deleted.
   */
  async expireScan(scanId: string): Promise<{ expired: boolean }> {
    const scan = await this.getScan(scanId);
    if (!scan || scan.status !== 'awaiting_confirm') return { expired: false };

    this.ctx.storage.sql.exec(
      "UPDATE scans SET status = 'failed', error = ? WHERE id = ?",
      'Not confirmed within 24 hours.',
      scanId,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO inbox (id, kind, title, body, created_at, read_at, dedupe_key)
       VALUES (?, 'system', ?, ?, ?, NULL, ?)`,
      crypto.randomUUID(),
      'that photo scan timed out',
      'we held it for a day and never heard back, so it is gone. upload it again whenever 📸',
      nowIso(),
      `scan-expired:${scanId}`,
    );
    await this.pushState();
    return { expired: true };
  }

  /** Tells the user their scan could not run at all (section 6's deferred). */
  async notifyScanDeferred(scanId: string, reason: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO inbox (id, kind, title, body, created_at, read_at, dedupe_key)
       VALUES (?, 'system', ?, ?, ?, NULL, ?)`,
      crypto.randomUUID(),
      'chef is tired 😮‍💨',
      `couldn't read that photo right now: ${reason}`,
      nowIso(),
      `scan-deferred:${scanId}`,
    );
    await this.pushState();
  }

  /* --------------------------------- inbox ---------------------------------- */

  async listInbox(
    options: { unreadOnly?: boolean } = {},
  ): Promise<
    {
      id: string;
      kind: string;
      title: string;
      body: string;
      createdAt: string;
      readAt: string | null;
    }[]
  > {
    const where = options.unreadOnly ? 'WHERE read_at IS NULL' : '';
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM inbox ${where} ORDER BY created_at DESC LIMIT 50`)
      .toArray() as unknown as {
      id: string;
      kind: string;
      title: string;
      body: string;
      created_at: string;
      read_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));
  }

  async markInboxRead(id: string): Promise<{ ok: boolean }> {
    const result = this.ctx.storage.sql.exec(
      'UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL',
      nowIso(),
      id,
    );
    return { ok: result.rowsWritten > 0 };
  }

  /* ------------------------------- synced state ------------------------------ */

  /**
   * Section 5: "a small state object synced to every open tab". The SDK's
   * `setState` does the syncing, so the UI reads badges from it without
   * polling.
   */
  private async pushState(): Promise<void> {
    this.setState(await this.snapshot());
  }

  /* -------------------------------- profile -------------------------------- */

  async getProfile(): Promise<Profile> {
    const row = this.ctx.storage.sql
      .exec('SELECT * FROM profile WHERE id = 1')
      .toArray()[0] as unknown as Record<string, string | number>;
    return {
      diets: JSON.parse(String(row.diets)) as Profile['diets'],
      allergens: JSON.parse(String(row.allergens)) as Profile['allergens'],
      exclusions: JSON.parse(String(row.exclusions)) as string[],
      cuisines: JSON.parse(String(row.cuisines)) as string[],
      maxCookMinutes: Number(row.max_cook_minutes),
      servings: Number(row.servings),
      spiceLevel: String(row.spice_level) as Profile['spiceLevel'],
      timeZone: String(row.time_zone),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Section 5 marks this safety-critical and approval-gated. The approval
   * happens in the chat layer; what this guarantees is that a write is whole —
   * a half-applied profile could drop an allergen.
   */
  async setProfile(profile: Omit<Profile, 'updatedAt'>): Promise<Profile> {
    this.ctx.storage.sql.exec(
      `UPDATE profile SET diets = ?, allergens = ?, exclusions = ?, cuisines = ?,
         max_cook_minutes = ?, servings = ?, spice_level = ?, time_zone = ?, updated_at = ?
       WHERE id = 1`,
      JSON.stringify(profile.diets),
      JSON.stringify(profile.allergens),
      JSON.stringify(profile.exclusions),
      JSON.stringify(profile.cuisines),
      profile.maxCookMinutes,
      profile.servings,
      profile.spiceLevel,
      profile.timeZone,
      nowIso(),
    );
    return this.getProfile();
  }

  /* --------------------------------- state --------------------------------- */

  /** The small object section 5 syncs to every open tab. */
  async snapshot(): Promise<AgentSnapshot> {
    const count = (sql: string, ...binds: unknown[]): number => {
      const row = this.ctx.storage.sql.exec(sql, ...binds).toArray()[0] as unknown as { n: number };
      return Number(row?.n ?? 0);
    };

    return {
      pantryCount: count('SELECT COUNT(*) AS n FROM pantry_items WHERE deleted_at IS NULL'),
      expiringSoonCount: count(
        'SELECT COUNT(*) AS n FROM pantry_items WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?',
        new Date(Date.now() + EXPIRING_SOON_DAYS * 86_400_000).toISOString(),
      ),
      unreadInbox: count('SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL'),
      // Plans are week 2 (track C); reporting null is honest, reporting
      // 'ready' would not be.
      activePlanStatus: null,
      neuronsLeftToday: await this.neuronsLeft(),
    };
  }

  /**
   * The badge in section 5's synced state.
   *
   * A ledger round trip on every snapshot, and a snapshot happens after every
   * turn. That is one extra Durable Object hop per turn against a model call
   * that takes seconds, so it is not worth caching — but if snapshots ever
   * fire on a timer, cache it. A failure here returns 0 rather than breaking
   * the turn: a wrong badge is better than a lost reply.
   */
  private async neuronsLeft(): Promise<number> {
    const userId = this.name || this.getMeta('userId');
    if (!userId) return 0;
    try {
      const status = await budgetKeeper(this.env).status(userId, this.getMeta('isDemo') === '1');
      return Math.min(status.user.left, status.account.left);
    } catch {
      return 0;
    }
  }

  /* -------------------------------- helpers -------------------------------- */

  private rowById(id: string): PantryRowSql | null {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM pantry_items WHERE id = ?', id)
      .toArray() as unknown as PantryRowSql[];
    return rows[0] ?? null;
  }

  private pantryRowsForDeduction(): PantryRow[] {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM pantry_items WHERE deleted_at IS NULL AND quantity > 0')
      .toArray() as unknown as PantryRowSql[];
    return rows.map((r) => ({
      id: r.id,
      canonicalId: r.canonical_id,
      displayName: r.display_name,
      quantity: r.quantity,
      unit: r.unit as Unit,
      expiresAt: r.expires_at,
    }));
  }
}

/** Creates the tables and the single profile row. Safe to run repeatedly. */
function initSchema(ctx: DurableObjectState): void {
  for (const statement of AGENT_SCHEMA) ctx.storage.sql.exec(statement);
  const existing = ctx.storage.sql.exec('SELECT id FROM profile WHERE id = 1').toArray();
  if (existing.length === 0) {
    ctx.storage.sql.exec('INSERT INTO profile (id, updated_at) VALUES (1, ?)', nowIso());
  }
}

/**
 * The newest user message, as plain text.
 *
 * Only used to pick the taste memories for this turn, so the parts are
 * flattened rather than interpreted — an attachment or a tool part
 * contributes nothing to "which of their opinions are relevant here".
 */
function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    return m.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

function nowIso(): string {
  return new Date().toISOString();
}

function toPantryItem(r: PantryRowSql): PantryItem {
  return {
    id: r.id,
    canonicalId: r.canonical_id,
    displayName: r.display_name,
    category: r.category as PantryItem['category'],
    quantity: r.quantity,
    unit: r.unit as Unit,
    qtyConfidence: r.qty_confidence as PantryItem['qtyConfidence'],
    addedAt: r.added_at,
    expiresAt: r.expires_at,
    expirySource: r.expiry_source as PantryItem['expirySource'],
    source: r.source as PantryItem['source'],
    deletedAt: r.deleted_at,
  };
}
