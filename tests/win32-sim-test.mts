/**
 * builder-25: Windows candidate-ORDER verification for src/preflight.ts, without Windows.
 *
 * WHY THIS EXISTS. t_302ccf66 parks the Windows spawn path as "implemented but unverified".
 * The load-bearing claim is builder-24's candidate ORDER: bare `claude` on PATH must be LAST,
 * because on Windows the npm-global CLI is `claude.cmd` and Node has refused to spawn a
 * .cmd without shell:true since CVE-2024-27980. That claim was reasoned, not measured.
 *
 * `candidates()` reads process.platform *at call time*, so we can force 'win32', point HOME
 * and APPDATA at fake install trees, and let resolveCli() do REAL execFile spawns against
 * stub executables. That measures the ordering and the run-cli.js-under-node mechanism.
 *
 * WHAT THIS DOES NOT PROVE (still needs real hardware — do not close t_302ccf66 on this):
 *   - Actual .cmd spawn refusal: we cannot make macOS Node reject a .cmd the way Windows does.
 *   - Windows path separators: node:path binds posix/win32 at module load from the REAL
 *     platform, so joins here use '/'. Separator handling is unverified.
 *   - The real installer layouts (%APPDATA%\npm, Program Files\nodejs) and keychain auth.
 *
 * Additive: does NOT modify builder-24's preflight-test.mts, so its 44/44 gate is unchanged.
 * Run: npx tsx <ABS>/win32-sim-test.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const SRC = `${__REPO}/src/preflight.ts`;

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expected: unknown, label: string) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A stub that answers `--version` like the real CLI, so execFile succeeds. */
function writeStubExe(file: string, version: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  fs.chmodSync(file, 0o755);
}
/** A stub cli.js, which must be run as `node <cli.js> --version`. */
function writeStubCliJs(file: string, version: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `console.log(${JSON.stringify(version)});\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-win32-sim-'));
const fakeHome = path.join(root, 'home');
const fakeAppData = path.join(root, 'AppData');
const nativeExe = path.join(fakeHome, '.local', 'bin', 'claude.exe');
const appDataCliJs = path.join(fakeAppData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

const realPlatform = process.platform;
const realHome = process.env.HOME;
const realAppData = process.env.APPDATA;
const realEnvCli = process.env.FLIGHTDECK_CLI;

function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restore() {
  setPlatform(realPlatform);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = realAppData;
  if (realEnvCli === undefined) delete process.env.FLIGHTDECK_CLI; else process.env.FLIGHTDECK_CLI = realEnvCli;
}

// Never let an inherited env var decide a result under test.
delete process.env.FLIGHTDECK_CLI;

const { resolveCli } = await import(SRC);

try {
  process.env.HOME = fakeHome;
  process.env.APPDATA = fakeAppData;
  setPlatform('win32');
  eq(process.platform, 'win32', 'platform override took effect');
  eq(os.homedir(), fakeHome, 'os.homedir() follows the faked HOME');

  // ---- 1. Windows native binary wins outright -------------------------------
  console.log('\n1. win32 + native claude.exe present → native-binary, no node prefix');
  writeStubExe(nativeExe, '9.9.1 (Claude Code) STUB-NATIVE');
  writeStubCliJs(appDataCliJs, '9.9.2 (Claude Code) STUB-APPDATA');
  {
    const r = await resolveCli();
    eq(r.source, 'native-binary', 'source is native-binary');
    eq(r.found, true, 'found');
    eq(r.command, nativeExe, 'spawns the .exe directly');
    eq(r.prefixArgs.length, 0, 'no prefix args for a real executable');
    ok(String(r.version).includes('STUB-NATIVE'), 'version came from the .exe, not the cli.js');
    ok(!String(r.command).endsWith('.cmd'), 'never resolves to a .cmd (CVE-2024-27980)');
  }

  // ---- 2. No native binary → %APPDATA% cli.js under node, NOT bare PATH -----
  // This is THE Windows fix: bare `claude` would hit claude.cmd and fail to spawn.
  console.log('\n2. win32, no .exe → npm-script (node cli.js), ranked ABOVE bare PATH');
  fs.rmSync(nativeExe, { force: true });
  {
    const r = await resolveCli();
    eq(r.source, 'npm-script', 'source is npm-script, NOT path');
    eq(r.found, true, 'found');
    eq(r.command, process.execPath, 'spawns this same node binary');
    eq(r.prefixArgs.length, 1, 'exactly one prefix arg');
    eq(r.prefixArgs[0], appDataCliJs, 'prefix arg is the %APPDATA% cli.js');
    ok(String(r.version).includes('STUB-APPDATA'), 'version came from cli.js run under node');
    ok(r.source !== 'path', 'bare PATH did NOT win while an npm install existed');
  }

  // ---- 3. Nothing installed → falls back to PATH and reports it actionably --
  console.log('\n3. win32, nothing installed → bare PATH is LAST resort');
  fs.rmSync(path.join(fakeAppData, 'npm'), { recursive: true, force: true });
  {
    // Empty PATH so bare `claude` cannot resolve either — the true fresh-Windows case.
    const realPath = process.env.PATH;
    process.env.PATH = path.join(root, 'nothing-here');
    const r = await resolveCli();
    process.env.PATH = realPath;
    eq(r.source, 'path', 'last candidate is the bare PATH lookup');
    eq(r.found, false, 'correctly reports not-found');
    eq(r.command, 'claude', 'error names `claude`, something the user can act on');
    eq(r.version, null, 'no version when not found');
    ok(typeof r.error === 'string' && r.error.length > 0, 'carries a non-empty probe error');
  }

  // ---- 4. Explicit escape hatches outrank every heuristic -------------------
  console.log('\n4. explicit cliPath / FLIGHTDECK_CLI win over discovery');
  writeStubExe(nativeExe, '9.9.1 (Claude Code) STUB-NATIVE'); // discovery would find this
  const customExe = path.join(root, 'custom', 'my-claude.exe');
  writeStubExe(customExe, '9.9.3 (Claude Code) STUB-CUSTOM');
  {
    const r = await resolveCli(customExe);
    eq(r.source, 'config', 'configured path reports source=config');
    eq(r.command, customExe, 'uses the configured executable');
    eq(r.prefixArgs.length, 0, 'no node prefix for a non-.js path');
    ok(String(r.version).includes('STUB-CUSTOM'), 'configured path beat the discovered .exe');
  }
  {
    const customJs = path.join(root, 'custom', 'my-cli.js');
    writeStubCliJs(customJs, '9.9.4 (Claude Code) STUB-CUSTOMJS');
    const r = await resolveCli(customJs);
    eq(r.source, 'config', 'configured .js reports source=config');
    eq(r.command, process.execPath, 'a .js cliPath is run under node');
    eq(r.prefixArgs[0], customJs, 'the .js is passed as the first arg');
    ok(String(r.version).includes('STUB-CUSTOMJS'), 'version came from the configured cli.js');
  }
  {
    process.env.FLIGHTDECK_CLI = customExe;
    const r = await resolveCli();
    eq(r.source, 'env', 'env var reports source=env (distinct from config)');
    eq(r.command, customExe, 'env var beat discovery');
    delete process.env.FLIGHTDECK_CLI;
  }
  {
    process.env.FLIGHTDECK_CLI = customExe;
    const r = await resolveCli(nativeExe);
    eq(r.source, 'config', 'explicit cliPath outranks the env var');
    eq(r.command, nativeExe, 'config value is the one spawned');
    delete process.env.FLIGHTDECK_CLI;
  }

  // ---- 5. Regression guard: posix ordering must be unchanged ----------------
  console.log('\n5. darwin regression — native binary still preferred, still no shell');
  setPlatform('darwin');
  {
    const nativePosix = path.join(fakeHome, '.local', 'bin', 'claude');
    writeStubExe(nativePosix, '9.9.5 (Claude Code) STUB-POSIX');
    const r = await resolveCli();
    eq(r.source, 'native-binary', 'darwin also prefers the native binary');
    eq(r.command, nativePosix, 'uses the extension-less posix binary');
    ok(String(r.version).includes('STUB-POSIX'), 'version came from the posix stub');
    ok(!String(r.command).endsWith('.exe'), 'no .exe on darwin');
  }
} finally {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (fail > 0) { console.log(`✗ ${fail} FAILED`); process.exit(1); }
console.log('✓ all green — win32 candidate ORDER verified by real spawns (NOT a substitute for hardware)');
