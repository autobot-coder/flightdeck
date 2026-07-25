/**
 * deps-test.mts — guards runtime dependency classification (t_494803b0).
 *
 * The defect this exists for: `tsx` sat in devDependencies while being required at
 * RUNTIME by two paths — package.json "start" and src/orchestrator/session.ts's
 * mcpConfigFor(). `npm install --omit=dev` therefore yielded an app that could not boot.
 *
 * Two classes of runtime dependency are checked, because they fail differently:
 *   1. EXPLICIT — bare `import 'x'` in src/. Discoverable by scanning source.
 *   2. IMPLICIT — invoked as a CLI / resolved at runtime (tsx). Invisible to an
 *      import scan, which is exactly why this one slipped past four sessions.
 *
 * package.json alone is not sufficient: `npm install --omit=dev` honours the
 * per-package `dev` flags in package-lock.json, so the lock is asserted too.
 *
 * Usage:  npx tsx <abs>/deps-test.mts [targetDir]
 *   targetDir defaults to the repo root. Pass scratchpad/base28 to run the
 *   NEGATIVE CONTROL against the pre-fix manifest (it must FAIL).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const ROOT = resolve(process.argv[2] ?? __REPO);

let pass = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const deps: Record<string, string> = pkg.dependencies ?? {};
const devDeps: Record<string, string> = pkg.devDependencies ?? {};
const lockPkgs: Record<string, any> = lock.packages ?? {};
const lockRoot = lockPkgs[''] ?? {};

// ---- 1. explicit runtime deps: every bare import in src/ must be a dependency ----
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.m?ts$/.test(e)) out.push(p);
  }
  return out;
}
const bare = new Set<string>();
for (const f of walk(join(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    // strip subpath: 'pkg/sub' -> 'pkg', '@scope/pkg/sub' -> '@scope/pkg'
    const parts = spec.split('/');
    bare.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
}
check('src/ yielded a non-empty bare-import set', bare.size > 0, `found ${bare.size}`);
for (const name of [...bare].sort()) {
  check(`explicit runtime import "${name}" is in dependencies`, name in deps,
    name in devDeps ? 'it is in devDependencies — breaks --omit=dev' : 'absent from package.json');
}

// ---- 2. implicit runtime dep: tsx ----
const startScript: string = pkg.scripts?.start ?? '';
check('"start" script invokes tsx (documents the runtime need)', /\btsx\b/.test(startScript), startScript);
const sessionTs = readFileSync(join(ROOT, 'src/orchestrator/session.ts'), 'utf8');
check('session.ts resolves tsx at runtime for the MCP server', /['"]tsx\/cli['"]|tsx\/dist\/cli\.mjs/.test(sessionTs));
check('tsx is in dependencies', 'tsx' in deps,
  'tsx' in devDeps ? 'still in devDependencies — `npm install --omit=dev` cannot boot the app' : 'missing entirely');
check('tsx is NOT in devDependencies', !('tsx' in devDeps));

// ---- 3. lockfile agrees — --omit=dev obeys the lock's dev flags, not package.json ----
check('lock root lists tsx under dependencies', 'tsx' in (lockRoot.dependencies ?? {}));
check('lock root does NOT list tsx under devDependencies', !('tsx' in (lockRoot.devDependencies ?? {})));
check('lock: node_modules/tsx is not dev-flagged', lockPkgs['node_modules/tsx']?.dev !== true);
check('lock: node_modules/esbuild is not dev-flagged (tsx runtime dep)',
  lockPkgs['node_modules/esbuild']?.dev !== true);
// tsx needs the platform esbuild binary; if these stay dev-flagged, Windows/Linux clones break
for (const plat of ['win32-x64', 'win32-arm64', 'win32-ia32', 'darwin-arm64', 'linux-x64']) {
  const key = `node_modules/@esbuild/${plat}`;
  if (!(key in lockPkgs)) { check(`lock has ${key}`, false, 'esbuild platform binary missing from lock'); continue; }
  check(`lock: @esbuild/${plat} is not dev-flagged`, lockPkgs[key]?.dev !== true);
}

// ---- 4. no package.json <-> lock drift for runtime deps ----
for (const name of Object.keys(deps).sort()) {
  check(`lock root dependency entry exists for "${name}"`, name in (lockRoot.dependencies ?? {}));
  check(`lock: node_modules/${name} is not dev-flagged`, lockPkgs[`node_modules/${name}`]?.dev !== true);
}
check('lock version is 3 (dev flags are per-package)', lock.lockfileVersion === 3, String(lock.lockfileVersion));

// ---- report ----
console.log(`\ntarget: ${ROOT}`);
console.log(`bare runtime imports found in src/: ${[...bare].sort().join(', ')}`);
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  *** ${f}`);
  process.exit(1);
}
console.log(`\n${pass}/${pass} assertions passed`);
console.log('✓ all green — every runtime dependency (explicit and implicit) survives --omit=dev');
