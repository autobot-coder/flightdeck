/**
 * GATE — POST /api/mkdir path containment, and hue validation (t_f88edb5b).
 *
 * /api/mkdir CREATES DIRECTORIES on the host from a request body. It shipped public with no
 * regression cover; the guard is correct today, and this pins it so a later edit cannot relax it
 * silently. That is not hypothetical — t_fd350415 was the same shape: a route passing body data
 * into a sink where a TypeScript cast looked like validation and wasn't.
 *
 * ⚠️ THE PROPERTY UNDER TEST IS CONTAINMENT, NOT A STATUS CODE. Asserting "400" would overfit:
 * reviewer-1's sweep found three inputs the guard legitimately ALLOWS which are harmless anyway
 * (`..%2fevil` — the filesystem does not decode %2f, `~` — joined not expanded, and a NUL byte —
 * which mkdirSync rejects). So each case declares whether it must be REFUSED or merely CONTAINED,
 * and every case additionally asserts that nothing appeared outside the parent directory. A gate
 * that only counted 400s would fail the day someone tightened or loosened the error path without
 * changing what actually lands on disk.
 *
 * Case table from reviewer-1 (msg 1514/1522), who ran it against the predicate directly; this
 * runs it end-to-end over real HTTP against a real server.
 *
 * SAFETY: own port, own dbPath, maxConcurrentTurns 0 so no agent spawns, aborts if the port
 * resolves to 4400, and kills the LISTENER (not the npx wrapper, which leaves an orphan).
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4462;
const WORK = mkdtempSync(join(tmpdir(), 'fd-mkdir-'));
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** lsof lives in /usr/sbin and may be off a sanitized PATH. */
const LSOF = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
const listenerPid = () => {
  try { return execFileSync(LSOF, ['-tiTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};

function cleanup() {
  const pid = listenerPid();
  if (pid) for (const p of pid.split('\n')) { try { process.kill(Number(p)); } catch { /* gone */ } }
  rmSync(WORK, { recursive: true, force: true });
}
process.on('exit', cleanup);

if (PORT === 4400) { console.error('ABORT: would target the live server'); process.exit(9); }
if (listenerPid()) { console.error(`ABORT: port ${PORT} already in use`); process.exit(9); }

const PROJ = join(WORK, 'proj');
const PARENT = join(WORK, 'parent');   // the sandbox folders must land inside
const OUTSIDE = join(WORK, 'outside'); // ...and never in here
mkdtempSync(join(WORK, 'x-'));
for (const d of [PROJ, PARENT, OUTSIDE]) execFileSync('mkdir', ['-p', d]);

const CONFIG = join(WORK, 'config.json');
writeFileSync(CONFIG, JSON.stringify({
  ownerName: 'Gate', port: PORT, dbPath: join(WORK, 'gate.db'),
  maxConcurrentTurns: 0, tickSeconds: 3600,
  workspaces: [{ id: 'gws', name: 'Gws', path: PROJ, roles: [{ role: 'lead', model: 'opus', prompt: 'p' }] }],
}, null, 2) + '\n');

console.log(`GATE — /api/mkdir containment + hue validation   (port ${PORT})\n`);

const server = spawn(process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join(REPO, 'src/index.ts'), CONFIG],
  { cwd: REPO, stdio: 'ignore', detached: false });

let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/api/state`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 500));
}
ok(`server up on ${PORT}`, up);
if (!up) { console.log(`\n✗ ${pass} passed, ${fails.length} failed`); process.exit(1); }

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> };
};

// ---------------------------------------------------------------- A
// REFUSED: the guard must reject these outright.
console.log('\nA. traversal attempts are refused, and nothing lands outside the parent');
const REFUSED = [
  '.', '..', '../evil', '..\\evil', 'a/b', 'a\\b', '/etc/passwd', 'C:\\Windows',
  '....//x', '%2e%2e/x', './x', '../../etc', 'foo/../../bar', '/', '\\', 'a/../b',
];
{
  const parentBefore = readdirSync(PARENT).sort().join(',');
  for (const name of REFUSED) {
    const { status } = await post('/api/mkdir', { parent: PARENT, name });
    ok(`refused: ${JSON.stringify(name)}`, status === 400, `got HTTP ${status}`);
  }
  // THE CONSEQUENCE, which a status-only check would miss entirely.
  ok('parent directory is unchanged after every refusal',
    readdirSync(PARENT).sort().join(',') === parentBefore,
    `was [${parentBefore}] now [${readdirSync(PARENT).sort().join(',')}]`);
  ok('nothing was created in the sibling "outside" directory',
    readdirSync(OUTSIDE).length === 0, readdirSync(OUTSIDE).join(','));
  ok('no directory escaped to the work root',
    !existsSync(join(WORK, 'evil')) && !existsSync(join(WORK, 'bar')) && !existsSync(join(WORK, 'x')));
}

// ---------------------------------------------------------------- B
// ALLOWED BUT CONTAINED: the guard lets these through and that is fine — what matters is that
// whatever gets created is INSIDE the parent. Encoded separately so the gate does not overfit
// to today's error path.
console.log('\nB. inputs the guard allows are still contained inside the parent');
{
  for (const name of ['..%2fevil', '~', 'a%2fb']) {
    const { status, json } = await post('/api/mkdir', { parent: PARENT, name });
    const created = typeof json.path === 'string' ? json.path : '';
    const contained = status !== 200 || (created.startsWith(PARENT + '/') && resolve(created) === created);
    ok(`contained: ${JSON.stringify(name)} (HTTP ${status})`, contained, `created ${created}`);
  }
  ok('still nothing outside the parent', readdirSync(OUTSIDE).length === 0);
}

// ---------------------------------------------------------------- C
console.log('\nC. the endpoint still does its job');
{
  const a = await post('/api/mkdir', { parent: PARENT, name: 'good-folder' });
  ok('a legitimate name is created', a.status === 200 && existsSync(join(PARENT, 'good-folder')),
    `HTTP ${a.status} ${JSON.stringify(a.json)}`);
  ok('  ...and the returned path is inside the parent', String(a.json.path) === join(PARENT, 'good-folder'));
  const b = await post('/api/mkdir', { parent: PARENT, name: 'good-folder' });
  ok('an existing folder is reported, not silently reused', b.status === 409, `got ${b.status}`);
  const c = await post('/api/mkdir', { parent: PARENT, name: '' });
  ok('an empty name is refused', c.status === 400, `got ${c.status}`);
  const d = await post('/api/mkdir', { parent: join(WORK, 'nope'), name: 'x' });
  ok('a non-existent parent is refused', d.status === 400, `got ${d.status}`);
}

// ---------------------------------------------------------------- D
// hue reaches an hsl() in the dashboard, so the property is: whatever the API stores is always a
// number in [0,360) — never a string, never NaN/Infinity.
console.log('\nD. hue is always stored as an integer 0-359, or rejected');
{
  let n = 0;
  const mk = async (hue: unknown) => {
    const dir = join(WORK, `w${n++}`);
    execFileSync('mkdir', ['-p', dir]);
    return post('/api/workspaces', { name: `Hue ${n}`, path: dir, roles: ['lead'], hue });
  };
  for (const [label, hue, want] of [
    ['0 stays 0', 0, 0], ['359 stays 359', 359, 359], ['400 wraps to 40', 400, 40],
    ['-30 wraps to 330', -30, 330], ['a numeric string is accepted', '120', 120],
    ['a fractional value is rounded', 12.6, 13],
  ] as Array<[string, unknown, number]>) {
    const r = await mk(hue);
    const got = (r.json as { hue?: unknown }).hue;
    ok(`${label}`, r.status === 200 && got === want, `HTTP ${r.status}, hue=${JSON.stringify(got)}`);
    ok(`  ...and it is a number, not a string`, typeof got === 'number');
  }
  for (const [label, hue] of [
    ['a non-numeric string is refused', 'abc'], ['Infinity is refused', 'Infinity'],
    ['NaN is refused', 'NaN'], ['an object is refused', { toString: 'x' }], ['a boolean is refused', true],
  ] as Array<[string, unknown]>) {
    const r = await mk(hue);
    ok(label, r.status === 400, `got HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  // Omitting hue must leave the KEY ABSENT, not null. That is the documented contract at
  // server/index.ts:541 — "Absent means derive from the id; the client owns that fallback, so
  // don't invent one here" — and emitting null instead would hand the dashboard a value to
  // render. Asserting absence rather than null is the stronger check, and my first version of
  // this assertion had it backwards.
  const omitted = await post('/api/workspaces', { name: 'No Hue', path: PROJ, roles: ['lead'] });
  ok('omitting hue leaves the key ABSENT, so the client derives one',
    omitted.status === 200 && !('hue' in omitted.json),
    `HTTP ${omitted.status}, hue=${JSON.stringify((omitted.json as { hue?: unknown }).hue)}`);
}

// ---------------------------------------------------------------- E
// ⚠️ THIS SECTION EXISTS BECAUSE MUTATION TESTING FOUND A HOLE IN THIS GATE. Sections A-D ran
// green with `|| path.basename(name) !== name` deleted from the guard, because on POSIX that
// clause is genuinely redundant — the separator regex already catches everything it would.
// Its real contribution is on Windows, where `C:foo`, `x:y` and `a:b` are DRIVE-RELATIVE names:
// they contain no separator, so the regex lets them through, and on Windows they resolve
// relative to the current directory of that drive rather than inside `parent`. Only basename
// rejects them. This suite runs on POSIX, so the behaviour is checked under win32 semantics the
// way win32-sim-test.mts does, plus a source assertion so deleting the clause goes red here.
console.log('\nE. the basename clause is load-bearing on Windows (POSIX cannot observe this)');
{
  const { win32 } = await import('node:path');
  const bySeparator = (n: string) => /[/\\]/.test(n);
  const byBasename = (n: string) => win32.basename(n) !== n;
  for (const name of ['C:foo', 'x:y', 'a:b']) {
    ok(`drive-relative ${JSON.stringify(name)}: the separator regex ALONE would allow it`,
      !bySeparator(name));
    ok(`  ...and basename under win32 rejects it`, byBasename(name));
  }
  // Drift guard: sections A-D cannot see this clause disappear, so assert the shipped source
  // still has it. Read out of the file rather than restated, so it cannot drift.
  const src = readFileSync(join(REPO, 'src/server/index.ts'), 'utf8');
  ok('the shipped guard still includes the basename clause',
    /path\.basename\(name\)\s*!==\s*name/.test(src),
    'removing it re-opens drive-relative names on Windows, which no POSIX test can catch');
  ok('the shipped guard still includes the separator regex',
    /\/\[\/\\\\\]\/\.test\(name\)/.test(src));
}

console.log(`\n${fails.length === 0 ? '✓' : '✗'} ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `    - ${f}`).join('\n')); process.exitCode = 1; }
cleanup();
