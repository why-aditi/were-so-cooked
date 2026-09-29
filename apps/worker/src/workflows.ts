import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ScanItem } from '@cooked/shared';
import { budgetKeeper, workersAiVision } from './agent/adapters.js';
import type { KitchenAgent } from './agent/kitchen-agent.js';
import type { Env } from './env.js';
import { EXTRACT_MODEL, extractItems } from './photo/extract.js';
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
 * Each `run` throws rather than half-working. A Workflow that returns a
 * plausible empty result is worse than one that fails: section 6's plan
 * validation would treat "no violations" as a pass.
 */

const todo = (name: string, section: string): never => {
  throw new Error(`${name} is not implemented yet — see spec ${section}.`);
};

export interface WeeklyPlanParams {
  userId: string;
  weekStart: string;
  slots: string[];
  cuisines?: string[];
}

export class WeeklyPlanWorkflow extends WorkflowEntrypoint<Env, WeeklyPlanParams> {
  override async run(_event: WorkflowEvent<WeeklyPlanParams>, _step: WorkflowStep): Promise<never> {
    return todo('WeeklyPlanWorkflow', 'section 6, WeeklyPlanWorkflow');
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

/** Section 6: "Every AI step: 3 retries, exponential backoff from 5s, 60s timeout." */
const AI_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '60 seconds',
};

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
        model: EXTRACT_MODEL,
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

export class ViralRecipesWorkflow extends WorkflowEntrypoint<Env, ViralRecipesParams> {
  override async run(_event: WorkflowEvent<ViralRecipesParams>, _step: WorkflowStep): Promise<never> {
    return todo('ViralRecipesWorkflow', 'section 6, ViralRecipesWorkflow');
  }
}
