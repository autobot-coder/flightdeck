/**
 * builder-24 — assertions for the user-agnostic layer (t_7766e919).
 * Pure imports of src/config.ts + src/preflight.ts. No server, no DB.
 * Run: npx tsx <ABSOLUTE path to this file>   (relative paths fail MODULE_NOT_FOUND under tsx)
 */
import {
  DEFAULT_OWNER_NAME,
  ensureConfigFile,
  ownerIdFrom,
  ownerNameFrom,
} from '../src/config.ts';
import { MIN_NODE_MAJOR, formatPreflight, preflight, resolveCli } from '../src/preflight.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf, resolve as __resolvePath } from 'node:path';
/** Repo root, from this file's own location — works in any clone, no argv needed. */
const __REPO = __resolvePath(__dirnameOf(__fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, detail = '') {
  if (cond) pass++;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- owner name
eq('ownerName absent -> default', ownerNameFrom({}), DEFAULT_OWNER_NAME);
eq('ownerName empty string -> default', ownerNameFrom({ ownerName: '' }), DEFAULT_OWNER_NAME);
eq('ownerName whitespace -> default', ownerNameFrom({ ownerName: '   ' }), DEFAULT_OWNER_NAME);
eq('ownerName set -> used verbatim', ownerNameFrom({ ownerName: 'Ada Lovelace' }), 'Ada Lovelace');
eq('ownerName trimmed', ownerNameFrom({ ownerName: '  Ada  ' }), 'Ada');

// A fresh clone must never attribute its user's messages to somebody else.
eq('ownerId absent -> operator', ownerIdFrom({}), 'operator');
eq('ownerId empty -> operator', ownerIdFrom({ ownerName: '' }), 'operator');
eq('ownerId punctuation-only -> operator', ownerIdFrom({ ownerName: '!!!' }), 'operator');
eq('ownerId slugifies', ownerIdFrom({ ownerName: 'Ada Lovelace' }), 'ada-lovelace');
eq('ownerId slugifies spaces', ownerIdFrom({ ownerName: 'Ada Lovelace' }), 'ada-lovelace');
eq('ownerId strips edge dashes', ownerIdFrom({ ownerName: ' -Bob- ' }), 'bob');
eq('ownerId collapses runs', ownerIdFrom({ ownerName: 'A   B' }), 'a-b');

// --------------------------------------------------------- example template
const ROOT = __REPO;
const examplePath = path.join(ROOT, 'flightdeck.config.example.json');
ok('example config exists', fs.existsSync(examplePath));
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
eq('example has zero workspaces', Array.isArray(example.workspaces) && example.workspaces.length, 0);
eq('example ownerName is blank', example.ownerName, '');
ok('example has a port', typeof example.port === 'number');
ok('example has dbPath', typeof example.dbPath === 'string');
ok(
  'example contains NO absolute home paths',
  !/\/Users\/|\/home\/|C:\\\\/.test(JSON.stringify(example)),
  JSON.stringify(example).slice(0, 120),
);
ok('example names nobody', !/manish/i.test(JSON.stringify(example)));

// ------------------------------------------------------------ ensureConfigFile
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
const target = path.join(tmp, 'flightdeck.config.json');
eq('seeds when absent', ensureConfigFile(target, examplePath), true);
ok('seeded file exists', fs.existsSync(target));
eq('seeded content matches template', fs.readFileSync(target, 'utf8'), fs.readFileSync(examplePath, 'utf8'));
fs.writeFileSync(target, '{"port":9999,"dbPath":"x","maxConcurrentTurns":1,"tickSeconds":5,"workspaces":[]}');
eq('does NOT overwrite an existing config', ensureConfigFile(target, examplePath), false);
eq('existing config left untouched', JSON.parse(fs.readFileSync(target, 'utf8')).port, 9999);
let threw = false;
try {
  ensureConfigFile(path.join(tmp, 'other.json'), path.join(tmp, 'no-such-template.json'));
} catch {
  threw = true;
}
ok('throws when template is missing too', threw);
fs.rmSync(tmp, { recursive: true, force: true });

// -------------------------------------------------------------- CLI resolution
const auto = await resolveCli();
ok('auto-resolve finds the CLI on this machine', auto.found, JSON.stringify(auto));
ok('resolution reports a version', !!auto.version, String(auto.version));
ok('prefixArgs is an array', Array.isArray(auto.prefixArgs));
ok(
  'source is one of the known kinds',
  ['config', 'env', 'native-binary', 'npm-script', 'path'].includes(auto.source),
  auto.source,
);

// An explicit path always wins and is never second-guessed.
const explicit = await resolveCli('/definitely/not/a/real/cli');
eq('explicit bad path is honoured, not silently replaced', explicit.command, '/definitely/not/a/real/cli');
eq('explicit bad path reports not-found', explicit.found, false);
eq('explicit source is config', explicit.source, 'config');
ok('explicit failure carries an error string', !!explicit.error);

// A .js target runs under this same node binary — the Windows .cmd sidestep.
const jsCli = await resolveCli('/tmp/nope/cli.js');
eq('.js target spawns under node', jsCli.command, process.execPath);
eq('.js target passed as prefix arg', jsCli.prefixArgs[0], '/tmp/nope/cli.js');

// ------------------------------------------------------------------ preflight
const r = await preflight();
eq('preflight node major matches runtime', r.node.major, Number(process.versions.node.split('.')[0]));
eq('preflight node ok reflects the floor', r.node.ok, r.node.major >= MIN_NODE_MAJOR);
eq('preflight.ok is node AND cli', r.ok, r.node.ok && r.cli.found);
ok('auth mode is a known value', ['api-key', 'cli-login'].includes(r.auth.mode), r.auth.mode);
eq('platform is reported', r.platform, process.platform);

const bad = { ...r, cli: { ...r.cli, found: false, error: 'boom' } };
const banner = formatPreflight(bad);
ok('missing-CLI banner names the install command', banner.includes('npm install -g @anthropic-ai/claude-code'));
ok('missing-CLI banner mentions signing in', /sign in/i.test(banner));
ok('missing-CLI banner mentions cliPath escape hatch', banner.includes('cliPath'));
const goodBanner = formatPreflight({ ...r, cli: { ...r.cli, found: true } });
ok('healthy banner does not shout install instructions', !goodBanner.includes('npm install -g'));

// ---------------------------------------------------------------------- report
console.log(`\n${pass}/${pass + fails.length} assertions passed`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all green');
