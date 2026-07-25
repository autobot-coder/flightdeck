/**
 * Flightdeck bus — a stdio MCP server attached to every headless agent session.
 * Identity arrives via env (MC_DB, MC_WORKSPACE, MC_AGENT_ID, MC_AGENT_NAME, MC_AGENT_ROLE),
 * injected by the supervisor when it spawns the session. Writes go straight to the shared
 * SQLite db (WAL), so the supervisor and dashboard see them immediately.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, Store } from '../db.js';
import type { TaskStatus } from '../types.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`bus: missing env ${k}`);
    process.exit(1);
  }
  return v;
};

const store = new Store(openDb(env('MC_DB')));
const workspaceId = env('MC_WORKSPACE');
const agentId = env('MC_AGENT_ID');
const agentName = env('MC_AGENT_NAME');
const agentRole = env('MC_AGENT_ROLE');

const TASK_STATUSES = ['inbox', 'todo', 'in_progress', 'review', 'done', 'blocked'] as const;

const server = new McpServer({ name: 'flightdeck-bus', version: '0.1.0' });

const text = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
});

server.tool(
  'bus_post_message',
  'Post a message to a teammate. Almost always set to_role: handoffs, questions, progress updates, and review requests go to the one role that needs them (progress usually to lead). Omit to_role (= broadcast to every agent AND the owner\'s dashboard) ONLY for team-wide decisions, blockers affecting all roles, or status the owner must see. Never broadcast standby notices or session-handoff briefs — send those to your own role.',
  {
    body: z.string().describe('The message'),
    to_role: z.string().optional().describe('Recipient role (e.g. builder, lead, reviewer). Set for almost all messages; omit only for genuinely team-wide announcements.'),
    task_id: z.string().optional().describe('Related task id, if any'),
  },
  async ({ body, to_role, task_id }) => {
    const msg = store.postMessage(workspaceId, agentName, to_role ?? null, body, task_id ?? null);
    return text({ ok: true, message_id: msg.id });
  },
);

server.tool(
  'bus_read_messages',
  'Read messages addressed to you (or broadcast) that you have not seen yet. Reading advances your cursor.',
  {},
  async () => {
    const agent = store.getAgent(agentId);
    if (!agent) return text({ error: 'agent not found' });
    const msgs = store.unseenMessages(agent);
    if (msgs.length > 0) store.updateAgent(agentId, { last_seen_message_id: msgs[msgs.length - 1].id });
    return text(
      msgs.map((m) => ({ id: m.id, from: m.from_agent, to: m.to_role ?? 'all', body: m.body, task_id: m.task_id })),
    );
  },
);

server.tool(
  'bus_create_task',
  'Create a task on the team board. Assign it to a role; that agent will pick it up automatically.',
  {
    title: z.string(),
    description: z.string().describe('Enough detail that the assignee can start without asking questions'),
    assignee_role: z.string().describe('Role that should do this (e.g. builder, designer, reviewer, grunt)'),
    priority: z.number().int().min(1).max(3).optional().describe('1 high, 2 normal (default), 3 low'),
  },
  async ({ title, description, assignee_role, priority }) => {
    const task = store.createTask(workspaceId, title, description, agentName, assignee_role, 'todo', priority ?? 2);
    store.addEvent(workspaceId, agentId, agentName, 'task_created', { task_id: task.id, title, assignee_role });
    return text({ ok: true, task_id: task.id });
  },
);

server.tool(
  'bus_update_task',
  'Update a task: move status (todo → in_progress → review → done, or blocked), reassign, or add a progress note.',
  {
    task_id: z.string(),
    status: z.enum(TASK_STATUSES).optional(),
    assignee_role: z.string().optional(),
    note: z.string().optional().describe('Progress note, posted to the bus attached to this task'),
  },
  async ({ task_id, status, assignee_role, note }) => {
    const task = store.getTask(task_id);
    if (!task || task.workspace_id !== workspaceId) return text({ error: `no such task ${task_id}` });
    const fields: { status?: TaskStatus; assignee_role?: string } = {};
    if (status) fields.status = status;
    if (assignee_role) fields.assignee_role = assignee_role;
    store.updateTask(task_id, fields);
    if (note) store.postMessage(workspaceId, agentName, null, note, task_id);
    store.addEvent(workspaceId, agentId, agentName, 'task_updated', { task_id, ...fields });
    return text({ ok: true });
  },
);

server.tool(
  'bus_list_tasks',
  'List tasks on the board, optionally filtered by status. Your queue is tasks with your role assigned and status todo/in_progress.',
  { status: z.enum(TASK_STATUSES).optional() },
  async ({ status }) => {
    const tasks = store.listTasks(workspaceId, status);
    return text(
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee_role: t.assignee_role,
        priority: t.priority,
        description: t.description.slice(0, 300),
      })),
    );
  },
);

// Every bus action is also useful telemetry for the dashboard's Activity feed —
// tool_use events for these are emitted by the session parser, so no extra logging here.

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`flightdeck-bus ready for ${agentName} (${agentRole}) in ${workspaceId}`);
