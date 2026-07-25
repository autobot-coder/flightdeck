/**
 * Flightdeck test runner — `npm test`.
 *
 * There is no test framework here on purpose: every harness in this directory is
 * self-contained, prints its own assertion lines, and exits non-zero on failure. This
 * runner just discovers them, runs them SERIALLY, and aggregates the exit codes.
 *
 * Serial is deliberate: several harnesses boot a real server on a fixed port or spawn
 * stub CLIs, so running them concurrently would make them fight over ports.
 *
 * Adding a test: drop a file in tests/ named *-test.{mts,ts,cjs,sh}. It is picked up
 * automatically. Exit 0 = pass, non-zero = fail. Helpers and fixtures are skipped by
 * the naming convention (see SKIP below).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// Not tests: this runner, the probe nvm-fix-test spawns as a child, and fixture dirs.
const SKIP = new Set(['run.mjs', 'nvm-probe.mts', 'base29']);

const only = process.argv.slice(2);

const files = readdirSync(HERE)
  .filter((f) => !SKIP.has(f))
  .filter((f) => !statSync(join(HERE, f)).isDirectory())
  .filter((f) => /-test\.(mts|ts|cjs|sh)$/.test(f))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

if (files.length === 0) {
  console.error(only.length ? `no test matches: ${only.join(', ')}` : 'no tests found in tests/');
  process.exit(1);
}

/** Each harness picks its own interpreter by extension; tsx is a runtime dependency. */
function commandFor(file) {
  const p = join(HERE, file);
  if (file.endsWith('.sh')) return ['bash', [p]];
  if (file.endsWith('.cjs')) return [process.execPath, [p]];
  return [process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), p]];
}

/**
 * 77 = SKIP: the harness ran but could not exercise its subject (a fixture it cannot
 * vendor is absent). Reported separately and never folded into "passed" — a suite that
 * skipped something must not read as full coverage.
 */
const SKIP_CODE = 77;

const results = [];
for (const file of files) {
  const [cmd, args] = commandFor(file);
  process.stdout.write(`\n${'='.repeat(72)}\n${file}\n${'='.repeat(72)}\n`);
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
  // A harness killed by a signal has no exit code; treat that as a failure, not a pass.
  const code = r.status === null ? 1 : r.status;
  results.push({ file, code, signal: r.signal ?? null });
}

const passed = results.filter((r) => r.code === 0);
const skipped = results.filter((r) => r.code === SKIP_CODE);
const failed = results.filter((r) => r.code !== 0 && r.code !== SKIP_CODE);

console.log(`\n${'='.repeat(72)}\nSUMMARY — ${results.length} harnesses\n${'='.repeat(72)}`);
for (const r of results) {
  const mark = r.code === 0 ? '✓' : r.code === SKIP_CODE ? '−' : '✗';
  const status =
    r.code === 0 ? 'PASS'
    : r.code === SKIP_CODE ? 'SKIP (no fixture — see the harness header)'
    : r.signal ? `FAIL (signal ${r.signal})`
    : `FAIL (exit ${r.code})`;
  console.log(`  ${mark} ${r.file.padEnd(30)} ${status}`);
}

const tally = `${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`;
console.log(failed.length === 0 ? `\n✓ ${tally}` : `\n✗ ${tally} — ${failed.map((f) => f.file).join(', ')}`);
if (skipped.length > 0) {
  console.log(`  note: ${skipped.length} harness(es) were SKIPPED and proved nothing this run.`);
}
process.exit(failed.length === 0 ? 0 : 1);
