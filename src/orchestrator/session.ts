/**
 * Runs one turn of a headless claude session for an agent and streams telemetry into the store.
 * Turn model: each turn is one `claude -p` invocation; the first turn mints a session id,
 * later turns pass --resume so the CLI reloads the full conversation. Between turns the
 * supervisor decides what (if anything) to inject next.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../db.js';
import type { CliResolution } from '../preflight.js';
import type { AgentRow, WorkspaceConfig } from '../types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The bus MCP server is TypeScript, so it runs under tsx. Resolve tsx's own JS entry through
 * its package exports rather than pointing at `node_modules/.bin/tsx`: on POSIX that path is
 * a symlink to this same file, but npm cannot symlink on Windows and writes a `#!/bin/sh`
 * cmd-shim there instead — which `node` then parses as JavaScript and rejects with a
 * SyntaxError, silently costing every agent its bus tools. Not `node --import tsx`, which
 * needs 20.6+ while package.json still admits Node 20.
 */
const TSX_CLI = (() => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch {
    return path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
})();

/** In-flight turns, so a graceful shutdown can kill children and release their agents. */
const activeTurns = new Map<string, { child: import('node:child_process').ChildProcess; agentId: string }>();

export function shutdownActiveTurns(store: Store) {
  for (const [, { child, agentId }] of activeTurns) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    store.updateAgent(agentId, { status: 'idle' });
  }
  activeTurns.clear();
}

export interface TurnResult {
  ok: boolean;
  resultText: string;
  sessionId: string;
  /**
   * Size of the conversation after this turn — the context window occupancy of the LAST
   * request only. This is what the succession threshold must be compared against.
   */
  contextTokens: number;
  /**
   * Total input tokens billed for this turn, summed over every request in the agentic loop
   * (a 20-step turn re-reads its context 20 times). Always >= contextTokens, and for a long
   * turn it is a large multiple of it — so it is a consumption figure, never a context one.
   */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface TurnDeps {
  store: Store;
  dbPath: string;
  /** Called for every event row inserted, so the server can broadcast over WS. */
  onEvent: (workspaceId: string) => void;
  /**
   * How to spawn the Claude CLI, resolved once at boot by preflight. Omit only in tests —
   * the bare `claude` fallback assumes a PATH entry Node can exec directly, which is not
   * true of the npm-global `claude.cmd` on Windows.
   */
  cli?: CliResolution;
  /** Hard cap on a single turn's wall time. */
  turnTimeoutMs?: number;
}

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task',
  'DesignSync', 'Skill',
  'mcp__flightdeck-bus__bus_post_message',
  'mcp__flightdeck-bus__bus_read_messages',
  'mcp__flightdeck-bus__bus_create_task',
  'mcp__flightdeck-bus__bus_update_task',
  'mcp__flightdeck-bus__bus_list_tasks',
];

export function mcpConfigFor(agent: AgentRow, dbPath: string): string {
  return JSON.stringify({
    mcpServers: {
      'flightdeck-bus': {
        command: process.execPath,
        args: [TSX_CLI, path.join(ROOT, 'src', 'bus', 'server.ts')],
        env: {
          MC_DB: dbPath,
          MC_WORKSPACE: agent.workspace_id,
          MC_AGENT_ID: agent.id,
          MC_AGENT_NAME: agent.name,
          MC_AGENT_ROLE: agent.role,
        },
      },
    },
  });
}

export async function runTurn(
  deps: TurnDeps,
  workspace: WorkspaceConfig,
  agent: AgentRow,
  systemPrompt: string,
  prompt: string,
): Promise<TurnResult> {
  const { store, dbPath, onEvent } = deps;
  const cli = deps.cli ?? { command: 'claude', prefixArgs: [] as string[] };
  const started = Date.now();
  const isFirstTurn = !agent.session_id;
  const sessionId = agent.session_id ?? randomUUID();

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', agent.model,
    '--append-system-prompt', systemPrompt,
    '--mcp-config', mcpConfigFor(agent, dbPath),
    '--strict-mcp-config',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...[...(workspace.allowedTools ?? DEFAULT_ALLOWED_TOOLS), ...(workspace.extraAllowedTools ?? [])],
  ];
  if (isFirstTurn) args.push('--session-id', sessionId);
  else args.push('--resume', sessionId);

  // Persist session_id up front: if this turn dies (crash, restart), the next turn
  // can still --resume the conversation instead of starting a blank session.
  store.updateAgent(agent.id, { status: 'working', session_id: sessionId });
  const startEvent = store.addEvent(agent.workspace_id, agent.id, agent.name, 'turn_start', {
    prompt_preview: prompt.slice(0, 200),
  });
  void startEvent;
  onEvent(agent.workspace_id);

  return await new Promise<TurnResult>((resolve) => {
    const child = spawn(cli.command, [...cli.prefixArgs, ...args], {
      cwd: workspace.path,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'flightdeck' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeTurns.set(agent.id, { child, agentId: agent.id });

    let resultText = '';
    let contextTokens = agent.context_tokens;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let stderrTail = '';
    let settled = false;

    const timeout = setTimeout(() => {
      stderrTail += ' [turn timeout — killed]';
      child.kill('SIGKILL');
    }, deps.turnTimeoutMs ?? 30 * 60 * 1000);

    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeTurns.delete(agent.id);
      const durationMs = Date.now() - started;
      // A turn that dies before any `result` line still consumed at least its last context.
      const billed = inputTokens || contextTokens;
      store.addTurn(agent.id, prompt, resultText || (error ?? ''), billed, outputTokens, costUsd, durationMs);
      store.updateAgent(agent.id, {
        status: 'idle',
        session_id: sessionId,
        context_tokens: contextTokens,
        total_output_tokens: agent.total_output_tokens + outputTokens,
        total_input_tokens: agent.total_input_tokens + billed,
        turns: agent.turns + 1,
      });
      store.addEvent(agent.workspace_id, agent.id, agent.name, ok ? 'turn_end' : 'error', {
        input_tokens: billed,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        duration_ms: durationMs,
        summary: (resultText || error || '').slice(0, 300),
        ...(error ? { message: error } : {}),
      });
      onEvent(agent.workspace_id);
      resolve({ ok, resultText, sessionId, contextTokens, inputTokens: billed, outputTokens, costUsd, durationMs, error });
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      try {
        handleStreamMessage(msg);
      } catch {
        // Telemetry parse issues must never kill a turn.
      }
    });

    const handleStreamMessage = (msg: any) => {
      if (msg.type === 'assistant' && msg.message) {
        const usage = msg.message.usage;
        if (usage) {
          contextTokens =
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          outputTokens += usage.output_tokens ?? 0;
        }
        for (const block of msg.message.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            store.addEvent(agent.workspace_id, agent.id, agent.name, 'agent_text', { text: block.text.slice(0, 500) });
          } else if (block.type === 'tool_use') {
            store.addEvent(agent.workspace_id, agent.id, agent.name, 'tool_use', {
              tool: block.name,
              detail: summarizeToolInput(block.name, block.input),
            });
          }
        }
        onEvent(agent.workspace_id);
      } else if (msg.type === 'result') {
        resultText = msg.result ?? '';
        costUsd = msg.total_cost_usd ?? 0;
        // `result.usage` is the SUM over every request in the turn, not the final context.
        // Verified against the CLI: a 2-request turn whose contexts were 27,217 and 28,264
        // reports 55,481 here. Assigning it to contextTokens (as this once did) made a turn
        // with a dozen tool calls read as millions of tokens of "context", tripping the
        // succession threshold after essentially every productive turn — agents retired at
        // ~14-50% of their real window and paid for a handoff brief each time. Context comes
        // from the last assistant message above; this figure is consumption only.
        if (msg.usage) {
          inputTokens =
            (msg.usage.input_tokens ?? 0) +
            (msg.usage.cache_read_input_tokens ?? 0) +
            (msg.usage.cache_creation_input_tokens ?? 0);
        }
      }
    };

    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    // ENOENT here means the CLI is missing or unspawnable — say so in words the dashboard
    // can show, instead of leaking a bare errno the user cannot act on.
    child.on('error', (err) =>
      finish(
        false,
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Claude CLI not found (tried "${cli.command}"). Install it with \`npm install -g @anthropic-ai/claude-code\`, run \`claude\` once to sign in, then restart Flightdeck. If it is installed elsewhere, set "cliPath" in flightdeck.config.json.`
          : `spawn failed: ${err.message}`,
      ),
    );
    child.on('close', (code) => {
      if (code === 0) finish(true);
      else finish(false, `claude exited ${code}: ${stderrTail.slice(-500)}`);
    });
  });
}

function summarizeToolInput(tool: string, input: any): string {
  if (!input) return '';
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.command === 'string') return input.command.slice(0, 120);
  if (typeof input.body === 'string') return input.body.slice(0, 120);
  if (typeof input.title === 'string') return input.title.slice(0, 120);
  if (typeof input.pattern === 'string') return input.pattern.slice(0, 120);
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}
