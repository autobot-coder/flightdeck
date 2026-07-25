/* builder-30 — gate for t_0e0459a3 part A: the dashboard must surface an unsupported
   Node runtime. GATE-SAFE (asserts the FIXED behaviour, must stay green).

   Technique follows builder-20's/label-test.js precedent: app.js is 'use strict', so real
   code is sliced out and rebuilt with `new Function`, with `state` injected.

   ⚠️ Every positive is paired against the PRE-FIX app.js from my pickup snapshot
   (base30/dashboard/app.js) evaluated in the SAME harness — builder-29's rule: a case that
   passes both before and after proves nothing. The pre-fix build is expected to say
   "no setup screen" for exactly the case that matters. */
import fs from 'node:fs';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

const FIXED = `${__REPO}/dashboard/app.js`;
const PREFIX_IMG = `${__REPO}/tests/fixtures/base30/dashboard/app.js`;

/**
 * W1 fix (builder-32): this used to throw on a missing marker. A top-level throw exits 1 with
 * a message that reads like a BROKEN HARNESS, so a future reader concludes the test is stale
 * rather than that the code under test lost the function being sliced. Now it records a named
 * failed assertion and returns null, so the summary says which marker went missing.
 */
const sliceFailures: string[] = [];
function slice(src: string, marker: string, close: string): string | null {
  const i = src.indexOf(marker);
  if (i === -1) { sliceFailures.push(`source no longer contains the marker \`${marker}\``); return null; }
  const j = src.indexOf(close, i);
  if (j === -1) { sliceFailures.push(`no closing \`${close}\` after \`${marker}\``); return null; }
  return src.slice(i, j + close.length);
}

/** Build a `setupNeeded` bound to an injected `state`. `withHelper` is false for the
 *  pre-fix image, which has no nodeUnsupported(). */
function buildSetupNeeded(file: string, withHelper: boolean) {
  const src = fs.readFileSync(file, 'utf8');
  const parts = [slice(src, 'function setupNeeded() {', '\n}')];
  if (withHelper) parts.unshift(slice(src, 'function nodeUnsupported(s) {', '\n}'));
  if (parts.some((p) => p === null)) return null; // reported via sliceFailures, not thrown
  const code = parts.join('\n\n') + '\nreturn setupNeeded;';
  return (state: unknown) => new Function('state', code)(state) as () => boolean;
}

const fixed = buildSetupNeeded(FIXED, true);
const prefix = buildSetupNeeded(PREFIX_IMG, false);

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean) { if (cond) pass++; else fails.push(name); }

// A fully set-up machine: CLI resolved, a project added. Nothing else would open the modal.
const READY = { cli: { ready: true }, has_workspaces: true, auth: { mode: 'cli-login' } };

// ---- A. THE DEFECT ITSELF: set-up machine on an unsupported runtime ----
{
  const s = { ...READY, node: { version: '18.20.8', ok: false, min_major: 20 } };
  ok('A1 FIXED: unsupported node opens the setup screen',
    fixed({ setup: s, setupDismissed: false })() === true);
  ok('A2 NEGATIVE CONTROL — PRE-FIX app.js stays silent on the very same state',
    prefix({ setup: s, setupDismissed: false })() === false);
}

// ---- B. supported runtime must not regress into a permanently-open modal ----
{
  const s = { ...READY, node: { version: '22.3.0', ok: true, min_major: 20 } };
  ok('B1 supported node + ready CLI + workspaces => no setup screen',
    fixed({ setup: s, setupDismissed: false })() === false);
  ok('B2 pre-fix agreed here (proves A2 is not just "pre-fix always false")',
    prefix({ setup: s, setupDismissed: false })() === false);
}

// ---- C. "not probed" must NOT be read as unsupported ----
// The server sends node:null when it has no preflight report; mirrors `report?.ok ?? true`.
{
  ok('C1 node:null => benefit of the doubt, no setup screen',
    fixed({ setup: { ...READY, node: null }, setupDismissed: false })() === false);
  ok('C2 node key absent entirely => same',
    fixed({ setup: { ...READY }, setupDismissed: false })() === false);
  ok('C3 node.ok undefined (older server) => same',
    fixed({ setup: { ...READY, node: { version: '22.3.0' } }, setupDismissed: false })() === false);
  ok('C4 only an explicit false counts',
    fixed({ setup: { ...READY, node: { version: '18.0.0', ok: false } }, setupDismissed: false })() === true);
}

// ---- D. dismissible ON PURPOSE (recorded decision: non-dismissible = de-facto boot abort,
//         which is part B and the owner's call, not mine) ----
{
  const s = { ...READY, node: { version: '18.20.8', ok: false, min_major: 20 } };
  ok('D1 dismissing closes it even on a bad runtime',
    fixed({ setup: s, setupDismissed: true })() === false);
  ok('D2 undismissed it is open', fixed({ setup: s, setupDismissed: false })() === true);
}

// ---- E. the pre-existing triggers still work, unchanged ----
{
  ok('E1 CLI not ready still opens',
    fixed({ setup: { cli: { ready: false }, has_workspaces: true, node: { ok: true } }, setupDismissed: false })() === true);
  ok('E2 no workspaces still opens',
    fixed({ setup: { cli: { ready: true }, has_workspaces: false, node: { ok: true } }, setupDismissed: false })() === true);
  ok('E3 missing cli block still opens',
    fixed({ setup: { has_workspaces: true, node: { ok: true } }, setupDismissed: false })() === true);
  ok('E4 no setup block at all => closed (unchanged)',
    fixed({ setup: null, setupDismissed: false })() === false);
  ok('E5 both bad (CLI + node) still opens',
    fixed({ setup: { cli: { ready: false }, has_workspaces: false, node: { ok: false } }, setupDismissed: false })() === true);
}

// ---- F. the served payload actually carries min_major (server half of the change) ----
{
  const srv = fs.readFileSync(`${__REPO}/src/server/index.ts`, 'utf8');
  ok('F1 setupJson node block emits min_major', /min_major:\s*MIN_NODE_MAJOR/.test(srv));
  ok('F2 MIN_NODE_MAJOR is imported, not re-declared',
    /import \{[^}]*MIN_NODE_MAJOR[^}]*\} from '\.\.\/preflight\.js'/.test(srv));
  const pre = fs.readFileSync(PREFIX_IMG.replace('dashboard/app.js', 'src/server/index.ts'), 'utf8');
  ok('F3 NEGATIVE CONTROL — pre-fix server did not send it', !/min_major/.test(pre));
}

// ---- G. the note is built from served data, not hardcoded ----
{
  const app = fs.readFileSync(FIXED, 'utf8');
  ok('G1 note reads the served version', /s\.node\.version/.test(app));
  ok('G2 note reads the served min_major', /s\.node\.min_major/.test(app));
  ok('G3 no hardcoded "Node 20" string in the dashboard', !/Node 20/.test(app));
  ok('G4 node state is in the render signature (a recheck cannot be skipped)',
    /s\.node && s\.node\.ok/.test(app));
}

// ---- H. markup + CSS contract ----
{
  const html = fs.readFileSync(`${__REPO}/dashboard/index.html`, 'utf8');
  const css = fs.readFileSync(`${__REPO}/dashboard/style.css`, 'utf8');
  ok('H1 banner element exists', /id="setup-node-warn"/.test(html));
  ok('H2 banner ships hidden (never flashes before the verdict arrives)',
    /id="setup-node-warn"[^>]*\shidden/.test(html));
  ok('H3 note target exists', /id="setup-node-note"/.test(html));
  ok('H4 role=alert so it is announced', /id="setup-node-warn"[^>]*role="alert"/.test(html));
  for (const c of ['setup-warn', 'setup-warn-mark', 'setup-warn-title', 'setup-warn-note'])
    ok('H5 CSS exists for .' + c, new RegExp('\\.' + c + '(?![\\w-])').test(css));
  ok('H6 [hidden] beats the flex display', /\.setup-warn\[hidden\]\s*\{\s*display:\s*none/.test(css));
  ok('H7 no new design token invented', !/--gold-ghost|--warn-ghost/.test(css));
}

console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('✓ all green — unsupported-Node surfacing, paired against the pre-fix image in the same harness');
