/**
 * builder-29 — verification for t_ac6430d9: does src/preflight.ts now find an npm-global
 * Claude CLI installed under a version manager (nvm), on both the POSIX and win32 shapes?
 *
 * WHY A NEW HARNESS. builder-28's nvm-root-sim-test.mts reproduced the GAP by planting a
 * stub under a faked $HOME. That technique structurally CANNOT observe this fix: the new
 * candidate derives its root from `process.execPath`, which is the real node binary and is
 * unaffected by $HOME. So this harness instead runs the probe under a node binary COPIED
 * INTO a fake nvm tree — then execPath itself is inside the rig and the derivation resolves
 * there. That is the only honest way to measure it from one machine.
 *
 * DISCRIMINATION. Every positive case is paired with the SAME rig run against the pre-fix
 * baseline (scratchpad/base29/src/preflight.ts). If a case passes against both, it proves
 * nothing and is reported as such.
 *
 * WHAT THIS STILL DOES NOT PROVE (t_302ccf66 keeps needing hardware): real Windows path
 * separators (node:path binds win32/posix at load from the REAL platform), real .cmd spawn
 * refusal, and the actual nvm-for-windows on-disk layout.
 *
 * Run: npx tsx <ABS>/nvm-fix-test.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const REPO = __REPO;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXED = path.join(REPO, 'src', 'preflight.ts');
const PREFIX_BASELINE = path.join(HERE, 'fixtures', 'base29', 'src', 'preflight.ts'); // pre-fix image
const PROBE = path.join(HERE, 'nvm-probe.mts');
const TSX_CLI = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expected: unknown, label: string) {
  ok(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// realpath: on macOS os.tmpdir() is /var/... but process.execPath reports /private/var/...,
// so comparing rig paths against execPath needs both sides canonicalised.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nvm-fix-')));
const fakeHome = path.join(root, 'home');          // empty: native-binary candidate must MISS
const emptyAppData = path.join(root, 'AppData');   // empty: %APPDATA%\npm candidate must MISS
const emptyProgFiles = path.join(root, 'ProgramFiles');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(emptyAppData, { recursive: true });
fs.mkdirSync(emptyProgFiles, { recursive: true });

// ---- the rig: a node binary living where nvm would put it -------------------
const nvmVersionDir = path.join(root, '.nvm', 'versions', 'node', 'v22.3.0');
const rigNode = path.join(nvmVersionDir, 'bin', 'node');
fs.mkdirSync(path.dirname(rigNode), { recursive: true });
fs.copyFileSync(process.execPath, rigNode);
fs.chmodSync(rigNode, 0o755);

/** POSIX nvm global root: <prefix>/lib/node_modules, prefix = dirname(dirname(execPath)). */
const posixStub = path.join(nvmVersionDir, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
/** win32 nvm global root: <nodedir>\node_modules — NOT ..\lib\node_modules. */
const win32Stub = path.join(nvmVersionDir, 'bin', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

function writeStub(file: string, version: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `console.log(${JSON.stringify(version)});\n`);
}

/** Run the probe under the RIG node, with a sanitized environment. */
function probe(preflightSrc: string, forcePlatform?: string) {
  const args = [TSX_CLI, PROBE, preflightSrc];
  if (forcePlatform) args.push(forcePlatform);
  const out = execFileSync(rigNode, args, {
    encoding: 'utf8',
    env: {
      HOME: fakeHome,
      APPDATA: emptyAppData,
      ProgramFiles: emptyProgFiles,
      PATH: '/nonexistent-for-this-test',
      TSX_TSCONFIG_PATH: path.join(REPO, 'tsconfig.json'),
    },
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!;
  return JSON.parse(line) as {
    execPath: string; platform: string; found: boolean;
    source: string; version: string | null; command: string; prefixArgs: string[];
  };
}

try {
  ok(fs.existsSync(PREFIX_BASELINE), 'pre-fix baseline image is available for the control',
    `missing ${PREFIX_BASELINE}`);
  // NB: the pre-fix file legitimately contains `process.execPath` (it spawns node); what it
  // must NOT contain is a global root DERIVED from it.
  const baselineSrc = fs.readFileSync(PREFIX_BASELINE, 'utf8');
  ok(!/path\.dirname\(process\.execPath\)/.test(baselineSrc),
    'baseline image really is PRE-fix (no root derived from process.execPath)');
  ok(/path\.dirname\(process\.execPath\)/.test(fs.readFileSync(FIXED, 'utf8')),
    'the file under test really does contain the fix');

  console.log('\n--- CASE 1: POSIX — CLI under the nvm global root, FIXED code -------------');
  writeStub(posixStub, '9.9.9 (Claude Code) STUB-NVM-POSIX');
  const r1 = probe(FIXED);
  console.log(`  → ${JSON.stringify(r1)}`);
  // Load-bearing: if execPath is not the rig's node, this harness measures nothing.
  eq(r1.execPath, rigNode, 'probe really ran under the rig node (execPath is inside the rig)');
  eq(r1.found, true, 'nvm-installed CLI IS now found');
  eq(r1.source, 'npm-script', "found via 'npm-script' (node <cli.js>), not the PATH fallback");
  eq(r1.command, rigNode, 'spawns that same node binary');
  eq(r1.prefixArgs[0], posixStub, 'prefix arg is the nvm-root cli.js');
  ok(String(r1.version).includes('STUB-NVM-POSIX'), 'version came from a REAL spawn of the stub',
    String(r1.version));

  console.log('\n--- CASE 2 (negative control): same rig, PRE-FIX code ---------------------');
  const r2 = probe(PREFIX_BASELINE);
  console.log(`  → ${JSON.stringify(r2)}`);
  eq(r2.found, false, 'pre-fix code does NOT find it — the defect was real');
  eq(r2.source, 'path', "pre-fix code fell through to the last-resort 'path' candidate");
  ok(r1.found !== r2.found, 'the harness DISCRIMINATES: same rig, opposite outcomes');

  console.log('\n--- CASE 3: win32 shape — <nodedir>\\node_modules, FIXED code --------------');
  fs.rmSync(path.join(nvmVersionDir, 'lib'), { recursive: true, force: true }); // POSIX root gone
  writeStub(win32Stub, '9.9.9 (Claude Code) STUB-NVM-WIN32');
  const r3 = probe(FIXED, 'win32');
  console.log(`  → ${JSON.stringify(r3)}`);
  eq(r3.platform, 'win32', 'platform override took effect');
  eq(r3.found, true, 'nvm-for-windows global root IS covered by the derivation');
  eq(r3.source, 'npm-script', 'found via npm-script, NOT the unspawnable .cmd on PATH');
  eq(r3.prefixArgs[0], win32Stub, 'derived root is <nodedir>\\node_modules, per npm globalDir');
  ok(!String(r3.command).endsWith('.cmd'), 'never resolves to a .cmd (CVE-2024-27980)');

  console.log('\n--- CASE 4 (negative control): win32 shape, PRE-FIX code ------------------');
  const r4 = probe(PREFIX_BASELINE, 'win32');
  console.log(`  → ${JSON.stringify(r4)}`);
  eq(r4.found, false, 'pre-fix code misses the nvm-for-windows root — Windows-fatal half');
  eq(r4.source, 'path', "pre-fix code fell through to 'path' (= claude.cmd on real Windows)");

  console.log('\n--- CASE 5: the POSIX derivation must NOT match the win32 shape -----------');
  // Guards the exact mistake the handoff warned about: using ..\lib\node_modules on Windows.
  const r5 = probe(FIXED); // still POSIX platform, but only the win32-shaped stub exists
  console.log(`  → found=${r5.found} source=${r5.source}`);
  eq(r5.found, false, 'POSIX branch does not reach <nodedir>/node_modules (shapes are distinct)');

  console.log('\n--- CASE 7: derived root == a fixed root → probed ONCE, not twice ----------');
  // The one-line Set dedupe exists for a system node install, where the derived root is
  // byte-identical to a hardcoded one. Stage it by arranging HOME so that
  //   dirname(dirname(execPath))/lib/node_modules  ===  $HOME/.npm-global/lib/node_modules
  // then COUNT real invocations: the stub appends a line each time it is spawned.
  const dupHome = path.join(root, 'hm');
  const dupNode = path.join(dupHome, '.npm-global', 'bin', 'node');
  fs.mkdirSync(path.dirname(dupNode), { recursive: true });
  fs.copyFileSync(process.execPath, dupNode);
  fs.chmodSync(dupNode, 0o755);
  const hitLog = path.join(root, 'probe-hits.log');
  const dupStub = path.join(dupHome, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(dupStub), { recursive: true });
  fs.writeFileSync(dupStub,
    `require('node:fs').appendFileSync(${JSON.stringify(hitLog)}, 'hit\\n');\n`
    + `console.log('9.9.9 (Claude Code) STUB-DEDUPE');\n`);
  {
    const out = execFileSync(dupNode, [TSX_CLI, PROBE, FIXED], {
      encoding: 'utf8',
      env: {
        HOME: dupHome, APPDATA: emptyAppData, ProgramFiles: emptyProgFiles,
        PATH: '/nonexistent-for-this-test', TSX_TSCONFIG_PATH: path.join(REPO, 'tsconfig.json'),
      },
    });
    const r7 = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!);
    const derived = path.resolve(path.dirname(dupNode), '..', 'lib', 'node_modules');
    const fixedRoot = path.join(dupHome, '.npm-global', 'lib', 'node_modules');
    eq(derived, fixedRoot, 'rig really does make the derived root identical to a fixed one');
    eq(r7.found, true, 'still resolves when the two roots coincide');
    eq(r7.source, 'npm-script', 'via npm-script');
    const hits = fs.readFileSync(hitLog, 'utf8').trim().split('\n').filter(Boolean).length;
    eq(hits, 1, 'the duplicated root was spawned exactly ONCE (Set dedupe works)');
  }

  console.log('\n--- CASE 6: no CLI anywhere → still reports not-found actionably ----------');
  fs.rmSync(path.join(nvmVersionDir, 'bin', 'node_modules'), { recursive: true, force: true });
  const r6 = probe(FIXED);
  console.log(`  → found=${r6.found} source=${r6.source} command=${r6.command}`);
  eq(r6.found, false, 'nothing installed → not found');
  eq(r6.source, 'path', "last resort is still the bare PATH lookup — 'path' stayed LAST");
  eq(r6.command, 'claude', 'error names `claude`, something the user can act on');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (fail > 0) { console.log(`✗ ${fail} FAILED`); process.exit(1); }
console.log('✓ all green — nvm global root now reachable on BOTH shapes, each proven against\n'
  + '  the pre-fix baseline in the same rig. Not a substitute for Windows hardware (t_302ccf66).');
