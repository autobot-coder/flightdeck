/* Repo root from __dirname. This file is .cjs, not .js, because package.json sets
   "type": "module" — a .js here is parsed as ESM and its require() calls throw. */
const __REPO = require("node:path").resolve(__dirname, "..");
/* Frontend gate for the model-naming change (t_46218837).
   app.js is 'use strict', so eval-extraction does not leak declarations (builder-20 gotcha #1).
   Real code is sliced out of app.js and rebuilt with new Function, with `state` injected. */
const fs = require('node:fs');
const SRC = fs.readFileSync(`${__REPO}/dashboard/app.js`, 'utf8');

// Slice a top-level declaration by its opening marker through the first column-0 close.
function slice(marker, close) {
  const i = SRC.indexOf(marker);
  if (i === -1) throw new Error('marker not found: ' + marker);
  const j = SRC.indexOf(close, i);
  if (j === -1) throw new Error('close not found for: ' + marker);
  return SRC.slice(i, j + close.length);
}

const code = [
  slice('const MODELS = [', '\n];'),
  slice('function modelEntry(m) {', '\n}'),
  slice('function modelCatalog(models) {', '\n}'),
  slice('function modelLabel(id) {', '\n}'),
  slice('function defaultModelFor(role) {', '\n}'),
  slice('function esc(value) {', '\n}'),
  slice('function modelOptionsHTML(selected, models) {', '\n}')
].join('\n\n');

const build = new Function('state', code +
  '\nreturn { MODELS, modelEntry, modelCatalog, modelLabel, defaultModelFor, modelOptionsHTML, esc };');

let pass = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else fails.push(name); }

// Server catalog exactly as src/config.ts now ships it.
const SERVED = [
  { id: 'sonnet', label: 'Claude-Sonnet-5' },
  { id: 'fable', label: 'Claude-Fable-5' },
  { id: 'opus', label: 'Claude-Opus-5' },
  { id: 'haiku', label: 'Claude-Haiku-4.5' }
];

// ---- A. offline fallback (state.models still null, before /api/state answers) ----
{
  const F = build({ models: null });
  ok('A1 offline fallback has 4 entries', F.modelCatalog().length === 4);
  ok('A2 offline labels are Claude-* names',
    F.modelCatalog().every((m) => /^Claude-[A-Z][a-z]+-\d+(\.\d+)?$/.test(m.label)));
  ok('A3 offline labels never show a bare alias', !F.modelCatalog().some((m) => m.label === m.id));
  ok('A4 offline ids are the four aliases',
    JSON.stringify(F.modelCatalog().map((m) => m.id)) === JSON.stringify(['sonnet', 'fable', 'opus', 'haiku']));
  ok('A5 offline fallback matches the server catalog exactly',
    JSON.stringify(F.modelCatalog()) === JSON.stringify(SERVED));
  ok('A6 no label contains an em-dash restatement', !F.modelCatalog().some((m) => m.label.includes('—')));
  ok('A7 defaultModelFor(grunt) is haiku', F.defaultModelFor('grunt') === 'haiku');
  ok('A8 defaultModelFor(builder) is sonnet', F.defaultModelFor('builder') === 'sonnet');
}

// ---- B. served catalog (normal case, post /api/state) ----
{
  const F = build({ models: SERVED });
  const html = F.modelOptionsHTML('opus', SERVED);
  ok('B1 renders 4 options', (html.match(/<option/g) || []).length === 4);
  ok('B2 option text is the pretty name', html.includes('>Claude-Opus-5</option>'));
  ok('B3 option VALUE is still the bare alias', html.includes('value="opus"'));
  ok('B4 current model stays selected', /value="opus" selected>/.test(html));
  ok('B5 no option renders the raw id as its text', !/>opus<\/option>/.test(html));
  ok('B6 no duplicate option labels',
    new Set((html.match(/>([^<]+)<\/option>/g) || [])).size === 4);
  ok('B7 haiku reads Claude-Haiku-4.5', html.includes('>Claude-Haiku-4.5</option>'));
  ok('B8 longest label is much shorter than the old 33-char one',
    Math.max(...SERVED.map((m) => m.label.length)) <= 17);
  ok('B9 modelLabel maps alias -> pretty name', F.modelLabel('opus') === 'Claude-Opus-5');
  ok('B10 modelLabel maps haiku -> Claude-Haiku-4.5', F.modelLabel('haiku') === 'Claude-Haiku-4.5');
}

// ---- C. never-orphan: a value the catalog no longer lists ----
{
  const F = build({ models: SERVED });
  const html = F.modelOptionsHTML('claude-opus-4-5-20251101', SERVED);
  ok('C1 unlisted current value is prepended, not dropped', (html.match(/<option/g) || []).length === 5);
  ok('C2 unlisted value is still selected', /value="claude-opus-4-5-20251101" selected>/.test(html));
  ok('C3 unlisted value shows its raw id (never renamed)',
    html.includes('>claude-opus-4-5-20251101</option>'));
  ok('C4 modelLabel falls back to the raw id for unlisted models',
    F.modelLabel('claude-opus-4-5-20251101') === 'claude-opus-4-5-20251101');
  ok('C5 modelLabel of a retired agent on a dropped pin is not blanked',
    F.modelLabel('claude-haiku-4-5-20251001') === 'claude-haiku-4-5-20251001');
  ok('C6 modelLabel of empty is empty', F.modelLabel('') === '' && F.modelLabel(null) === '');
}

// ---- D. operator-configured catalog still wins (ruling #21 mechanism) ----
{
  const CUSTOM = [{ id: 'claude-opus-4-5-20251101', label: 'Claude-Opus-4.5' }, 'claude-opus-5'];
  const F = build({ models: CUSTOM });
  const html = F.modelOptionsHTML('claude-opus-5', CUSTOM);
  ok('D1 config catalog replaces the default', (html.match(/<option/g) || []).length === 2);
  ok('D2 configured label is honoured', html.includes('>Claude-Opus-4.5</option>'));
  ok('D3 bare-string entry falls back to its id as label', html.includes('>claude-opus-5</option>'));
  ok('D4 plain strings still tolerated', F.modelEntry('opus').id === 'opus');
}

// ---- E. escaping is unchanged ----
{
  const F = build({ models: [{ id: 'x"y', label: '<b>z</b>' }] });
  const html = F.modelOptionsHTML('x"y', [{ id: 'x"y', label: '<b>z</b>' }]);
  ok('E1 label is escaped', html.includes('&lt;b&gt;z&lt;/b&gt;') && !html.includes('<b>z</b>'));
  ok('E2 value is escaped', !/value="x"y"/.test(html));
}

console.log(`frontend: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL: ' + f); process.exit(1); }
