import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AgentRow, EventRow, MessageRow, TaskRow, TaskStatus, TurnRow } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  running INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  session_id TEXT,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1,
  predecessor_id TEXT,
  last_seen_message_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  assignee_role TEXT,
  created_by TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_role TEXT,
  body TEXT NOT NULL,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_events_ws ON events(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(agent_id, id);
`;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed (SCHEMA is CREATE IF NOT EXISTS only). */
function migrate(db: Database.Database) {
  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
  if (!agentCols.some((c) => c.name === 'total_input_tokens')) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      // Two processes can race past the PRAGMA guard; losing the ALTER race is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  // Recompute on every open, not once: turns is the source of truth, and a server still
  // running pre-column code keeps inserting turns without accumulating — a one-shot
  // backfill freezes stale. Idempotent; the finish path converges to the same sum.
  db.exec(
    `UPDATE agents SET total_input_tokens = COALESCE((SELECT SUM(t.input_tokens) FROM turns t WHERE t.agent_id = agents.id), 0)`,
  );
}

/**
 * Columns each updater may write.
 *
 * A SQL identifier cannot be parameterised, so the UPDATE ... SET clauses below interpolate key
 * names — which means the key set has to be closed. Both updaters used to interpolate whatever
 * keys the caller passed, and `PATCH /api/tasks/:id` hands over the raw request body, so:
 *   {"id":"t_HIJACKED"}                 rewrote the primary key and orphaned the original row
 *   {"workspace_id":"attacker"}         moved a task into a workspace that does not exist
 *   {"status=(SELECT 1),priority":9}    executed a subquery — column-name SQL injection
 * The `Partial<…>` on each signature is compile-time only and constrains nothing at runtime.
 *
 * Identity and provenance columns are deliberately absent: id, workspace_id, created_at,
 * created_by, role, name, generation and predecessor_id are set at creation and never updated.
 * Adding a column here is a decision to let any caller — including an HTTP body — write it.
 */
const TASK_UPDATABLE: ReadonlySet<string> = new Set([
  'status', 'assignee_role', 'priority', 'title', 'description',
]);
const AGENT_UPDATABLE: ReadonlySet<string> = new Set([
  'status', 'model', 'session_id', 'context_tokens',
  'total_output_tokens', 'total_input_tokens', 'turns', 'last_seen_message_id',
]);

/**
 * Keys that are safe to interpolate. Unknown keys are DROPPED rather than thrown on: an extra
 * key must not be able to turn a write into a 500, and if nothing survives the filter the
 * callers' `length === 0` guard leaves the row untouched.
 */
function updatableKeys(fields: object, allowed: ReadonlySet<string>): string[] {
  return Object.keys(fields).filter((k) => allowed.has(k));
}

/** Shared query helpers used by both the supervisor process and the MCP bus process. */
export class Store {
  constructor(public db: Database.Database) {}

  upsertWorkspace(id: string, name: string, path: string) {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path`,
      )
      .run(id, name, path);
  }

  setRunning(workspaceId: string, running: boolean) {
    this.db.prepare(`UPDATE workspaces SET running = ? WHERE id = ?`).run(running ? 1 : 0, workspaceId);
  }

  isRunning(workspaceId: string): boolean {
    const row = this.db.prepare(`SELECT running FROM workspaces WHERE id = ?`).get(workspaceId) as
      | { running: number }
      | undefined;
    return !!row?.running;
  }

  getActiveAgent(workspaceId: string, role: string): AgentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM agents WHERE workspace_id = ? AND role = ? AND status != 'retired' ORDER BY generation DESC LIMIT 1`)
      .get(workspaceId, role) as AgentRow | undefined;
  }

  createAgent(workspaceId: string, role: string, model: string, generation = 1, predecessorId: string | null = null): AgentRow {
    const id = `ag_${randomUUID().slice(0, 8)}`;
    const name = `${role}-${generation}`;
    this.db
      .prepare(
        `INSERT INTO agents (id, workspace_id, role, name, model, generation, predecessor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, role, name, model, generation, predecessorId, Date.now());
    return this.getAgent(id)!;
  }

  getAgent(id: string): AgentRow | undefined {
    return this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
  }

  listAgents(workspaceId: string): AgentRow[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at`)
      .all(workspaceId) as AgentRow[];
  }

  updateAgent(id: string, fields: Partial<AgentRow>) {
    const keys = updatableKeys(fields, AGENT_UPDATABLE);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE agents SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => fields[k as keyof AgentRow]), id);
  }

  createTask(
    workspaceId: string,
    title: string,
    description: string,
    createdBy: string,
    assigneeRole: string | null,
    status: TaskStatus = 'todo',
    priority = 2,
  ): TaskRow {
    const id = `t_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, assignee_role, created_by, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, title, description, status, assigneeRole, createdBy, priority, now, now);
    return this.getTask(id)!;
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  }

  updateTask(id: string, fields: Partial<Pick<TaskRow, 'status' | 'assignee_role' | 'priority' | 'title' | 'description'>>) {
    const keys = updatableKeys(fields, TASK_UPDATABLE);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k as keyof typeof fields]), Date.now(), id);
  }

  listTasks(workspaceId: string, status?: TaskStatus): TaskRow[] {
    if (status) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY priority, created_at`)
        .all(workspaceId, status) as TaskRow[];
    }
    return this.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ? ORDER BY priority, created_at`)
      .all(workspaceId) as TaskRow[];
  }

  postMessage(workspaceId: string, fromAgent: string, toRole: string | null, body: string, taskId: string | null): MessageRow {
    const info = this.db
      .prepare(
        `INSERT INTO messages (workspace_id, from_agent, to_role, body, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, fromAgent, toRole, body, taskId, Date.now());
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(info.lastInsertRowid) as MessageRow;
  }

  /** Messages this agent hasn't seen yet: broadcasts, its role's mail, minus its own posts. */
  unseenMessages(agent: AgentRow): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND id > ? AND from_agent != ?
           AND (to_role IS NULL OR to_role = ?)
         ORDER BY id`,
      )
      .all(agent.workspace_id, agent.last_seen_message_id, agent.name, agent.role) as MessageRow[];
  }

  recentMessages(workspaceId: string, limit = 200): MessageRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`)
        .all(workspaceId, limit) as MessageRow[]
    ).reverse();
  }

  addEvent(workspaceId: string, agentId: string | null, agentName: string | null, type: string, payload: unknown): EventRow {
    const info = this.db
      .prepare(`INSERT INTO events (workspace_id, agent_id, agent_name, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, agentId, agentName, type, JSON.stringify(payload ?? {}), Date.now());
    return this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(info.lastInsertRowid) as EventRow;
  }

  recentEvents(workspaceId: string, limit = 200): EventRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`)
        .all(workspaceId, limit) as EventRow[]
    ).reverse();
  }

  addTurn(agentId: string, prompt: string, result: string, inputTokens: number, outputTokens: number, costUsd: number, durationMs: number) {
    this.db
      .prepare(
        `INSERT INTO turns (agent_id, prompt, result, input_tokens, output_tokens, cost_usd, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, prompt, result, inputTokens, outputTokens, costUsd, durationMs, Date.now());
  }

  listTurns(agentId: string, limit = 50): TurnRow[] {
    return (
      this.db.prepare(`SELECT * FROM turns WHERE agent_id = ? ORDER BY id DESC LIMIT ?`).all(agentId, limit) as TurnRow[]
    ).reverse();
  }

  /** Remove a workspace and all its history. */
  purgeWorkspace(workspaceId: string) {
    const purge = this.db.transaction((id: string) => {
      this.db.prepare(`DELETE FROM turns WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)`).run(id);
      for (const table of ['agents', 'tasks', 'messages', 'events'] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(id);
      }
      this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    });
    purge(workspaceId);
  }

  taskCounts(workspaceId: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM tasks WHERE workspace_id = ? GROUP BY status`)
      .all(workspaceId) as { status: string; n: number }[];
    const counts: Record<string, number> = { inbox: 0, todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0 };
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }
}
