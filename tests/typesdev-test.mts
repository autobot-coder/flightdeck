/**
 * typesdev-test.mts — guards type-only dependency classification (t_01373d13).
 *
 * The defect this exists for: `@types/ws` sat in `dependencies` while shipping ZERO
 * runtime code (main: "", exports: types only). It therefore landed in every
 * production install, and — because @types/ws depends on @types/node, which depends
 * on undici-types — it dragged TWO more type-only packages in with it. Measured:
 * `npm ci --omit=dev` installed 201 packages pre-fix vs 198 post-fix.
 *
 * It is the mirror image of t_494803b0 (tsx: a RUNTIME package stuck in devDeps).
 * deps-test.mts guards that direction; this guards this one. Neither subsumes the other.
 *
 * ⚠️ MOVE, NOT DELETE. `src/server/index.ts` does `import type { WebSocket } from 'ws'`,
 * and `ws` ships no bundled types. Measured in a rig with @types/ws removed:
 * `tsc --noEmit` fails TS7016. So the package is genuinely required — by the
 * typecheck gate, which is dev-time. Deleting it would break `npm run typecheck`.
 * Assertions D exist so nobody "simplifies" this into a deletion.
 *
 * PAIRING RULE (builder-29's, kept): every positive is paired against the PRE-FIX
 * image evaluated in this SAME harness. A case that passes both before and after
 * proves nothing. Run the control explicitly:
 *
 * Usage:  npx tsx <abs>/typesdev-test.mts [targetDir]
 *   targetDir defaults to the repo root (must PASS).
 *   Pass scratchpad/base31 for the PRE-FIX image — the A/B/E controls below assert
 *   that it is broken, so the suite is self-checking rather than trusting my claim.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const ROOT = resolve(process.argv[2] ?? __REPO);
const PREFIX_IMAGE = resolve(__REPO, 'tests/fixtures/base31');
const isPreFixImage = ROOT === PREFIX_IMAGE;

let pass = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const deps: Record<string, string> = pkg.dependencies ?? {};
const devDeps: Record<string, string> = pkg.devDependencies ?? {};
const lockPkgs: Record<string, any> = lock.packages ?? {};
const lockRoot = lockPkgs[''] ?? {};

// The pre-fix manifests, loaded from the pickup snapshot, so the CONTROL cases run
// in this same harness rather than being asserted from memory.
const preRoot = PREFIX_IMAGE;
const havePre = existsSync(join(preRoot, 'package.json'));
const prePkg = havePre ? JSON.parse(readFileSync(join(preRoot, 'package.json'), 'utf8')) : null;
const preLock = havePre ? JSON.parse(readFileSync(join(preRoot, 'package-lock.json'), 'utf8')) : null;
const preDeps: Record<string, string> = prePkg?.dependencies ?? {};
const preDevDeps: Record<string, string> = prePkg?.devDependencies ?? {};
const preLockPkgs: Record<string, any> = preLock?.packages ?? {};

// The three packages the fix removes from production installs. @types/ws is the one
// declared; the other two ride in on it (@types/ws -> @types/node -> undici-types)
// and are the reason the win is 3 packages rather than 1.
const TYPE_ONLY_TRIO = ['@types/ws', '@types/node', 'undici-types'];

// ---- A. package.json classification ----
check('A1 @types/ws is NOT in dependencies', !('@types/ws' in deps));
check('A2 @types/ws IS in devDependencies', '@types/ws' in devDeps);
check('A3 @types/ws version spec preserved by the move',
  devDeps['@types/ws'] === '^8.18.1', String(devDeps['@types/ws']));

// CONTROL — the pre-fix image must show the OPPOSITE, or A1/A2 are not discriminating.
if (havePre) {
  check('A4 CONTROL pre-fix HAD @types/ws in dependencies', '@types/ws' in preDeps);
  check('A5 CONTROL pre-fix did NOT have it in devDependencies', !('@types/ws' in preDevDeps));
}

// ---- B. the lock agrees — `--omit=dev` obeys lock dev flags, NOT package.json ----
check('B1 lock root lists @types/ws under devDependencies',
  '@types/ws' in (lockRoot.devDependencies ?? {}));
check('B2 lock root does NOT list @types/ws under dependencies',
  !('@types/ws' in (lockRoot.dependencies ?? {})));
for (const name of TYPE_ONLY_TRIO) {
  check(`B3 lock: node_modules/${name} IS dev-flagged`,
    lockPkgs[`node_modules/${name}`]?.dev === true,
    `dev=${lockPkgs[`node_modules/${name}`]?.dev}`);
}
// CONTROL — pre-fix lock had none of the three dev-flagged, which is exactly why all
// three shipped to production.
if (havePre) {
  for (const name of TYPE_ONLY_TRIO) {
    check(`B4 CONTROL pre-fix lock did NOT dev-flag ${name}`,
      preLockPkgs[`node_modules/${name}`]?.dev !== true);
  }
}

// ---- C. safety: the reclassification must not have demoted anything with real code ----
// This is the assertion that would catch the dangerous version of this change — a
// runtime package silently dev-flagged, which `--omit=dev` would then omit.
if (havePre) {
  const newlyDev = Object.keys(lockPkgs).filter(
    (k) => lockPkgs[k]?.dev === true && preLockPkgs[k]?.dev !== true,
  );
  const lostDev = Object.keys(lockPkgs).filter(
    (k) => preLockPkgs[k]?.dev === true && lockPkgs[k]?.dev !== true,
  );
  check('C1 exactly three packages newly dev-flagged',
    newlyDev.length === 3, newlyDev.join(', '));
  check('C2 they are exactly the type-only trio',
    TYPE_ONLY_TRIO.every((n) => newlyDev.includes(`node_modules/${n}`)), newlyDev.join(', '));
  check('C3 NOTHING lost dev status (nothing silently promoted to production)',
    lostDev.length === 0, lostDev.join(', '));
  check('C4 the resolved package SET is unchanged (a reclassification, not a re-resolve)',
    JSON.stringify(Object.keys(preLockPkgs).sort()) === JSON.stringify(Object.keys(lockPkgs).sort()));

  // Every newly dev-flagged package must ship zero executable JS. Checked against the
  // real installed tree, not inferred from the name — "@types/*" is a convention, not
  // a guarantee, and undici-types is not even named like a types package.
  for (const k of newlyDev) {
    const dir = join(ROOT, k); // W2 fix: honour the target ROOT, not the live repo
    // C5 is only meaningful against a REAL installed tree. A missing directory used to leave a
    // `jsCount = -1` sentinel that surfaced as "found -1 js files" — a negative file count
    // printed as though it were a measurement, under a label claiming the package ships JS.
    // "not installed" and "installed and ships JS" are different facts and now read differently.
    if (!existsSync(dir)) {
      check(`C5 ${k} is installed, so its contents can be checked at all`, false,
        `${dir} does not exist — C5 needs an installed tree; run npm install, or point ROOT at one`);
      continue;
    }
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else out.push(p);
      }
      return out;
    };
    const jsCount = walk(dir).filter((f) => /\.(js|cjs|mjs)$/.test(f)).length;
    check(`C5 ${k} ships zero runtime JS (safe to omit from production)`,
      jsCount === 0, `found ${jsCount} js files`);
  }
}

// ---- D. MOVE, not DELETE — the package is still required by the typecheck gate ----
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkSrc(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
// walkSrc used to be called unguarded, so pointing this harness at a PARTIAL tree — a snapshot
// image holding only package.json and package-lock.json, which this project's history is full of
// — threw a raw ENOENT stack with ZERO assertions reported. Same shape as the W1 defect fixed
// above: it exits 1, so run.mjs marks it FAIL rather than PASS and nothing goes falsely green,
// but the message reads as a broken harness rather than "you pointed me at the wrong tree".
// Found by reviewer-1 (msg 1529/1530) and guarded the way C5 is.
const SRC_DIR = join(ROOT, 'src');
if (!existsSync(SRC_DIR)) {
  check(`D1 ${SRC_DIR} exists, so the src/ import checks can run at all`, false,
    'no src/ under the target — D1 inspects it for the "ws" type import; point ROOT at a full tree');
} else {
  const srcAll = walkSrc(SRC_DIR).map((f) => readFileSync(f, 'utf8')).join('\n');
  check('D1 src/ still imports a type from "ws" (the reason the package is needed)',
    /import\s+type\s*\{[^}]*\}\s*from\s*['"]ws['"]/.test(srcAll));
}
check('D2 @types/ws is still DECLARED somewhere (not deleted)',
  '@types/ws' in deps || '@types/ws' in devDeps);
check('D3 typecheck script still exists and is the gate that needs it',
  /tsc\s+--noEmit/.test(pkg.scripts?.typecheck ?? ''), String(pkg.scripts?.typecheck));

// ---- E. the general rule this task is an instance of ----
// A types-only package in `dependencies` is the bug class; assert the whole class, so
// the next one added is caught rather than re-discovered by a sixth session.
const typePkgsInDeps = Object.keys(deps).filter((n) => n.startsWith('@types/'));
check('E1 NO @types/* package sits in dependencies', typePkgsInDeps.length === 0,
  typePkgsInDeps.join(', '));
check('E2 all three @types/* packages are in devDependencies',
  ['@types/better-sqlite3', '@types/node', '@types/ws'].every((n) => n in devDeps),
  Object.keys(devDeps).join(', '));
// CONTROL — pre-fix violated E1, which is what makes E1 a real assertion.
if (havePre) {
  check('E3 CONTROL pre-fix DID have an @types/* in dependencies',
    Object.keys(preDeps).some((n) => n.startsWith('@types/')));
}

// ---- F. no collateral damage to genuine runtime deps ----
check('F1 tsx is STILL in dependencies (builder-28 t_494803b0 fix intact)', 'tsx' in deps);
check('F2 ws is STILL in dependencies', 'ws' in deps);
check('F3 lock: node_modules/tsx still NOT dev-flagged',
  lockPkgs['node_modules/tsx']?.dev !== true);
check('F4 lock: node_modules/ws still NOT dev-flagged',
  lockPkgs['node_modules/ws']?.dev !== true);
if (havePre) {
  const removed = Object.keys(preDeps).filter((n) => !(n in deps));
  const added = Object.keys(deps).filter((n) => !(n in preDeps));
  check('F5 dependencies lost EXACTLY @types/ws and nothing else',
    removed.length === 1 && removed[0] === '@types/ws', removed.join(', '));
  check('F6 dependencies gained nothing', added.length === 0, added.join(', '));
}
check('F7 lockfileVersion is 3 (dev flags are per-package)', lock.lockfileVersion === 3,
  String(lock.lockfileVersion));

// ---- report ----
console.log(`\ntarget: ${ROOT}${isPreFixImage ? '   [PRE-FIX IMAGE — this run is EXPECTED to fail]' : ''}`);
console.log(`dependencies: ${Object.keys(deps).sort().join(', ')}`);
console.log(`devDependencies: ${Object.keys(devDeps).sort().join(', ')}`);
if (!havePre) console.log('⚠️  pre-fix image absent — CONTROL cases were skipped');
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  *** ${f}`);
  process.exit(1);
}
console.log(`\n${pass}/${pass} assertions passed`);
console.log('✓ all green — type-only packages stay out of production installs; @types/ws moved, not deleted');
