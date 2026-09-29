#!/usr/bin/env node
/**
 * Runs one week-1 spike (or all six) against a live Cloudflare account and
 * saves its answer to spikes/<n>/RESULT.md.
 *
 * Each spike Worker returns a finished RESULT.md body as text/markdown, so this
 * runner only has to provision, start `wrangler dev --remote`, GET `/`, save the
 * body, and tear down. No templating, no per-spike scripts.
 *
 *   node spikes/run.mjs 4
 *   node spikes/run.mjs all
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root. wrangler CLI calls run from here: `spikes/` holds a `.env` that
 *  wrangler would auto-load and then authenticate with, and the spike token has
 *  only two permissions. */
const ROOT = dirname(HERE);
const IS_WIN = process.platform === 'win32';

/**
 * The repo's own wrangler, invoked directly rather than through `npx --yes`.
 *
 * Six spikes each running `npx --yes wrangler` stage the same package into the
 * shared npm cache concurrently, and on Windows that races: the run of
 * 2026-09-25 failed all six with `npm error code EBUSY, syscall rename`.
 * A pinned devDependency makes the version reproducible too, which matters for
 * results that get quoted back into the spec.
 */
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Spikes that read the account over the REST/GraphQL API need credentials. */
const CREDENTIAL_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];

/**
 * Credentials come from the environment or from `spikes/.env`, which is
 * gitignored. The file exists so an API token can be pasted in once by hand
 * instead of being exported into every shell that runs a spike.
 *
 * They are kept in this object and deliberately NOT written into `process.env`:
 * wrangler prefers CLOUDFLARE_API_TOKEN over the OAuth credentials from
 * `wrangler login`, so leaking the spike token into a wrangler child process
 * replaces a fully-scoped login with a two-permission token and every Workers
 * API call 403s. The token reaches the Worker through `.dev.vars` only.
 */
const CREDS = {};

function loadCredentials() {
  for (const k of CREDENTIAL_VARS) if (process.env[k]) CREDS[k] = process.env[k];
  const path = join(HERE, '.env');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (value && !CREDS[m[1]]) CREDS[m[1]] = value;
    }
    console.log(`Loaded credentials from ${path}.`);
  }
}

/**
 * The environment for a wrangler child process: the account id helps wrangler
 * skip its account lookup, but the API token must not be there. See CREDS.
 */
function wranglerEnv() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (CREDS.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = CREDS.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

loadCredentials();

const SPIKES = {
  1: {
    dir: '1-vectorize',
    port: 8801,
    title: 'Vectorize on a free account',
    // If this fails the spike still runs; the binding error is the answer.
    pre: [['vectorize', 'create', 'cooked-spike1', '--dimensions=1024', '--metric=cosine']],
    post: [['vectorize', 'delete', 'cooked-spike1', '--force']],
    credentials: false,
    budget: 'about 1 neuron (6 short embeddings)',
  },
  2: {
    dir: '2-vision-tokens',
    port: 8802,
    title: 'Photo extraction: which vision model, at what cost',
    pre: [],
    post: [],
    credentials: true,
    budget: 'about 400 neurons (3 models x 4 calls)',
  },
  3: {
    dir: '3-tool-calling',
    port: 8803,
    title: 'Llama 3.3 70B tool-calling reliability',
    pre: [],
    post: [],
    credentials: false,
    budget: 'about 700 neurons (24 calls on the 70B model)',
  },
  4: {
    dir: '4-neurons',
    port: 8804,
    title: 'Real neurons per chat turn and per plan',
    pre: [],
    post: [],
    credentials: true,
    budget: 'about 1,500 neurons (3 chat turns + 2 plan calls + 1 repair)',
  },
  5: {
    dir: '5-waitforevent',
    port: 8805,
    title: '`step.waitForEvent` on the free plan',
    pre: [],
    post: [],
    credentials: false,
    budget: 'no neurons; 5 Workflow steps',
  },
  6: {
    dir: '6-ai-gateway',
    port: 8806,
    title: 'AI Gateway caching on the free plan',
    pre: [],
    post: [],
    credentials: true,
    budget: 'about 20 neurons (up to 4 calls on the 8B model, fewer if the cache hits)',
  },
};

function wrangler(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: opts.cwd ?? ROOT,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: wranglerEnv(),
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function assertAuthenticated() {
  const { out } = await wrangler(['whoami']);
  if (/not authenticated/i.test(out)) {
    console.error(
      '\nNot authenticated. These spikes measure a live account, so there is nothing to\n' +
        'measure without one. Run this in your shell first:\n\n  npx wrangler login\n',
    );
    process.exit(1);
  }
  const account = out.match(/([0-9a-f]{32})/i)?.[1];
  console.log(`Authenticated${account ? ` (account ${account.slice(0, 6)}…)` : ''}.`);
}

function startDev(spike) {
  const cwd = join(HERE, spike.dir);
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--port', String(spike.port), '--ip', '127.0.0.1'],
    { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: wranglerEnv() },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, getLog: () => log };
}

function stopDev(child) {
  if (IS_WIN && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Readiness is read from wrangler's own output, never by calling the Worker.
 * A spike Worker runs its whole experiment on any request to any path, so an
 * HTTP probe does not test the port — it starts an experiment, and a polling
 * probe starts one per tick. Every AI call that costs is on the other side of
 * that request.
 */
async function waitForReady(port, getLog, timeoutMs = 180_000) {
  const start = Date.now();
  const ready = new RegExp(`Ready on https?://[^\\s]*:${port}`, 'i');
  while (Date.now() - start < timeoutMs) {
    const log = getLog();
    if (ready.test(log)) return true;
    if (/ERROR|failed to start|not authenticated/i.test(log)) {
      throw new Error(`wrangler dev failed to start:\n${log.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wrangler dev did not come up on port ${port} in ${timeoutMs / 1000}s`);
}

/**
 * Passes account credentials to the Worker. `.dev.vars` is the only route
 * wrangler offers for this, so it is written just before the run and deleted
 * straight after; it is already in .gitignore.
 */
function writeDevVars(spike) {
  const present = CREDENTIAL_VARS.filter((k) => CREDS[k]);
  if (present.length === 0) return null;
  const path = join(HERE, spike.dir, '.dev.vars');
  writeFileSync(path, present.map((k) => `${k}=${CREDS[k]}`).join('\n') + '\n');
  return path;
}

/**
 * Neurons billed in the last rolling 24 hours, or null when the budget is fine
 * or cannot be checked.
 *
 * Workers AI enforces a rolling window, not a calendar day. Measured the hard
 * way: 50,583 neurons were billed in the 15:00Z hour on 2026-09-23, and at
 * 05:04Z the next day the GraphQL "today" figure read 0 while live calls still
 * returned AiError 4006. Checking the UTC day would have cleared this run to
 * proceed and overwrite six good result files with budget errors.
 */
async function preflight() {
  const token = CREDS.CLOUDFLARE_API_TOKEN;
  const account = CREDS.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.log('No credentials, so the neuron budget cannot be checked before running.');
    return null;
  }
  const query = `query($a: String!, $s: Time!, $e: Time!) {
    viewer { accounts(filter: { accountTag: $a }) {
      aiInferenceAdaptiveGroups(limit: 200, filter: { datetime_geq: $s, datetime_leq: $e }) {
        sum { totalNeurons }
      }
    } }
  }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          a: account,
          s: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          e: new Date().toISOString(),
        },
      }),
    });
    const json = await res.json();
    if (json.errors?.length) {
      console.log(`Budget pre-check failed (${json.errors[0].message}); running anyway.`);
      return null;
    }
    const rows = json.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    const used = rows.reduce((n, r) => n + (r.sum?.totalNeurons ?? 0), 0);
    console.log(`Neurons used in the last 24h: ${Math.round(used).toLocaleString('en-US')} / 10,000.`);
    return used >= 10000 ? used : null;
  } catch (e) {
    console.log(`Budget pre-check errored (${e.message}); running anyway.`);
    return null;
  }
}

class BudgetExhausted extends Error {
  constructor(n) {
    super(`Spike ${n} hit the daily neuron cap`);
    this.spike = n;
  }
}

async function runSpike(n) {
  const spike = SPIKES[n];
  const cwd = join(HERE, spike.dir);
  console.log(`\n=== Spike ${n}: ${spike.title} ===`);
  console.log(`    budget: ${spike.budget}`);

  if (spike.credentials && !CREDENTIAL_VARS.every((k) => CREDS[k])) {
    console.log(
      `    note: ${CREDENTIAL_VARS.join(' and ')} are not set. The spike will still run and will\n` +
        `          say in RESULT.md which measurements it could not take.`,
    );
  }

  for (const args of spike.pre) {
    console.log(`    pre: wrangler ${args.join(' ')}`);
    const { code, out } = await wrangler(args);
    if (code !== 0) console.log(`    pre step exited ${code} (continuing):\n${out.trim().slice(-600)}`);
  }

  const devVarsPath = writeDevVars(spike);
  const { child, getLog } = startDev(spike);
  let markdown;
  try {
    await waitForReady(spike.port, getLog);
    console.log(`    running the experiment…`);
    const res = await fetch(`http://127.0.0.1:${spike.port}/`, {
      signal: AbortSignal.timeout(900_000),
    });
    markdown = await res.text();
  } catch (e) {
    markdown =
      `# Spike ${n} — ${spike.title}\n\n` +
      `**The spike could not be run.**\n\n\`\`\`\n${e.message}\n\`\`\`\n\n` +
      `### wrangler dev output\n\n\`\`\`\n${getLog().slice(-4000)}\n\`\`\`\n`;
  } finally {
    stopDev(child);
    if (devVarsPath) rmSync(devVarsPath, { force: true });
  }

  mkdirSync(cwd, { recursive: true });
  const out = join(cwd, 'RESULT.md');
  writeFileSync(out, markdown);
  console.log(`    wrote ${out}`);

  if (/AiError:?\s*4006|used up your daily free allocation/.test(markdown)) {
    throw new BudgetExhausted(n);
  }

  for (const args of spike.post) {
    console.log(`    post: wrangler ${args.join(' ')}`);
    await wrangler(args);
  }
}

const arg = process.argv[2];
if (!arg || (arg !== 'all' && !SPIKES[arg])) {
  console.error('usage: node spikes/run.mjs <1|2|3|4|5|6|all>');
  process.exit(1);
}

await assertAuthenticated();
const targets = arg === 'all' ? Object.keys(SPIKES) : [arg];

if (arg === 'all') {
  console.log(
    '\nRunning all six in order. Spike 4 measures billed neurons as a before/after\n' +
      'delta, so nothing else may call Workers AI on this account while it runs —\n' +
      'which is why these are sequential rather than parallel.\n',
  );
}

const blocked = await preflight();
if (blocked !== null) {
  console.error(
    `\nRefusing to run: ${Math.round(blocked).toLocaleString('en-US')} of the 10,000 neuron` +
      `\nallowance has been used in the last 24 hours. Every call would return AiError 4006` +
      `\nand overwrite a good RESULT.md with a budget error.` +
      `\n\nWorkers AI enforces a ROLLING 24-hour window, not a calendar day — the dashboard's` +
      `\n"resets at 00:00 UTC" describes its own display, not the limit. Usage ages out one` +
      `\nhour at a time. Re-run once the figure above is under 10,000.\n`,
  );
  process.exit(2);
}

for (const n of targets) {
  try {
    await runSpike(n);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    console.error(
      `\nStopped at spike ${e.spike}: the account hit the neuron cap mid-run. Later spikes were` +
        `\nnot started, so their RESULT.md files still hold their previous answers.\n`,
    );
    process.exit(2);
  }
}

console.log('\nDone. Answers are in spikes/<n>/RESULT.md.');
