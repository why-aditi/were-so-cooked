import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORTS_DIR } from './seed.js';

/**
 * Section 13: "Each live run writes a report to `evals/reports/` that is
 * committed."
 *
 * Recorded runs write one too. A recorded report costs nothing and makes
 * the two modes comparable — the interesting question after a live run is
 * always "did anything move", and that needs a baseline in the same shape.
 */

export interface EvalReport {
  suite: string;
  mode: 'recorded' | 'live';
  ranAt: string;
  cases: number;
  passed: number;
  failed: number;
  /** Neurons spent. Always 0 in recorded mode; that is the point of it. */
  neurons: number;
  passBar: string;
  failures: { id: string; reason: string }[];
  notes?: string[];
}

export function writeReport(report: EvalReport): string {
  mkdirSync(REPORTS_DIR, { recursive: true });

  // Recorded reports overwrite; live runs keep every one, because a live
  // report is evidence about a specific moment and a specific spend.
  const stamp = report.ranAt.replace(/[:.]/g, '-');
  const name =
    report.mode === 'live'
      ? `${report.suite}-live-${stamp}.md`
      : `${report.suite}-recorded.md`;
  const path = join(REPORTS_DIR, name);

  writeFileSync(path, render(report), 'utf8');
  return path;
}

function render(report: EvalReport): string {
  const lines = [
    `# ${report.suite} eval — ${report.mode}`,
    '',
    // A recorded report is a committed baseline, and CI checks that a run
    // reproduces it byte for byte. A timestamp would make every run a diff
    // and the check permanently red, so only live reports carry one —
    // there the moment and the spend are the whole point.
    ...(report.mode === 'live' ? [`**Ran:** ${report.ranAt}`] : []),
    `**Pass bar:** ${report.passBar}`,
    `**Result:** ${report.failed === 0 ? 'PASS' : 'FAIL'} — ${report.passed}/${report.cases} cases`,
    `**Neurons spent:** ${report.neurons}`,
    '',
  ];

  if (report.notes?.length) {
    lines.push('## Notes', '', ...report.notes.map((n) => `- ${n}`), '');
  }

  if (report.failures.length > 0) {
    lines.push('## Failures', '');
    lines.push('| Case | Why |', '| --- | --- |');
    for (const failure of report.failures) {
      lines.push(`| \`${failure.id}\` | ${failure.reason.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  } else {
    lines.push('No failures.', '');
  }

  return lines.join('\n');
}
