import { WorkflowEntrypoint } from 'cloudflare:workers';
import { errText, failed, result, table, timer } from '../../_lib/report.js';

/* ------------------------------ minimal types ---------------------------- */
// The spike does not install @cloudflare/workers-types; these are the parts of
// the Workflows API it actually touches.

interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  waitForEvent<T>(name: string, opts: { type: string; timeout?: string }): Promise<{ payload: T }>;
}

interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string; output?: unknown; error?: unknown }>;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<WorkflowInstance>;
}

interface Env {
  SCAN_FLOW: WorkflowBinding;
}

interface ScanParams {
  userId: string;
  scanId: string;
  r2Key: string;
}

interface ConfirmPayload {
  items: { name: string; quantity: number; unit: string }[];
}

/* ------------------------------ the workflow ----------------------------- */

/** PhotoScanWorkflow in miniature: the section 6 step list, minus the AI calls. */
export class ScanFlow extends WorkflowEntrypoint<Env, ScanParams> {
  async run(event: { payload: ScanParams }, step: WorkflowStep) {
    const checked = await step.do('check upload', async () => ({
      ok: true,
      r2Key: event.payload.r2Key,
      checkedAt: Date.now(),
    }));

    const extracted = await step.do('extract', async () => ({
      items: [
        { name: 'paneer', quantity: 1, unit: 'kg', confidence: 0.91 },
        { name: 'dhaniya', quantity: 1, unit: 'bunch', confidence: 0.44 },
      ],
      extractedAt: Date.now(),
    }));

    const awaitingSince = await step.do('await confirmation', async () => Date.now());

    // The question this spike exists to answer.
    const confirm = await step.waitForEvent<ConfirmPayload>('confirm', {
      type: 'confirm',
      timeout: '24 hours',
    });

    const committed = await step.do('commit', async () => ({
      added: confirm.payload.items.length,
      committedAt: Date.now(),
    }));

    await step.do('clean up', async () => ({ deleted: checked.r2Key }));

    return {
      extractedCount: extracted.items.length,
      confirmedCount: committed.added,
      awaitingSince,
      resumedAt: committed.committedAt,
      pausedMs: committed.committedAt - awaitingSince,
      steps: 5,
    };
  }
}

/* -------------------------------- the spike ------------------------------ */

const meta = {
  n: 5,
  title: '`step.waitForEvent` on the free plan',
  question: 'Does `step.waitForEvent` work for the photo confirm flow on the free plan?',
  decides: 'PhotoScan design.',
};

/**
 * Budgeted in polls, not milliseconds. A free-plan Worker gets 50 subrequests
 * per invocation and every `status()` is one, so a per-second loop exhausts the
 * quota long before it learns anything. 14 polls at 3s covers 42s per phase and
 * leaves room for create + sendEvent inside the same invocation.
 */
const MAX_POLLS = 14;
const POLL_INTERVAL_MS = 3000;

async function pollUntil(
  instance: WorkflowInstance,
  predicate: (s: string) => boolean,
): Promise<{ status: string; ms: number; polls: number; output?: unknown; error?: unknown }> {
  const t = timer();
  let polls = 0;
  let last = { status: 'unknown' } as { status: string; output?: unknown; error?: unknown };
  while (polls < MAX_POLLS) {
    polls += 1;
    last = await instance.status();
    if (predicate(last.status)) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ...last, ms: t(), polls };
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      const transitions: [string, string, number][] = [];

      const tCreate = timer();
      const instance = await env.SCAN_FLOW.create({
        params: { userId: 'spike5', scanId: 'scan_1', r2Key: 'uploads/spike5/one.jpg' },
      });
      transitions.push(['created', instance.id, tCreate()]);

      // 1. Let it run up to the waitForEvent call.
      //
      // There is no `waiting` status to poll for: an instance parked at
      // `step.waitForEvent` still reports `running`, and only
      // `wrangler workflows instances describe` reveals the step as
      // "Waiting for event". So the pause is confirmed by what happens next —
      // if the instance were not parked, the event would have nothing to
      // resume and the run would never complete.
      await new Promise((r) => setTimeout(r, 6000));
      const paused = await pollUntil(instance, () => true);
      transitions.push([`status before event: ${paused.status}`, '1 poll', paused.ms]);

      const reachedWaiting = paused.status === 'running' || paused.status === 'waiting';

      // 2. Does an event delivered later resume it?
      let sendErr = '';
      let resumeMs = -1;
      let finalStatus = paused.status;
      let output: unknown = null;
      if (reachedWaiting) {
        // Hold briefly, so the resume is genuinely event-driven rather than a
        // race with the workflow still starting up.
        await new Promise((r) => setTimeout(r, 3000));
        const tSend = timer();
        try {
          await instance.sendEvent({
            type: 'confirm',
            payload: {
              items: [
                { name: 'paneer', quantity: 1, unit: 'kg' },
                { name: 'dhaniya', quantity: 1, unit: 'bunch' },
              ],
            },
          });
        } catch (e) {
          sendErr = errText(e);
        }
        const done = await pollUntil(
          instance,
          (s) => s === 'complete' || s === 'errored' || s === 'terminated',
        );
        resumeMs = tSend();
        finalStatus = done.status;
        output = done.output ?? done.error ?? null;
        transitions.push([`reached ${done.status}`, `${done.polls} polls`, done.ms]);
      }

      const works = finalStatus === 'complete';
      const answer = works
        ? `**Yes.** A Workflow on this account parked at \`step.waitForEvent\` with a 24-hour ` +
          `timeout and ran to completion ${resumeMs} ms after \`sendEvent\` was called. ` +
          `Note that it reports \`running\`, not \`waiting\`, the whole time it is parked — there ` +
          `is no waiting status to poll for, so the UI must track "awaiting confirm" itself. ` +
          `\`PhotoScanWorkflow\` can be built exactly as section 6 describes: extract, pause for ` +
          `the user's confirm list, commit, clean up. No polling loop or separate "pending scans" ` +
          `table is needed.`
        : reachedWaiting
          ? `**It pauses but did not resume.** The instance reached \`${paused.status}\` and then ` +
            `ended at \`${finalStatus}\`${sendErr ? ` after sendEvent failed: ${sendErr}` : ''}. ` +
            `Do not build the confirm flow on \`waitForEvent\` — keep the scan in the ` +
            `\`awaiting_confirm\` state in the agent's SQLite and have the confirm POST do the commit ` +
            `directly.`
          : `**No.** The instance never reached a waiting state; it ended at \`${paused.status}\`. ` +
            `Take the fallback: the scan row stays \`awaiting_confirm\` in the agent's SQLite and ` +
            `\`POST /api/scans/:id/confirm\` commits without a Workflow in the loop.`;

      const body = `## Timeline

${table(
  ['Transition', 'Detail', 'Elapsed'],
  transitions.map(([a, b, c]) => [a, b, `${c} ms`]),
)}

## Measured

${table(
  ['Measurement', 'Value'],
  [
    ['Instance id', instance.id],
    ['Reached a waiting state', reachedWaiting ? `yes (\`${paused.status}\`)` : `no (\`${paused.status}\`)`],
    ['Time from create to waiting', `${paused.ms} ms`],
    ['sendEvent error', sendErr || 'none'],
    ['Resume latency after sendEvent', resumeMs < 0 ? 'n/a' : `${resumeMs} ms`],
    ['Final status', finalStatus],
    ['Workflow output', JSON.stringify(output)],
    ['Steps consumed', '5 of the 3,000 per day free allowance'],
    ['Timeout used', '24 hours, as section 6 specifies'],
  ],
)}

## What this changes

- **PhotoScan design:** ${works ? 'keep `step.waitForEvent("confirm")` with the 24-hour timeout.' : 'drop `waitForEvent`; hold state in the agent and commit from the confirm route.'}
- **Step budget:** this flow costs 5 steps. At 3,000 steps a day that is 600 scans,
  far above anything a reviewer will do. Section 12's Workflows row holds.
- **R2 cleanup:** ${works ? 'the clean-up step runs on the resume path. Timeout and failure paths still need their own cleanup, which this run did not exercise.' : 'cleanup has to move to a cron sweep over the 1-day R2 lifecycle rule.'}

## Not covered

The 24-hour **timeout** path. Exercising it means waiting a day, so it gets a
separate long-running test rather than a spike. The 1-day R2 lifecycle rule in
section 4 is the backstop either way.
`;

      return result({ ...meta, answer, body });
    } catch (e) {
      return failed({
        ...meta,
        error: e,
        note:
          '## Reading this failure\n\n' +
          'Workflows may not be reachable through `wrangler dev --remote`. If the error is about ' +
          'the binding rather than the plan, deploy the spike instead:\n\n' +
          '```\ncd spikes/5-waitforevent\nnpx wrangler deploy\ncurl https://cooked-spike5-waitforevent.<subdomain>.workers.dev/ > RESULT.md\nnpx wrangler delete --name cooked-spike5-waitforevent\n```\n',
      });
    }
  },
};
