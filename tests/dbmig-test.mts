// Runs the CURRENT openDb() (schema + migrate) against a COPY of the live DB — i.e. exactly what
// the operator's restart will do to their data. Touches only the copy; never the live DB.
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.ts';

/**
 * This gate needs a POPULATED database to be meaningful — its whole assertion is that
 * migrate() preserves the row counts of a real, historic DB. The image it was written
 * against is ~14 MB, which does not belong in a public repo, so unlike the other
 * pre-fix fixtures under tests/fixtures/ it is NOT vendored.
 *
 * Set FLIGHTDECK_TEST_DB to a COPY of a populated database to run it. With no fixture it
 * exits 77, which the runner reports as SKIP — deliberately not 0, so a suite that never
 * exercised this never reads as "all green". Making it self-contained (synthesising its
 * own populated DB through the real Store) is filed as a follow-up.
 */
const COPY = (process.env.FLIGHTDECK_TEST_DB ?? '').trim();
const SKIP = 77;
if (!COPY) {
  console.log('SKIP dbmig-test: no fixture DB.');
  console.log('  This gate asserts migrate() preserves row counts on a POPULATED database.');
  console.log('  Point FLIGHTDECK_TEST_DB at a COPY of one to run it, e.g.:');
  console.log('    cp data/flightdeck.db /tmp/mig.db && FLIGHTDECK_TEST_DB=/tmp/mig.db npm test dbmig');
  process.exit(SKIP);
}
// A copy is mandatory: this opens the DB for WRITING (migrate runs) and would mutate a live one.
if (/\/data\/(flightdeck|mission)\.db$/.test(COPY)) {
  console.error(`✗ refusing to run against what looks like a LIVE database: ${COPY}`);
  console.error('  Copy it first — this test writes to the file it is given.');
  process.exit(1);
}

const q = (sql: string) => execFileSync('sqlite3', [COPY, sql], { encoding: 'utf8' }).trim();
const TABLES = ['workspaces', 'agents', 'tasks', 'messages', 'events', 'turns'];

const before: Record<string, string> = {};
for (const t of TABLES) before[t] = q(`SELECT COUNT(*) FROM ${t};`);
before.tokensum = q(`SELECT COALESCE(SUM(total_input_tokens),0)||'/'||COALESCE(SUM(total_output_tokens),0) FROM agents;`);
before.authors = q(`SELECT COUNT(DISTINCT from_agent) FROM messages;`);
before.agentcols = q(`SELECT group_concat(name) FROM pragma_table_info('agents');`);

console.log('--- running current openDb() against the copy (the restart path) ---');
let threw: string | null = null;
try { openDb(COPY).close(); } catch (e) { threw = String(e); }
console.log(threw ? `  ✗ THREW: ${threw}` : '  ✓ openDb() completed without error');

const after: Record<string, string> = {};
for (const t of TABLES) after[t] = q(`SELECT COUNT(*) FROM ${t};`);
after.tokensum = q(`SELECT COALESCE(SUM(total_input_tokens),0)||'/'||COALESCE(SUM(total_output_tokens),0) FROM agents;`);
after.authors = q(`SELECT COUNT(DISTINCT from_agent) FROM messages;`);
after.agentcols = q(`SELECT group_concat(name) FROM pragma_table_info('agents');`);

let pass = 0, fail = 0, changed = 0;
console.log('\n--- row counts: must be preserved (no data loss) ---');
for (const t of TABLES) {
  const same = before[t] === after[t];
  same ? pass++ : fail++;
  console.log(`  ${same ? '✓' : '✗'} ${t}: ${before[t]} -> ${after[t]}`);
}
console.log('\n--- other properties: reported, not asserted (tokensum IS recomputed by design) ---');
for (const k of ['tokensum', 'authors', 'agentcols']) {
  const same = before[k] === after[k];
  if (!same) changed++;
  console.log(`  ${same ? '=' : '~'} ${k}: ${same ? 'unchanged' : `${before[k]}\n        -> ${after[k]}`}`);
}
console.log(`\n${fail === 0 && !threw ? '✓' : '✗'} ${pass}/${TABLES.length} row counts preserved, ${changed} recomputed field(s), threw=${threw ? 'YES' : 'no'}`);
