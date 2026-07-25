// Measures what author id / display name the CURRENT code derives for the human,
// using a COPY of the operator's real flightdeck.config.json. Read-only: never writes config or DB.
import { existsSync, readFileSync } from 'node:fs';
import { ownerIdFrom, ownerNameFrom, DEFAULT_OWNER_NAME } from '../src/config.ts';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (label: string, got: unknown, want: unknown) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`${good ? '  ✓' : '  ✗'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// --- the real thing: the operator's live config, read from disk, not a fixture ---
const CONFIG_PATH = `${__REPO}/flightdeck.config.json`;
/**
 * PRECONDITION: this gate asserts against the OPERATOR'S REAL flightdeck.config.json,
 * which is gitignored — that is the point of it (a clean-clone fixture only ever exercises
 * the default path). In a fresh clone the file does not exist, so declare that and exit 77
 * = SKIP rather than crashing with ENOENT, which reads as a broken harness.
 */
if (!existsSync(CONFIG_PATH)) {
  console.log('SKIP ownerid-test: no flightdeck.config.json in this tree.');
  console.log('  This gate deliberately checks the real operator config, not a fixture.');
  console.log('  Run it in a configured checkout (one that has been started at least once).');
  process.exit(77);
}
const realPath = CONFIG_PATH;
const real = JSON.parse(readFileSync(realPath, 'utf8'));
console.log(`\n[A] THE OPERATOR'S ACTUAL CONFIG (${realPath})`);
console.log(`    ownerName key present: ${'ownerName' in real} -> ${JSON.stringify(real.ownerName)}`);
const configuredName = typeof real.ownerName === 'string' ? real.ownerName.trim() : '';
const expectedId = configuredName
  ? configuredName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  : 'operator';
const expectedName = configuredName || DEFAULT_OWNER_NAME;
console.log(`    -> expecting id ${JSON.stringify(expectedId)}, display ${JSON.stringify(expectedName)}`);
ok('ownerIdFrom(real config)   [author id recorded on their messages]', ownerIdFrom(real), expectedId);
ok('ownerNameFrom(real config) [what agents call them]', ownerNameFrom(real), expectedName);

// --- positive control: prove the harness DISCRIMINATES (not vacuously green) ---
console.log('\n[B] POSITIVE CONTROL — same functions, ownerName SET');
ok('ownerIdFrom({ownerName:"Ada Lovelace"})', ownerIdFrom({ ownerName: 'Ada Lovelace' } as any), 'ada-lovelace');
ok('ownerNameFrom({ownerName:"Ada Lovelace"})', ownerNameFrom({ ownerName: 'Ada Lovelace' } as any), 'Ada Lovelace');
ok('ownerIdFrom({ownerName:"Ada"})', ownerIdFrom({ ownerName: 'Ada' } as any), 'ada');
ok('ownerNameFrom({ownerName:"Ada"})', ownerNameFrom({ ownerName: 'Ada' } as any), 'Ada');

// --- negative control: empty string behaves like absent ---
console.log('\n[C] NEGATIVE CONTROL — empty / whitespace ownerName (what the shipped example has)');
ok('ownerIdFrom({ownerName:""})', ownerIdFrom({ ownerName: '' } as any), 'operator');
ok('ownerNameFrom({ownerName:""})', ownerNameFrom({ ownerName: '' } as any), DEFAULT_OWNER_NAME);
ok('ownerIdFrom({ownerName:"   "})', ownerIdFrom({ ownerName: '   ' } as any), 'operator');

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
