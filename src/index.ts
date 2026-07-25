import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, ensureConfigFile } from './config.js';
import { openDb, Store } from './db.js';
import { shutdownActiveTurns } from './orchestrator/session.js';
import { Supervisor } from './orchestrator/supervisor.js';
import { formatPreflight, MIN_NODE_MAJOR, preflight } from './preflight.js';
import { startServer } from './server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2] ?? path.join(ROOT, 'flightdeck.config.json');

// A fresh clone has no flightdeck.config.json (it is gitignored — it holds absolute paths to
// the user's own projects). Seed it from the tracked example so `npm start` just works.
const seeded = ensureConfigFile(configPath, path.join(ROOT, 'flightdeck.config.example.json'));
if (seeded) console.log(`✓ created ${path.basename(configPath)} from the example template`);

/** A first-time user hand-editing the config gets a pointer to the mistake, not a raw stack. */
function fail(...lines: string[]): never {
  console.error('\n' + lines.join('\n') + '\n');
  process.exit(1);
}

let configStore: ConfigStore;
try {
  configStore = new ConfigStore(configPath, ROOT);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  fail(
    `✗ Could not read ${configPath}`,
    e instanceof SyntaxError
      ? `  It is not valid JSON: ${e.message}\n  Fix the syntax, or delete the file and restart to regenerate it from flightdeck.config.example.json.`
      : `  ${e.message}`,
  );
}
const config = configStore.config;
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// Check the environment before the supervisor can spawn anything, so a missing or
// unspawnable CLI is a banner at startup rather than a silent turn failure later.
const report = await preflight(config.cliPath);
const banner = formatPreflight(report);
if (banner) console.log(banner);

// An unsupported Node used to print "✗ Node 18 is too old" and then start anyway, so the very
// next lines said the app was up. package.json declares engines >=20 but npm only warns, and
// better-sqlite3 resolves a Node 18 prebuild, so nothing else fails loudly — the user gets a
// half-working install and a contradictory transcript. Refuse instead: a clear stop is kinder
// than a server that runs until something subtler breaks. FLIGHTDECK_SKIP_NODE_CHECK=1 is the
// escape hatch for anyone who has measured their runtime and disagrees.
if (!report.node.ok && process.env.FLIGHTDECK_SKIP_NODE_CHECK !== '1') {
  fail(
    `✗ Refusing to start on Node ${report.node.version} — Flightdeck needs Node ${MIN_NODE_MAJOR}+.`,
    `  Install the current LTS from https://nodejs.org, then run \`npm install\` again.`,
    `  To start anyway (unsupported), set FLIGHTDECK_SKIP_NODE_CHECK=1.`,
  );
}

for (const ws of config.workspaces) {
  if (!fs.existsSync(ws.path)) {
    console.warn(`⚠ workspace "${ws.id}" path does not exist: ${ws.path}`);
  }
  // `roles` is required (types.ts) and every consumer iterates it, so a hand-edited workspace
  // that omits it used to abort bootstrap with a raw "ws.roles is not iterable" stack — the
  // exact outcome fail() exists to prevent. An EMPTY array is structurally valid, so it only
  // warns: the Settings panel renders it, which is where the operator can add roles back.
  if (!Array.isArray(ws.roles)) {
    fail(
      `✗ workspace "${ws.id}" in ${path.basename(configPath)} has no "roles" array.`,
      `  Add one, e.g. "roles": [{ "role": "lead", "model": "opus" }], or remove the workspace.`,
    );
  }
  if (ws.roles.length === 0) {
    console.warn(`⚠ workspace "${ws.id}" has no roles — it will have no agents and cannot run a goal. Add roles in the dashboard's Settings panel.`);
  }
}

const store = new Store(openDb(config.dbPath));

// The supervisor needs the server's broadcast hook and the server needs the supervisor;
// break the cycle with a late-bound forwarder.
let emit: (workspaceId: string) => void = () => {};
const supervisor = new Supervisor(store, config, (id) => emit(id));
supervisor.cli = report.cli;
supervisor.bootstrap();

let onEvent: (workspaceId: string) => void;
try {
  ({ onEvent } = await startServer(store, supervisor, configStore, report));
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    fail(
      `✗ Port ${config.port} is already in use.`,
      `  Flightdeck may already be running — open http://localhost:${config.port} first.`,
      `  Otherwise change "port" in ${path.basename(configPath)} and start again.`,
    );
  }
  throw err;
}
emit = onEvent;
supervisor.start();

console.log(`Flightdeck up: http://localhost:${config.port}`);
console.log(
  config.workspaces.length > 0
    ? `Workspaces: ${config.workspaces.map((w) => w.id).join(', ')}`
    : 'No workspaces yet — open the dashboard and add your first project to get started.',
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  supervisor.stop();
  // Kill in-flight turns and release their agents so nothing is left stuck in 'working'.
  shutdownActiveTurns(store);
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
