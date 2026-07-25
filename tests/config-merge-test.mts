/* builder-30 — gate for t_c715bbcb (partial fix): ConfigStore.save() must stop clobbering
   the operator's on-disk edits. GATE-SAFE: asserts the FIXED behaviour, must stay green.

   ⚠️ NOT the same file as builder-29's config-lostupdate-test.mts, which asserts the BUGGY
   behaviour and is expected to fail now. Theirs is a diagnostic and is NOT a gate; per their
   decision 5 it must not be "fixed" green — it is the record of what the bug was.

   Every positive is paired against the PRE-FIX config.ts from my pickup snapshot (base30/),
   loaded in the SAME rig, so no case can pass both before and after (builder-29's rule).

   Temp dirs only. Never touches the real flightdeck.config.json and never touches :4400. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const REPO = __REPO;
const SNAP = `${__REPO}/tests/fixtures/base30`;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfgmerge-')));

/** Load a ConfigStore implementation from a given config.ts source, isolated per variant. */
async function loadStore(variant: 'fixed' | 'prefix') {
  const src = fs.readFileSync(
    variant === 'fixed' ? `${REPO}/src/config.ts` : `${SNAP}/src/config.ts`, 'utf8');
  const dir = path.join(TMP, 'impl-' + variant);
  fs.mkdirSync(dir, { recursive: true });
  // types.js is type-only; strip the import so the module stands alone under tsx.
  fs.writeFileSync(path.join(dir, 'config.ts'), src.replace(/^import type .*$/m, ''));
  const mod = await import(path.join(dir, 'config.ts'));
  return mod.ConfigStore as new (filePath: string, rootDir: string) => {
    raw: any; config: any; save(): void;
    addWorkspace(ws: any): void; removeWorkspace(id: string): boolean;
  };
}

const Fixed = await loadStore('fixed');
const Prefix = await loadStore('prefix');

let n = 0;
/** Fresh config file + a store over it. */
function rig(Impl: any, extra: Record<string, unknown> = {}) {
  const dir = path.join(TMP, 'rig' + ++n);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'flightdeck.config.json');
  fs.writeFileSync(file, JSON.stringify({
    port: 4400, dbPath: 'data/mission.db', tickSeconds: 20, maxConcurrentTurns: 2,
    workspaces: [{ id: 'w1', name: 'One', path: '/tmp/one', roles: [{ role: 'builder', model: 'opus' }] }],
    ...extra,
  }, null, 2) + '\n');
  return { file, store: new Impl(file, dir) };
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** Simulate the operator editing the file while the server runs. */
function operatorEdits(file: string, patch: Record<string, unknown>) {
  fs.writeFileSync(file, JSON.stringify({ ...read(file), ...patch }, null, 2) + '\n');
}

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean) { if (cond) pass++; else fails.push(name); }

// ---- A. THE MEASURED DAMAGE — each key builder-29 recorded as lost ----
for (const [key, value] of [
  ['ownerName', 'Ada Lovelace'],
  ['tickSeconds', 5],
  ['maxConcurrentTurns', 7],
  ['models', [{ id: 'opus', label: 'Claude-Opus-5' }]],
  ['cliPath', '/custom/claude'],
] as [string, unknown][]) {
  {
    const { file, store } = rig(Fixed);
    operatorEdits(file, { [key]: value });
    store.save();                                  // any UI action
    ok(`A FIXED: operator's ${key} survives a save`,
      JSON.stringify(read(file)[key]) === JSON.stringify(value));
  }
  {
    const { file, store } = rig(Prefix);
    operatorEdits(file, { [key]: value });
    store.save();
    const got = read(file)[key];
    ok(`A NEGATIVE CONTROL: PRE-FIX loses ${key}`,
      JSON.stringify(got) !== JSON.stringify(value));
  }
}

// ---- B. the app's own workspace writes still land (no regression) ----
{
  const { file, store } = rig(Fixed);
  store.addWorkspace({ id: 'w2', name: 'Two', path: '/tmp/two', roles: [] });
  ok('B1 addWorkspace persists', read(file).workspaces.length === 2);
  ok('B2 removeWorkspace persists', store.removeWorkspace('w1') && read(file).workspaces.length === 1);
  ok('B3 surviving workspace is the right one', read(file).workspaces[0].id === 'w2');
  // in-place role edit, exactly as server/index.ts:309 and :328 do it
  store.config.workspaces[0].roles = [{ role: 'lead', model: 'sonnet' }];
  store.save();
  ok('B4 in-place role edit persists', read(file).workspaces[0].roles[0].role === 'lead');
}

// ---- C. app write + operator edit at the same time: BOTH survive (different keys) ----
{
  const { file, store } = rig(Fixed);
  operatorEdits(file, { ownerName: 'Ada Lovelace', tickSeconds: 5 });
  store.addWorkspace({ id: 'w2', name: 'Two', path: '/tmp/two', roles: [] });
  const after = read(file);
  ok('C1 operator ownerName survives an addWorkspace', after.ownerName === 'Ada Lovelace');
  ok('C2 operator tickSeconds survives it too', after.tickSeconds === 5);
  ok('C3 the app\'s new workspace is there', after.workspaces.length === 2);
}

// ---- D. THE RESIDUAL, ASSERTED SO NOBODY THINKS IT IS FIXED ----
// A hand-added workspace is still dropped: `workspaces` is the one key both sides write,
// and choosing a winner is the owner ruling that keeps t_c715bbcb open.
{
  const { file, store } = rig(Fixed);
  const disk = read(file);
  disk.workspaces.push({ id: 'hand', name: 'Hand', path: '/tmp/hand', roles: [] });
  fs.writeFileSync(file, JSON.stringify(disk, null, 2) + '\n');
  store.save();
  ok('D1 KNOWN RESIDUAL: hand-added workspace is still lost (needs the owner ruling)',
    !read(file).workspaces.some((w: any) => w.id === 'hand'));
  ok('D2 ...and it is lost for exactly one reason: app workspaces win',
    read(file).workspaces.length === 1);
}

// ---- E. the documented aliasing at config.ts:6-8 is intact ----
{
  const { store } = rig(Fixed);
  ok('E1 config.workspaces IS raw.workspaces (supervisor sees live changes)',
    store.config.workspaces === store.raw.workspaces);
  store.addWorkspace({ id: 'w9', name: 'Nine', path: '/tmp/nine', roles: [] });
  ok('E2 still the same array after a mutation', store.config.workspaces === store.raw.workspaces);
  ok('E3 dbPath stays absolute in memory', path.isAbsolute(store.config.dbPath));
}
{
  const { file, store } = rig(Fixed);
  store.save();
  ok('E4 dbPath stays RELATIVE on disk (absolute path never leaks into the file)',
    read(file).dbPath === 'data/mission.db');
}

// ---- F. degenerate on-disk states must not lose the app's own state ----
{
  const { file, store } = rig(Fixed);
  fs.writeFileSync(file, '{ this is not json');
  store.save();
  ok('F1 corrupt file => rewritten from our image, valid JSON again',
    read(file).workspaces[0].id === 'w1');
}
{
  const { file, store } = rig(Fixed);
  fs.rmSync(file);
  store.save();
  ok('F2 deleted file => recreated', fs.existsSync(file) && read(file).workspaces.length === 1);
}
{
  const { file, store } = rig(Fixed);
  fs.writeFileSync(file, '[1,2,3]');
  store.save();
  ok('F3 array at the root is not spread into an object', !Array.isArray(read(file)));
  ok('F4 ...and our workspaces survive it', read(file).workspaces[0].id === 'w1');
}

// ---- G. formatting contract: key order and trailing newline preserved ----
{
  const { file, store } = rig(Fixed, { ownerName: 'Ada Lovelace' });
  const before = Object.keys(read(file));
  store.save();
  ok('G1 key order is unchanged', JSON.stringify(Object.keys(read(file))) === JSON.stringify(before));
  ok('G2 file still ends in a newline', fs.readFileSync(file, 'utf8').endsWith('\n'));
  ok('G3 still 2-space indented', /\n  "port"/.test(fs.readFileSync(file, 'utf8')));
}

// ---- H. the claim the fix rests on: the app assigns NO config field ----
{
  const files = ['src/config.ts', 'src/server/index.ts', 'src/index.ts',
    'src/orchestrator/supervisor.ts', 'src/orchestrator/session.ts'];
  const hits: string[] = [];
  for (const f of files)
    for (const m of fs.readFileSync(`${REPO}/${f}`, 'utf8').matchAll(/(?:config|raw)\.([a-zA-Z]+)\s*=[^=]/g))
      hits.push(`${f}:${m[1]}`);
  ok('H1 no config/raw field is ever assigned (the whole basis for "disk wins")',
    hits.length === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('✓ all green — operator edits survive; workspaces residual asserted, not hidden');
