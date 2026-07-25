/* Backend gate for the model-naming change (t_46218837). Pure import, no server, no DB. */
import fs from 'node:fs';
import { DEFAULT_MODEL_CATALOG, modelCatalogFrom, resolveModel, defaultRole } from '../src/config.js';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean) {
  if (cond) pass++; else fails.push(name);
}

// --- the actual complaint: names must not repeat the model name -------------
ok('catalog has exactly 4 entries (no duplicate restatement)', DEFAULT_MODEL_CATALOG.length === 4);
ok('no label contains an em-dash alias—pin restatement',
  DEFAULT_MODEL_CATALOG.every((m) => !m.label.includes('—')));
ok('every label is Claude-Xxx-N form',
  DEFAULT_MODEL_CATALOG.every((m) => /^Claude-[A-Z][a-z]+-\d+(\.\d+)?$/.test(m.label)));
ok('no label repeats its own id inside itself',
  DEFAULT_MODEL_CATALOG.every((m) => m.label.toLowerCase().split(m.id.toLowerCase()).length <= 2));
ok('all labels unique', new Set(DEFAULT_MODEL_CATALOG.map((m) => m.label)).size === 4);
ok('all ids unique', new Set(DEFAULT_MODEL_CATALOG.map((m) => m.id)).size === 4);

// --- ids must NOT have changed: live config + DB rows use bare aliases ------
ok('ids are exactly the four bare aliases',
  JSON.stringify(DEFAULT_MODEL_CATALOG.map((m) => m.id)) === JSON.stringify(['sonnet', 'fable', 'opus', 'haiku']));

const CONFIG_PATH = `${__REPO}/flightdeck.config.json`;
/**
 * PRECONDITION: this gate asserts against the OPERATOR'S REAL flightdeck.config.json,
 * which is gitignored — that is the point of it (a clean-clone fixture only ever exercises
 * the default path). In a fresh clone the file does not exist, so declare that and exit 77
 * = SKIP rather than crashing with ENOENT, which reads as a broken harness.
 */
if (!fs.existsSync(CONFIG_PATH)) {
  console.log('SKIP catalog-test: no flightdeck.config.json in this tree.');
  console.log('  This gate deliberately checks the real operator config, not a fixture.');
  console.log('  Run it in a configured checkout (one that has been started at least once).');
  process.exit(77);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const cat = modelCatalogFrom(cfg.models);
const liveModels: string[] = [];
for (const w of cfg.workspaces ?? []) for (const r of w.roles ?? []) if (r.model) liveModels.push(r.model);
ok('flightdeck.config.json has role entries to check', liveModels.length > 0);
ok('EVERY live role model resolves to itself (no agent silently re-pointed)',
  liveModels.every((m) => resolveModel(cat, m) === m));
ok('grunt default (haiku) still resolves to haiku', resolveModel(cat, 'haiku') === 'haiku');
ok('defaultRole(grunt) still asks for haiku and it is selectable',
  resolveModel(cat, defaultRole('grunt', 'sonnet').model) === 'haiku');
ok('defaultRole(builder,opus) still resolves to opus',
  resolveModel(cat, defaultRole('builder', 'opus').model) === 'opus');

// --- ruling #21 mechanisms must survive ------------------------------------
ok('absent models -> default catalog', modelCatalogFrom(undefined) === DEFAULT_MODEL_CATALOG);
ok('empty models -> default catalog', modelCatalogFrom([]) === DEFAULT_MODEL_CATALOG);
ok('all-blank models -> default catalog', modelCatalogFrom(['', '   ']) === DEFAULT_MODEL_CATALOG);
const pinned = modelCatalogFrom(['claude-opus-4-5-20251101', { id: 'claude-opus-5', label: 'Claude-Opus-5' }]);
ok('operator can still pin exact versions via config', pinned.length === 2 && pinned[0].id === 'claude-opus-4-5-20251101');
ok('bare string pin gets its id as label', pinned[0].label === 'claude-opus-4-5-20251101');
ok('config models override the default entirely', !pinned.some((m) => m.id === 'sonnet'));
ok('unknown model still falls back to first entry', resolveModel(cat, 'nope-not-real') === 'sonnet');

console.log(`backend: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL: ' + f); process.exit(1); }
