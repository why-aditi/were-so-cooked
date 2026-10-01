/**
 * Creates every Cloudflare resource the Worker binds to, then loads seed data.
 *
 * Section 13: "`npm run bootstrap` creates the D1 databases, Vectorize index,
 * R2 bucket and AI Gateway, sets the R2 lifecycle rule and loads the seed data.
 * It is safe to run twice."
 *
 * Idempotence is the whole point, so every step reads before it writes and
 * treats "already exists" as success. The script also writes the created D1
 * database IDs back into wrangler.jsonc, because that file ships with
 * PLACEHOLDER_SET_BY_BOOTSTRAP and a deploy fails without real IDs.
 *
 *   pnpm bootstrap                 # dev
 *   pnpm bootstrap --env staging
 *   pnpm bootstrap --env production
 *
 * Needs `wrangler login` for resource creation. The AI Gateway step needs
 * CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (AI Gateway: Edit) because
 * wrangler has no `ai gateway` subcommand; without them it says so and skips.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = join(ROOT, 'wrangler.jsonc');

type EnvName = 'dev' | 'staging' | 'production';

const SUFFIX: Record<EnvName, string> = {
  dev: '-dev',
  staging: '-staging',
  production: '',
};

interface Resources {
  d1: string;
  vectorize: string;
  r2: string;
  gateway: string;
}

function resourcesFor(env: EnvName): Resources {
  const s = SUFFIX[env];
  return {
    d1: `cooked-db${s}`,
    vectorize: `cooked-recipes${s}`,
    r2: `cooked-uploads${s}`,
    // One gateway serves every environment: it is a proxy with a cache, and
    // section 12 wants demo responses cached across deploys, not per-branch.
    gateway: 'cooked-gw',
  };
}

/* ------------------------------ tiny helpers ----------------------------- */

const log = (step: string, msg: string) => console.log(`  ${step.padEnd(22)} ${msg}`);

function wrangler(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // wrangler prefers CLOUDFLARE_API_TOKEN over the OAuth login, and a
    // narrowly-scoped token breaks resource creation. Keep it out.
    env: { ...process.env, CLOUDFLARE_API_TOKEN: undefined },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * The line that says what went wrong.
 *
 * wrangler ends a failure with a "report this at github.com/…" footer and a
 * log-file path, so the tail of its output is the one part guaranteed not to
 * be the error. Its own `✘ [ERROR]` line is, and the message carries on for a
 * line or two after it.
 */
function errorLine(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => /\[ERROR\]/.test(l));
  if (at === -1) return out.trim().slice(-300);
  return lines
    .slice(at, at + 4)
    .filter((l) => l && !/^If you think this is a bug|^🪵/.test(l))
    .join(' ')
    .replace(/^✘?\s*\[ERROR\]\s*/, '')
    .slice(0, 400);
}

/**
 * Whether a resource list mentions exactly this name.
 *
 * Not `\b${name}\b`: a hyphen is a word boundary, so `cooked-recipes`
 * matched `cooked-recipes-dev` and production was reported as existing
 * when only dev did. Resource names are letters, digits, `-` and `_`, so
 * neither neighbour may be one of those.
 */
function listsExactly(out: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, 'm').test(out);
}

/** "already exists" is success for an idempotent script. */
const alreadyExists = (out: string) =>
  /already exists|duplicate|already been taken|10001|already created/i.test(out);

/* --------------------------------- steps --------------------------------- */

/** @returns the database's UUID, needed for wrangler.jsonc. */
function createD1(name: string): string | null {
  const list = wrangler(['d1', 'list', '--json']);
  if (list.ok) {
    try {
      const rows = JSON.parse(list.out.slice(list.out.indexOf('['))) as {
        uuid: string;
        name: string;
      }[];
      const found = rows.find((d) => d.name === name);
      if (found) {
        log('d1', `${name} already exists (${found.uuid})`);
        return found.uuid;
      }
    } catch {
      // fall through to create; the create call reports its own errors
    }
  }

  const created = wrangler(['d1', 'create', name]);
  if (!created.ok && !alreadyExists(created.out)) {
    log('d1', `FAILED to create ${name}: ${created.out.trim().slice(-300)}`);
    return null;
  }
  const uuid = created.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  log('d1', uuid ? `created ${name} (${uuid})` : `created ${name}, but no id in output`);
  return uuid ?? null;
}

function createVectorize(name: string): boolean {
  const list = wrangler(['vectorize', 'list']);
  if (list.ok && listsExactly(list.out, name)) {
    log('vectorize', `${name} already exists`);
    return true;
  }
  // 1024 dimensions and cosine, to match bge-m3 (section 4). Spike 1 confirmed
  // a free account can create and query this.
  const r = wrangler([
    'vectorize',
    'create',
    name,
    '--dimensions=1024',
    '--metric=cosine',
    '--description=Recipe catalog embeddings (bge-m3)',
  ]);
  if (r.ok || alreadyExists(r.out)) {
    log('vectorize', `created ${name} (1024 dims, cosine)`);
    return true;
  }
  log('vectorize', `FAILED: ${r.out.trim().slice(-300)}`);
  return false;
}

function createR2(name: string): boolean {
  const list = wrangler(['r2', 'bucket', 'list']);
  if (list.ok && listsExactly(list.out, name)) {
    log('r2', `${name} already exists`);
  } else {
    const r = wrangler(['r2', 'bucket', 'create', name]);
    if (!r.ok && !alreadyExists(r.out)) {
      log('r2', `FAILED: ${r.out.trim().slice(-300)}`);
      return false;
    }
    log('r2', `created ${name}`);
  }

  // Section 4: objects are deleted when a scan finishes, with a 1-day
  // lifecycle rule as the backstop.
  //
  // Read before write. `lifecycle add` fetches the bucket's rules, appends
  // this one and writes them all back, so a second run sends a duplicate
  // rule id and the API rejects the whole set — it is not a no-op.
  const RULE = 'expire-uploads-1d';
  const listed = wrangler(['r2', 'bucket', 'lifecycle', 'list', name]);
  if (listed.ok && listed.out.includes(RULE)) {
    log('r2 lifecycle', 'uploads/ expires after 1 day (already set)');
    return true;
  }

  const rule = wrangler([
    'r2',
    'bucket',
    'lifecycle',
    'add',
    name,
    `--name=${RULE}`,
    '--expire-days=1',
    '--prefix=uploads/',
  ]);
  if (rule.ok || alreadyExists(rule.out)) {
    log('r2 lifecycle', 'uploads/ expires after 1 day');
    return true;
  }
  log('r2 lifecycle', `could not set: ${errorLine(rule.out)}`);
  log('r2 lifecycle', 'set it by hand in the dashboard; uploads will accumulate until then');
  return false;
}

async function createGateway(name: string): Promise<boolean> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    log('ai gateway', 'skipped — set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (AI Gateway: Edit)');
    return false;
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const existing = await fetch(`${base}/${name}`, { headers });
  if (existing.ok) {
    log('ai gateway', `${name} already exists`);
    return true;
  }

  const res = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: name,
      // Spike 6 measured a cache HIT at 177 ms against 2,488 ms cold, costing
      // zero neurons. One hour is enough for a reviewer session.
      cache_ttl: 3600,
      cache_invalidate_on_update: false,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: 'fixed',
    }),
  });
  const json = (await res.json()) as { success?: boolean; errors?: { message?: string }[] };
  if (json.success || alreadyExists(JSON.stringify(json.errors ?? []))) {
    log('ai gateway', `created ${name} (cache_ttl 3600s)`);
    return true;
  }
  log('ai gateway', `FAILED: ${(json.errors ?? []).map((e) => e.message).join('; ')}`);
  return false;
}

/**
 * Writes the real database id into wrangler.jsonc in place of the placeholder.
 * Targeted replacement rather than a JSON round-trip, because the file is JSONC
 * and its comments carry the reasoning.
 */
function writeDatabaseId(dbName: string, uuid: string): void {
  const before = readFileSync(CONFIG, 'utf8');
  const pattern = new RegExp(
    `("database_name":\\s*"${dbName}",\\s*\\n\\s*"database_id":\\s*)"[^"]*"`,
    'm',
  );
  if (!pattern.test(before)) {
    log('wrangler.jsonc', `could not find the database_id line for ${dbName}; set it by hand`);
    return;
  }
  const after = before.replace(pattern, `$1"${uuid}"`);
  if (after === before) {
    log('wrangler.jsonc', `${dbName} id already current`);
    return;
  }
  writeFileSync(CONFIG, after);
  log('wrangler.jsonc', `set database_id for ${dbName}`);
}

function applyMigrations(env: EnvName, dbName: string): boolean {
  const args = ['d1', 'migrations', 'apply', dbName, '--remote'];
  if (env !== 'dev') args.push('--env', env);
  const r = wrangler(args);
  if (r.ok) {
    log('migrations', /No migrations to apply/i.test(r.out) ? 'already up to date' : 'applied');
    return true;
  }
  log('migrations', `FAILED: ${r.out.trim().slice(-300)}`);
  return false;
}

/**
 * Seed data is idempotent by construction: every statement in seed/*.sql must
 * use INSERT OR REPLACE / ON CONFLICT so a second run overwrites rather than
 * duplicating. Files run in filename order.
 */
function loadSeed(env: EnvName, dbName: string): boolean {
  const dir = join(ROOT, 'seed');
  const manifest = join(dir, 'MANIFEST');
  const files = existsSync(manifest)
    ? readFileSync(manifest, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [];
  if (files.length === 0) {
    log('seed', 'nothing listed in seed/MANIFEST yet');
    return true;
  }
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) {
      log('seed', `MANIFEST lists ${f}, which does not exist — skipping`);
      continue;
    }
    const args = ['d1', 'execute', dbName, '--remote', `--file=${path}`, '--yes'];
    if (env !== 'dev') args.push('--env', env);
    const r = wrangler(args);
    log('seed', r.ok ? `loaded ${f}` : `FAILED ${f}: ${errorLine(r.out)}`);
    if (!r.ok) return false;
  }
  return true;
}

/* ---------------------------------- main --------------------------------- */

const envArg = process.argv.indexOf('--env');
const env = (envArg === -1 ? 'dev' : process.argv[envArg + 1]) as EnvName;
if (!['dev', 'staging', 'production'].includes(env)) {
  console.error(`Unknown environment "${env}". Use dev, staging or production.`);
  process.exit(1);
}

const res = resourcesFor(env);
console.log(`\nBootstrapping "${env}" — safe to re-run.\n`);

const uuid = createD1(res.d1);
if (uuid) writeDatabaseId(res.d1, uuid);

const okVectorize = createVectorize(res.vectorize);
const okR2 = createR2(res.r2);
const okGateway = await createGateway(res.gateway);

const okMigrations = uuid ? applyMigrations(env, res.d1) : false;
const okSeed = okMigrations ? loadSeed(env, res.d1) : false;

const failures = [
  !uuid && 'D1',
  !okVectorize && 'Vectorize',
  !okR2 && 'R2',
  !okGateway && 'AI Gateway',
  !okMigrations && 'migrations',
  !okSeed && 'seed',
].filter(Boolean);

console.log('');
if (failures.length === 0) {
  console.log(`Done. "${env}" is ready.\n`);
} else {
  console.log(`Done with gaps: ${failures.join(', ')}. Re-run after fixing; nothing above is destructive.\n`);
  process.exit(1);
}
