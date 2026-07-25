/**
 * Environment checks that run before the first agent turn.
 *
 * A fresh clone on someone else's machine fails in three ways — wrong Node, no `claude`
 * CLI, or a CLI that Node cannot spawn the way it is installed — and all three used to
 * surface only as an opaque `spawn failed: ENOENT` buried inside a turn event, leaving
 * the dashboard looking merely idle. These checks run at boot, print actionable guidance
 * to the console, and are served to the dashboard so the setup screen can say what to fix.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** better-sqlite3 prebuilds and the `node:` APIs used here need a modern LTS. */
export const MIN_NODE_MAJOR = 20;

export interface CliResolution {
  /** Executable to spawn. */
  command: string;
  /** Args that must precede the CLI's own args — non-empty when we run cli.js under node. */
  prefixArgs: string[];
  /** Whether the CLI actually answered `--version`. */
  found: boolean;
  version: string | null;
  /** How it was located, surfaced in logs and the setup screen. */
  source: 'config' | 'env' | 'native-binary' | 'npm-script' | 'path';
  error: string | null;
}

export interface PreflightReport {
  ok: boolean;
  node: { version: string; major: number; ok: boolean };
  cli: CliResolution;
  /** Auth mode we can prove from the environment; the CLI's own login is not inspectable. */
  auth: { mode: 'api-key' | 'cli-login'; ok: boolean; detail: string };
  platform: NodeJS.Platform;
}

function run(command: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: String(stdout ?? ''), error: `${stderr || ''} ${err.message}`.trim() });
      else resolve({ ok: true, stdout: String(stdout ?? ''), error: '' });
    });
  });
}

/**
 * Candidate CLI locations, most-specific first. The npm global install on Windows creates
 * `claude.cmd`, which Node has refused to spawn without a shell since CVE-2024-27980 — and
 * routing multi-line prompts through cmd.exe quoting is not safe. So on every platform we
 * prefer a real executable or the package's own `cli.js` run under this same node binary,
 * both of which spawn directly with no shell and no quoting layer.
 */
function candidates(): { command: string; prefixArgs: string[]; source: CliResolution['source'] }[] {
  const home = os.homedir();
  const out: { command: string; prefixArgs: string[]; source: CliResolution['source'] }[] = [];

  // Native installer (`curl -fsSL claude.ai/install.sh` / the Windows installer).
  const nativeBin = process.platform === 'win32'
    ? path.join(home, '.local', 'bin', 'claude.exe')
    : path.join(home, '.local', 'bin', 'claude');
  if (fs.existsSync(nativeBin)) out.push({ command: nativeBin, prefixArgs: [], source: 'native-binary' });

  // npm global install — run the package entrypoint under node, sidestepping .cmd entirely.
  // The fixed roots cover the system and Homebrew installs plus npm's Windows default
  // (%APPDATA%\npm, which the Node installer's own npmrc sets). A version manager such as
  // nvm uses none of them, so we also derive npm's *built-in* default root from this node
  // binary the way npm derives it itself — dirname(execPath) on Windows, one level higher
  // plus `lib` elsewhere. Deriving beats shelling out to `npm root -g`, which would spawn a
  // process on every boot. Ranked after the fixed roots so this is purely additional reach.
  const nodeDir = path.dirname(process.execPath);
  const npmRoots = process.platform === 'win32'
    ? [path.join(process.env.APPDATA ?? '', 'npm', 'node_modules'), path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules'), path.join(nodeDir, 'node_modules')]
    : ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', path.join(home, '.npm-global', 'lib', 'node_modules'), path.resolve(nodeDir, '..', 'lib', 'node_modules')];
  // A system node install makes the derived root identical to a fixed one — probe it once.
  for (const root of new Set(npmRoots)) {
    if (!root) continue;
    const cliJs = path.join(root, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cliJs)) out.push({ command: process.execPath, prefixArgs: [cliJs], source: 'npm-script' });
  }

  // Whatever is on PATH. Works everywhere except a bare Windows .cmd, which is why it is last.
  out.push({ command: 'claude', prefixArgs: [], source: 'path' });
  return out;
}

/**
 * Resolve the CLI Flightdeck drives. An explicit `cliPath` (config) or
 * `FLIGHTDECK_CLI` (env) always wins and is never second-guessed — that is the
 * escape hatch for non-standard installs. A `.js` value is run under this node binary.
 */
export async function resolveCli(configured?: string): Promise<CliResolution> {
  const explicit = (configured ?? process.env.FLIGHTDECK_CLI ?? '').trim();
  const list = explicit
    ? [
        explicit.endsWith('.js')
          ? { command: process.execPath, prefixArgs: [explicit], source: (configured ? 'config' : 'env') as CliResolution['source'] }
          : { command: explicit, prefixArgs: [] as string[], source: (configured ? 'config' : 'env') as CliResolution['source'] },
      ]
    : candidates();

  let lastError = 'no candidate answered --version';
  for (const c of list) {
    const r = await run(c.command, [...c.prefixArgs, '--version']);
    if (r.ok) {
      return { ...c, found: true, version: r.stdout.trim().split('\n')[0] || null, error: null };
    }
    lastError = r.error || lastError;
  }
  // Report the *intended* command so the error message names something the user can act on.
  const fallback = list[list.length - 1];
  return { ...fallback, found: false, version: null, error: lastError };
}

/**
 * Auth cannot be proven without spending a real turn: the CLI keeps its login in the OS
 * keychain / a credentials file whose shape is not a public contract. So we report only
 * what the environment actually tells us — an explicit API key, or "the CLI's own login,
 * which the first turn will confirm" — rather than guessing and being confidently wrong.
 */
function checkAuth(): PreflightReport['auth'] {
  const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (key) {
    return { mode: 'api-key', ok: true, detail: 'ANTHROPIC_API_KEY is set — turns bill to that key, not a subscription.' };
  }
  return {
    mode: 'cli-login',
    ok: true,
    detail: 'Using the Claude CLI login (your subscription). Run `claude` once to sign in if you have not.',
  };
}

export async function preflight(cliPath?: string): Promise<PreflightReport> {
  const major = Number(process.versions.node.split('.')[0]);
  const node = { version: process.versions.node, major, ok: major >= MIN_NODE_MAJOR };
  const cli = await resolveCli(cliPath);
  return { ok: node.ok && cli.found, node, cli, auth: checkAuth(), platform: process.platform };
}

/** Console banner. Only speaks up about things the user must act on. */
export function formatPreflight(r: PreflightReport): string {
  const lines: string[] = [];
  if (!r.node.ok) {
    lines.push(
      `✗ Node ${r.node.version} is too old — Flightdeck needs Node ${MIN_NODE_MAJOR}+.`,
      `  Install the current LTS from https://nodejs.org and run \`npm install\` again.`,
    );
  }
  if (!r.cli.found) {
    lines.push(
      `✗ Claude CLI not found — agents cannot run until it is installed and signed in.`,
      `  1. Install:  npm install -g @anthropic-ai/claude-code`,
      `  2. Sign in:  claude          (once, interactively — uses your Claude subscription)`,
      `  3. Press "Check again" on the dashboard's setup screen — no restart needed.`,
      `  Already installed somewhere unusual? Set "cliPath" in flightdeck.config.json to its full path and restart.`,
      `  (probe error: ${(r.cli.error ?? '').slice(0, 200)})`,
    );
  } else {
    lines.push(`✓ Claude CLI ${r.cli.version ?? ''} (${r.cli.source})`.trimEnd());
    if (r.auth.mode === 'api-key') lines.push(`  ${r.auth.detail}`);
  }
  return lines.join('\n');
}
