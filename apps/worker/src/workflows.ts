import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { MealSlot, PipelineRun, ScanItem } from '@cooked/shared';
import { budgetKeeper, workersAiRunner, workersAiVision } from './agent/adapters.js';
import type { KitchenAgent } from './agent/kitchen-agent.js';
import type { Env } from './env.js';
import { type TokenUsage, neuronsFor } from './budget/rates.js';
import { EXTRACT_MODEL as VISION_MODEL, extractItems } from './photo/extract.js';
import { groceryDiff } from './plan/grocery.js';
import { buildPlan } from './plan/plan.js';
import type { PlanContext, PlanStep } from './plan/record.js';
import {
  GENERATE_MODEL,
  type GenerateRequest,
  generateRecipes,
  llmProposer,
} from './recipes/generate.js';
import { d1RecipeSearch, loadSubstitutions, loadTaxonomy, saveRecipe } from './recipes/store.js';
import { type VideoCandidate, discoverVideos } from './viral/discover.js';
import {
  EXTRACT_MODEL,
  FILTER_BATCH,
  FILTER_MODEL,
  classifyDescriptions,
  extractRecipe,
} from './viral/extract.js';
import {
  type JudgedVideo,
  MAX_ERRORS,
  MAX_RECIPES,
  type RunCounts,
  type VideoOutcome,
  dedupe,
  filteredOut,
  judgeExtraction,
} from './viral/pipeline.js';
import {
  closeRun,
  knownContentHashes,
  openRun,
  recordSeenVideos,
  seenVideoIds,
} from './viral/store.js';
import { youtubeSearch } from './viral/youtube.js';
import { userIdFromKey, validateUpload } from './photo/validate.js';

type KitchenAgentStub = DurableObjectStub<KitchenAgent>;

/** Section 9: every agent is addressed by its user ID, never by anything else. */
function kitchenAgent(env: Env, userId: string): KitchenAgentStub {
  return env.KITCHEN_AGENT.get(
    env.KITCHEN_AGENT.idFromName(userId),
  ) as unknown as KitchenAgentStub;
}

/**
 * The three Workflows from section 6, declared so wrangler.jsonc's bindings
 * resolve and the environments can be created. Same rule as the Durable
 * Objects: a bound Workflow class that is not exported fails the deploy, so
 * these have to exist before any infrastructure can be stood up.
 *
 */

/** Section 6: "Every AI step: 3 retries, exponential backoff from 5s, 60s timeout." */
const AI_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '60 seconds',
};

export interface WeeklyPlanParams {
  userId: string;
  /** The row the agent opened before starting this run. */
  planId: string;
  weekStart: string;
  slots: MealSlot[];
  cuisines?: string[];
}

/**
 * Spike 4 measured 435 neurons for a four-slot plan with a repair round.
 * This build only calls a model for repairs, on the cheaper Gemma 4, so the
 * real spend is usually far lower; the commit replaces the estimate with the
 * billed figure either way.
 */
const PLAN_ESTIMATE_NEURONS = 450;

/** A failed run throws instead, after `failPlan` has recorded why. */
export interface WeeklyPlanOutcome {
  status: 'complete' | 'partial';
  saved: boolean;
  unfilled: number;
  catalogOnly: boolean;
}

/**
 * `WeeklyPlanWorkflow` from section 6.
 *
 * Load context, reserve, build, grocery diff, save. The generate, validate
 * and repair loop is `buildPlan`, a pure function with its own tests; this
 * class is only the durable shell around it — retries, the budget, and
 * getting the result back into the user's agent.
 *
 * One deliberate departure from section 6's shared rule: a refused
 * reservation does not end the run as `deferred`. A plan built only from the
 * catalog costs no neurons at all, so the run goes ahead without the model,
 * leaves any slot it cannot fill open, and says so — a mostly-planned week
 * beats an inbox message telling someone to come back tomorrow.
 */
export class WeeklyPlanWorkflow extends WorkflowEntrypoint<Env, WeeklyPlanParams> {
  override async run(
    event: WorkflowEvent<WeeklyPlanParams>,
    step: WorkflowStep,
  ): Promise<WeeklyPlanOutcome> {
    const { userId, planId } = event.payload;
    const agent = kitchenAgent(this.env, userId);

    try {
      return await this.plan(step, event.payload, agent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do('record failure', async () => {
        await agent.failPlan(planId, message);
        return true;
      });
      throw e;
    }
  }

  private async plan(
    step: WorkflowStep,
    params: WeeklyPlanParams,
    agent: KitchenAgentStub,
  ): Promise<WeeklyPlanOutcome> {
    const { userId, planId } = params;
    const progress = async (name: PlanStep, status: 'started' | 'done') => {
      // A missed broadcast costs a stale tick on the card, never the plan.
      await agent.planProgress(planId, name, status).catch(() => undefined);
    };

    // ---- Load context ----------------------------------------------------
    const context = await step.do('load context', async () => {
      await progress('reading your kitchen', 'started');
      const ctx = await agent.planContext();
      await progress('reading your kitchen', 'done');
      // Copied out of the RPC result: a stub's return value carries a
      // disposer, and a step result has to be plain serializable JSON.
      return JSON.parse(JSON.stringify(ctx)) as PlanContext;
    });

    // ---- Reserve ---------------------------------------------------------
    //
    // Section 6: "The first step of every run reserves its estimated neurons
    // with BudgetKeeper." No AI binding means no model to pay for, which is
    // how the local test pool runs.
    const reservation = await step.do('reserve neurons', async () => {
      await progress('checking the budget', 'started');
      const r = this.env.AI
        ? await budgetKeeper(this.env).reserve({
            userId,
            estimate: PLAN_ESTIMATE_NEURONS,
            isDemo: context.isDemo,
          })
        : null;
      await progress('checking the budget', 'done');
      return r?.ok ? r.reservationId : null;
    });

    try {
      return await this.build(step, params, agent, context, reservation, progress);
    } catch (e) {
      // Without this, a run that fails after reserving holds that budget for
      // the five minutes a reservation takes to expire. `release` only
      // touches an uncommitted reservation, so it is a no-op if the build
      // step already committed the real spend.
      if (reservation) {
        await step.do('release neurons', async () => {
          await budgetKeeper(this.env).release(reservation);
          return true;
        });
      }
      throw e;
    }
  }

  private async build(
    step: WorkflowStep,
    params: WeeklyPlanParams,
    agent: KitchenAgentStub,
    context: PlanContext,
    reservation: string | null,
    progress: (name: PlanStep, status: 'started' | 'done') => Promise<void>,
  ): Promise<WeeklyPlanOutcome> {
    const { userId, planId, weekStart, slots } = params;

    // ---- Build -----------------------------------------------------------
    //
    // Section 6's rank, retrieve, generate, validate and repair, as one step:
    // `buildPlan` threads state between them (claimed titles, spent pantry
    // items) that would have to be serialized at every boundary otherwise,
    // and its catalog reads are cheap to repeat on a retry.
    const built = await step.do('build plan', AI_STEP, async () => {
      await progress('building the week', 'started');
      const [taxonomy, substitutions] = await Promise.all([
        loadTaxonomy(this.env.DB),
        loadSubstitutions(this.env.DB),
      ]);

      const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
      const add = (u: TokenUsage) => {
        usage.promptTokens += u.promptTokens;
        usage.completionTokens += u.completionTokens;
      };
      const model = reservation ? workersAiRunner(this.env) : null;

      const plan = () => buildPlan(
        {
          weekStart,
          slots,
          profile: context.profile,
          pantry: context.pantry,
          history: context.history,
          cuisines: params.cuisines,
        },
        {
          taxonomy,
          search: d1RecipeSearch(this.env.DB),
          substitutions,
          dislikes: context.dislikes,
          ...(model
            ? {
                generate: async (req: GenerateRequest) => {
                  const r = await generateRecipes(req, { model });
                  add(r.usage);
                  return r;
                },
                propose: llmProposer({ model, taxonomy, onUsage: add }),
              }
            : {}),
        },
      );

      let outcome: Awaited<ReturnType<typeof plan>>;
      try {
        outcome = await plan();
      } catch (e) {
        // This attempt may already have paid for model calls, and the retry
        // will pay again. Charge them now as their own ledger entry — a
        // commit under an unknown id records the spend without touching the
        // reservation, which the next attempt (or the release on the
        // failure path) still owns. Otherwise up to four attempts' worth of
        // real spend would never reach the caps.
        if (usage.promptTokens + usage.completionTokens > 0) {
          await budgetKeeper(this.env)
            .commit(crypto.randomUUID(), { model: GENERATE_MODEL, usage, userId })
            .catch(() => undefined);
        }
        throw e;
      }

      if (reservation) {
        const keeper = budgetKeeper(this.env);
        if (usage.promptTokens + usage.completionTokens > 0) {
          await keeper.commit(reservation, { model: GENERATE_MODEL, usage, userId });
        } else {
          // The catalog filled every slot, so the model was never asked.
          await keeper.release(reservation);
        }
      }

      console.log(
        JSON.stringify({
          event: 'plan_built',
          planId,
          status: outcome.status,
          unfilled: outcome.unfilled.length,
          repeated: outcome.repeated.length,
          repairRounds: outcome.repairRounds,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        }),
      );
      await progress('building the week', 'done');
      return {
        status: outcome.status,
        days: outcome.days,
        unfilled: outcome.unfilled,
        repeated: outcome.repeated,
        dropped: outcome.dropped,
      };
    });

    // ---- Grocery diff ----------------------------------------------------
    const grocery = await step.do('grocery diff', async () => {
      await progress('writing the grocery list', 'started');
      const taxonomy = await loadTaxonomy(this.env.DB);
      const diff = groceryDiff(built.days, context.pantry, taxonomy);
      await progress('writing the grocery list', 'done');
      return diff;
    });

    // ---- Save and notify -------------------------------------------------
    const saved = await step.do('save', async () => {
      await progress('saving', 'started');
      const r = await agent.savePlan(planId, {
        outcome: built,
        grocery,
        catalogOnly: reservation === null,
      });
      await progress('saving', 'done');
      return r.saved;
    });

    return {
      status: built.status,
      saved,
      unfilled: built.unfilled.length,
      catalogOnly: reservation === null,
    };
  }
}

export interface PhotoScanParams {
  userId: string;
  scanId: string;
  r2Key: string;
}

/** What the client sends back with the confirm event. */
export interface ConfirmPayload {
  /** The edited list. The user may have unticked, retitled or re-quantified. */
  items: ScanItem[];
}

/** Spike 2 measured 49.7 billed neurons per photo on Qwen3.8 27B. */
const SCAN_ESTIMATE_NEURONS = 70;

/** Section 6. Spike 5 confirmed a 24-hour park works on the free plan. */
const CONFIRM_TIMEOUT = '24 hours';

/**
 * `PhotoScanWorkflow` from section 6.
 *
 * Check upload, extract, normalize, await confirmation, commit, clean up.
 *
 * Two things shape the structure. Section 6 wants "small, independently
 * retried steps, so a failed LLM or API call reruns one step, not the whole
 * job" — so each stage is its own `step.do`. And the cleanup has to run on
 * the timeout and failure paths too, which is why the body is wrapped: a
 * Workflow that throws past its cleanup leaves a 5 MB object in R2 until the
 * one-day lifecycle rule notices.
 */
export class PhotoScanWorkflow extends WorkflowEntrypoint<Env, PhotoScanParams> {
  override async run(
    event: WorkflowEvent<PhotoScanParams>,
    step: WorkflowStep,
  ): Promise<PhotoScanOutcome> {
    const { userId, scanId, r2Key } = event.payload;
    const agent = kitchenAgent(this.env, userId);

    try {
      return await this.scan(step, { userId, scanId, r2Key }, agent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.do('record failure', async () => {
        await agent.failScan(scanId, message);
        return true;
      });
      throw e;
    } finally {
      // Section 6: "Deletes the R2 object; also runs on timeout or failure."
      await step.do('clean up', async () => {
        await this.env.UPLOADS.delete(r2Key);
        return true;
      });
    }
  }

  private async scan(
    step: WorkflowStep,
    params: PhotoScanParams,
    agent: KitchenAgentStub,
  ): Promise<PhotoScanOutcome> {
    const { userId, scanId, r2Key } = params;

    // ---- Check upload -----------------------------------------------------
    //
    // Re-validated here rather than trusted from the route. The object could
    // have been replaced between the two, and a validation failure is
    // `NonRetryableError` per section 6: a 6 MB file will still be 6 MB on
    // the third attempt.
    const checked = await step.do('check upload', async () => {
      if (userIdFromKey(r2Key) !== userId) {
        throw new NonRetryableError('That upload key does not belong to this user.');
      }
      const object = await this.env.UPLOADS.get(r2Key);
      if (!object) throw new NonRetryableError('The upload is gone.');

      const bytes = new Uint8Array(await object.arrayBuffer());
      const result = validateUpload(bytes);
      if (!result.ok) throw new NonRetryableError(result.reason);
      return { type: result.type, bytes: result.bytes };
    });

    // ---- Reserve ----------------------------------------------------------
    //
    // Section 6: "The first step of every run reserves its estimated neurons
    // with BudgetKeeper. If the reservation is refused, the run ends as
    // `deferred` and the user gets an inbox message."
    const reservation = await step.do('reserve neurons', async () => {
      const r = await budgetKeeper(this.env).reserve({
        userId,
        estimate: SCAN_ESTIMATE_NEURONS,
        isDemo: false,
      });
      return r.ok
        ? { ok: true as const, reservationId: r.reservationId }
        : { ok: false as const, reason: r.reason, message: r.message };
    });

    if (!reservation.ok) {
      await step.do('tell them it is deferred', async () => {
        await agent.notifyScanDeferred(scanId, reservation.message);
        await agent.failScan(scanId, `deferred: ${reservation.reason}`);
        return true;
      });
      return { status: 'deferred', reason: reservation.reason };
    }

    // ---- Extract ----------------------------------------------------------
    const extracted = await step.do('extract', AI_STEP, async () => {
      const object = await this.env.UPLOADS.get(r2Key);
      if (!object) throw new NonRetryableError('The upload is gone.');
      const bytes = new Uint8Array(await object.arrayBuffer());

      const result = await extractItems(bytes, { vision: workersAiVision(this.env) });
      await budgetKeeper(this.env).commit(reservation.reservationId, {
        model: VISION_MODEL,
        usage: result.usage,
        userId,
      });
      return result;
    });

    // ---- Normalize --------------------------------------------------------
    //
    // No separate reservation: the classifier only fires on names the
    // taxonomy missed, and section 8 puts that at about 10 neurons against
    // the 70 already reserved for this run.
    const normalized = await step.do('normalize', AI_STEP, async () => {
      const result = await agent.normalizeScanItems(scanId, extracted.items);
      // Copied out of the RPC result: a stub's return value carries a
      // disposer, and a step result has to be plain serializable JSON.
      return { count: result.items.length, unresolved: [...result.unresolved] };
    });

    // ---- Await confirmation ----------------------------------------------
    //
    // The scan row is already `awaiting_confirm` by now: `normalizeScanItems`
    // sets it. That matters because a parked instance reports `running`, not
    // `waiting` (spike 5), so the row is the only thing that knows.
    let confirmed: ScanItem[];
    try {
      const event = await step.waitForEvent<ConfirmPayload>('await confirmation', {
        type: 'confirm',
        timeout: CONFIRM_TIMEOUT,
      });
      confirmed = event.payload.items;
    } catch {
      // The only way out of a `waitForEvent` other than the event is the
      // timeout, and section 6 says clean up on that path too — which the
      // `finally` above does.
      await step.do('expire the scan', async () => {
        const { expired } = await agent.expireScan(scanId);
        return expired;
      });
      return { status: 'timed_out', items: normalized.count };
    }

    // ---- Commit -----------------------------------------------------------
    const added = await step.do('commit', async () => {
      const result = await agent.commitScan(scanId, confirmed);
      return result.added;
    });

    return { status: 'done', items: normalized.count, added, bytes: checked.bytes };
  }
}

export type PhotoScanOutcome =
  | { status: 'done'; items: number; added: number; bytes: number }
  | { status: 'timed_out'; items: number }
  | { status: 'deferred'; reason: string };

export interface ViralRecipesParams {
  /** Set when a human started the run from /admin/pipeline/run. */
  manual?: boolean;
}

/** Section 6: "Reserve about 2,500 neurons" — the whole Sunday viral pool. */
const VIRAL_ESTIMATE_NEURONS = 2_500;

/** The ledger's user id for a run nobody in particular started. */
const VIRAL_LEDGER_USER = 'system:viral';

export interface ViralRecipesOutcome {
  status: PipelineRun['status'];
  added: number;
  duplicates: number;
  errors: number;
}

/**
 * `ViralRecipesWorkflow` from section 6.
 *
 * Open the run row, reserve, discover, filter in batches, extract one video
 * per step, then dedupe, store and close the row. The decisions — what a
 * video is worth, what counts as a duplicate, what a stored recipe may claim
 * — live in `viral/pipeline.ts` as pure phases; this class only puts them on
 * a durable schedule, so a failed extraction reruns one video, not the run.
 *
 * ponytail: section 6's embed step (Vectorize upsert, the 0.92 similarity
 * dedupe) is not here yet. D1's UNIQUE `content_hash` is the authoritative
 * dedupe either way, and nothing reads the index until recipe search moves
 * onto it.
 */
export class ViralRecipesWorkflow extends WorkflowEntrypoint<Env, ViralRecipesParams> {
  override async run(
    event: WorkflowEvent<ViralRecipesParams>,
    step: WorkflowStep,
  ): Promise<ViralRecipesOutcome> {
    const runId = event.instanceId;
    const startedAt = await step.do('open run', async () => {
      const at = new Date().toISOString();
      await openRun(this.env.DB, runId, at);
      return at;
    });
    const now = Date.parse(startedAt);

    let reservation: string | null = null;
    const errors: string[] = [];
    const fail = async (reason: string): Promise<ViralRecipesOutcome> => {
      await step.do('close run as failed', async () => {
        if (reservation) await budgetKeeper(this.env).release(reservation);
        await closeRun(
          this.env.DB,
          runId,
          'failed',
          { ...EMPTY_COUNTS, errors: [reason, ...errors].slice(0, MAX_ERRORS) },
          new Date().toISOString(),
        );
        return true;
      });
      console.log(JSON.stringify({ event: 'viral_run', runId, status: 'failed', reason }));
      return { status: 'failed', added: 0, duplicates: 0, errors: errors.length + 1 };
    };

    try {
      // ---- Preconditions and reservation --------------------------------
      //
      // The preconditions are checked before reserving, so a missing key
      // does not hold the Sunday pool for five minutes on its way to failing.
      //
      // Section 6: "If the reservation is refused, the run ends as
      // `deferred`". `pipeline_runs.status` has no such value, so a deferred
      // run is recorded as failed with the reason first in its errors.
      const reserved = await step.do('reserve neurons', async () => {
        if (!this.env.YOUTUBE_API_KEY) {
          return { ok: false as const, reason: 'YOUTUBE_API_KEY is not set.' };
        }
        if (!this.env.AI) return { ok: false as const, reason: 'No Workers AI binding.' };
        const r = await budgetKeeper(this.env).reserve({
          userId: VIRAL_LEDGER_USER,
          pool: 'viral',
          estimate: VIRAL_ESTIMATE_NEURONS,
        });
        return r.ok
          ? { ok: true as const, id: r.reservationId }
          : { ok: false as const, reason: `deferred: ${r.message}` };
      });
      if (!reserved.ok) return await fail(reserved.reason);
      reservation = reserved.id;

      // ---- Discover and rank --------------------------------------------
      const discovered = await step.do('discover', AI_STEP, async () => {
        const apiKey = this.env.YOUTUBE_API_KEY;
        if (!apiKey) throw new NonRetryableError('YOUTUBE_API_KEY is not set.');
        return discoverVideos({
          search: youtubeSearch(apiKey),
          seen: (ids) => seenVideoIds(this.env.DB, ids),
          now,
        });
      });
      errors.push(...discovered.errors);
      if (discovered.found === 0 && discovered.errors.length > 0) {
        return await fail('Every YouTube search failed.');
      }

      const model = workersAiRunner(this.env);

      // ---- Filter, ten videos a step ------------------------------------
      const keep: VideoCandidate[] = [];
      const filterUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
      for (let start = 0; start < discovered.candidates.length; start += FILTER_BATCH) {
        const batch = discovered.candidates.slice(start, start + FILTER_BATCH);
        const result = await step.do(`filter ${String(start / FILTER_BATCH + 1)}`, AI_STEP, () =>
          classifyDescriptions(batch, { model }),
        );
        keep.push(...result.keep);
        addUsage(filterUsage, result.usage);
        errors.push(...result.errors);
      }

      // ---- Extract, one video a step ------------------------------------
      //
      // Past the cap is left out of `seen_videos`: never processed, so next
      // week's run can still use it.
      const queue = keep.slice(0, MAX_RECIPES);
      const extractUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
      const judged: JudgedVideo[] = [];
      let extracted = 0;
      for (const video of queue) {
        const result = await step.do(`extract ${video.videoId}`, AI_STEP, async () => {
          const out = await extractRecipe(video, { model });
          const taxonomy = await loadTaxonomy(this.env.DB);
          return {
            usage: out.usage,
            extracted: out.draft !== null,
            judged: await judgeExtraction(video, out, taxonomy, now),
          };
        });
        addUsage(extractUsage, result.usage);
        if (result.extracted) extracted += 1;
        judged.push(result.judged);
      }

      // ---- Dedupe, store, record ----------------------------------------
      const stored = await step.do('store', async () => {
        const built = judged.flatMap((j) =>
          j.outcome === 'built' ? [{ videoId: j.videoId, recipe: j.recipe }] : [],
        );
        const known = await knownContentHashes(
          this.env.DB,
          built.map((b) => b.recipe.contentHash),
        );
        const deduped = dedupe(built, known);
        // Idempotent on `content_hash`, so a retried step cannot duplicate.
        for (const recipe of deduped.recipes) await saveRecipe(this.env.DB, recipe);

        const outcomes: [string, VideoOutcome][] = [
          ...filteredOut(discovered.candidates, keep),
          ...judged.flatMap((j): [string, VideoOutcome][] =>
            j.outcome === 'built' ? [] : [[j.videoId, j.outcome]],
          ),
          ...deduped.outcomes,
        ];
        await recordSeenVideos(
          this.env.DB,
          outcomes.map(([videoId, outcome]) => ({ videoId, firstSeen: startedAt, outcome })),
        );
        return { added: deduped.recipes.length, duplicates: deduped.duplicates };
      });

      for (const j of judged) if (j.outcome !== 'built') errors.push(j.error);

      // ---- Close the run and settle the budget --------------------------
      const counts: RunCounts = {
        found: discovered.found,
        filtered: keep.length,
        extracted,
        added: stored.added,
        duplicates: stored.duplicates,
        neurons: neuronsFor(FILTER_MODEL, filterUsage) + neuronsFor(EXTRACT_MODEL, extractUsage),
        errors: errors.slice(0, MAX_ERRORS),
      };
      await step.do('close run', async () => {
        const keeper = budgetKeeper(this.env);
        // Two models at two rates, so two ledger rows: the reservation takes
        // the extraction spend, and the filter spend is its own entry.
        await keeper.commit(reserved.id, {
          model: EXTRACT_MODEL,
          usage: extractUsage,
          userId: VIRAL_LEDGER_USER,
          pool: 'viral',
        });
        if (filterUsage.promptTokens + filterUsage.completionTokens > 0) {
          await keeper.commit(`${runId}:filter`, {
            model: FILTER_MODEL,
            usage: filterUsage,
            userId: VIRAL_LEDGER_USER,
            pool: 'viral',
          });
        }
        await closeRun(this.env.DB, runId, 'ok', counts, new Date().toISOString());
        return true;
      });

      console.log(JSON.stringify({ event: 'viral_run', runId, status: 'ok', ...counts, errors: counts.errors.length }));
      return { status: 'ok', added: counts.added, duplicates: counts.duplicates, errors: counts.errors.length };
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

const EMPTY_COUNTS: RunCounts = {
  found: 0,
  filtered: 0,
  extracted: 0,
  added: 0,
  duplicates: 0,
  neurons: 0,
  errors: [],
};

function addUsage(into: TokenUsage, more: TokenUsage): void {
  into.promptTokens += more.promptTokens;
  into.completionTokens += more.completionTokens;
}
