/**
 * builder-27: verifies the flightdeck-bus MCP server config emitted by session.ts.
 *
 * Guards the Windows defect where node was handed node_modules/.bin/tsx — a #!/bin/sh
 * cmd-shim on Windows, which node parses as JavaScript and rejects. Checks the emitted
 * entry is real JavaScript, then actually spawns it and completes an MCP initialize
 * handshake, so this is a functional test and not just a string assertion.
 *
 * Uses its own throwaway DB — never the live one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpConfigFor } from '../src/orchestrator/session.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const tmpDb = path.join(os.tmpdir(), `mc-mcp-probe-${process.pid}.db`);
const agent = {
  id: 'a_probe', workspace_id: 'w_probe', name: 'probe', role: 'builder',
} as any;

const cfg = JSON.parse(mcpConfigFor(agent, tmpDb));
const server = cfg.mcpServers['flightdeck-bus'];
const [entry, script] = server.args as string[];

console.log('emitted command:', server.command);
console.log('emitted entry  :', entry);

// --- static guards ---------------------------------------------------------
ok('command is this node binary', server.command === process.execPath);
ok('entry does NOT go through node_modules/.bin',
   !entry.includes(`${path.sep}.bin${path.sep}`), `-> ${entry}`);
ok('entry exists on disk', fs.existsSync(entry));
ok('bus server script exists', fs.existsSync(script));

const head = fs.readFileSync(entry, 'utf8').slice(0, 200);
ok('entry is NOT a shell script', !head.startsWith('#!/bin/sh'), `head=${head.slice(0, 40)}`);
ok('entry is a .mjs/.js module', /\.(mjs|js|cjs)$/.test(entry), `-> ${path.extname(entry)}`);

// A real symlink resolves to the same file the exports map names; the Windows shim does not.
ok('entry resolves inside the tsx package',
   fs.realpathSync(entry).includes(`${path.sep}tsx${path.sep}`), `-> ${fs.realpathSync(entry)}`);

// --- functional: spawn it and complete an MCP handshake --------------------
const handshake = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const done = (r: { ok: boolean; detail: string }) => {
    clearTimeout(timer);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    resolve(r);
  };
  const timer = setTimeout(() => done({ ok: false, detail: `timeout; stderr=${err.slice(-300)}` }), 25_000);

  child.stdout.on('data', (d) => {
    out += d.toString();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && msg.result?.serverInfo) {
          done({ ok: true, detail: JSON.stringify(msg.result.serverInfo) });
        }
      } catch { /* partial line */ }
    }
  });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => done({ ok: false, detail: `spawn error: ${e.message}` }));
  child.on('close', (code) => done({ ok: false, detail: `exited ${code}; stderr=${err.slice(-300)}` }));

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'builder-27-probe', version: '1.0.0' },
    },
  }) + '\n');
});

ok('spawned MCP server answered initialize', handshake.ok, handshake.detail);
if (handshake.ok) console.log('  serverInfo:', handshake.detail);

try { fs.rmSync(tmpDb, { force: true }); fs.rmSync(`${tmpDb}-shm`, { force: true }); fs.rmSync(`${tmpDb}-wal`, { force: true }); } catch { /* nothing to clean */ }

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (fail) { console.log('✗ FAILED'); process.exit(1); }
console.log('✓ all green — emitted MCP entry is real JS and the server handshakes');
