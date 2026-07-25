/**
 * The supervisor is the heartbeat of Flightdeck. Every tick it looks at each running
 * workspace and gives idle agents a turn when they have work: unread bus messages, todo tasks
 * for their role, or a stale in_progress task. Near the context limit it retires the session
 * gracefully: the agent writes a handoff brief onto the bus, and a fresh generation picks it up.
 */
import { contextLimitFor, ownerIdFrom, ownerNameFrom } from '../config.js';
import type { CliResolution } from '../preflight.js';
import type { Store } from '../db.js';
import type { AgentRow, MissionConfig, RoleConfig, WorkspaceConfig } from '../types.js';
import { runTurn, type TurnDeps } from './session.js';
const STALE_TASK_MS = 30 * 60 * 1000;

export class Supervisor {
  /** Set once at boot from preflight, so every turn spawns the CLI the same resolved way. */
  cli: CliResolution | null = null;
  private activeTurns = new Set<string>();
  private lastTurnAt = new Map<string, number>();
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private rotation = 0;

  constructor(
    private store: Store,
    private config: MissionConfig,
    private onEvent: (workspaceId: string) => void,
  ) {}

  /** Ensure workspace + one active agent per configured role exist in the db. */
  bootstrap() {
    for (const ws of this.config.workspaces) this.bootstrapWorkspace(ws);
    this.recoverStaleAgents();
  }

  /**
   * An agent marked 'working' at boot is stale by definition — turns don't survive the
   * supervisor process. Without this, an agent orphaned by a crash or restart is skipped
   * by the scheduler forever. session_id is persisted at turn start, so the recovered
   * agent resumes its conversation on the next turn.
   */
  private recoverStaleAgents() {
    for (const ws of this.config.workspaces) {
      for (const agent of this.store.listAgents(ws.id)) {
        if (agent.status === 'working') {
          this.store.updateAgent(agent.id, { status: 'idle' });
          this.store.addEvent(ws.id, agent.id, agent.name, 'recovered', {
            reason: 'turn was interrupted by a supervisor restart; agent released to resume',
          });
        }
      }
    }
  }

  bootstrapWorkspace(ws: WorkspaceConfig) {
    this.store.upsertWorkspace(ws.id, ws.name, ws.path);
    for (const role of ws.roles) {
      if (!this.store.getActiveAgent(ws.id, role.role)) {
        this.store.createAgent(ws.id, role.role, role.model);
      }
    }
  }

  /** True while any of the workspace's agents is mid-turn. */
  isBusy(workspaceId: string): boolean {
    return this.store.listAgents(workspaceId).some((a) => a.status === 'working');
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.config.tickSeconds * 1000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  postGoal(workspaceId: string, text: string): string {
    const ws = this.workspace(workspaceId);
    // roles[0] is only a fallback for a team with no lead; a team with NO roles at all has
    // nobody to own the goal. The route rejects that with a 409 — this keeps a direct caller
    // from getting an unreadable TypeError out of the indexing.
    const leadRole = ws.roles.find((r) => r.role === 'lead')?.role ?? ws.roles[0]?.role;
    if (!leadRole) throw new Error(`workspace ${workspaceId} has no roles to assign a goal to`);
    const owner = ownerNameFrom(this.config);
    const ownerId = ownerIdFrom(this.config);
    const task = this.store.createTask(
      workspaceId,
      text.length > 80 ? text.slice(0, 77) + '…' : text,
      `GOAL from ${owner}: ${text}\n\nDecompose this into concrete tasks with bus_create_task, assign them to roles, and coordinate until done.`,
      ownerId,
      leadRole,
      'todo',
      1,
    );
    this.store.addEvent(workspaceId, null, ownerId, 'goal_posted', { task_id: task.id, text });
    this.onEvent(workspaceId);
    void this.tick();
    return task.id;
  }

  postUserMessage(workspaceId: string, body: string, toRole: string | null) {
    this.store.postMessage(workspaceId, ownerIdFrom(this.config), toRole, body, null);
    this.onEvent(workspaceId);
    void this.tick();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Gather ready candidates per workspace, then dispatch round-robin across
      // workspaces (with a rotating start) so a busy workspace can't starve the others.
      const queues: { ws: WorkspaceConfig; roleCfg: RoleConfig; agent: AgentRow; work: string }[][] = [];
      for (const ws of this.config.workspaces) {
        if (!this.store.isRunning(ws.id)) continue;
        const q: (typeof queues)[number] = [];
        for (const roleCfg of ws.roles) {
          const agent = this.store.getActiveAgent(ws.id, roleCfg.role);
          if (!agent || agent.status !== 'idle' || this.activeTurns.has(agent.id)) continue;
          const work = this.pendingWork(ws, agent);
          if (work) q.push({ ws, roleCfg, agent, work });
        }
        if (q.length > 0) queues.push(q);
      }
      if (queues.length === 0) return;

      this.rotation = (this.rotation + 1) % queues.length;
      const rotated = [...queues.slice(this.rotation), ...queues.slice(0, this.rotation)];
      let idx = 0;
      let emptyStreak = 0;
      while (this.activeTurns.size < this.config.maxConcurrentTurns && emptyStreak < rotated.length) {
        const q = rotated[idx % rotated.length];
        idx++;
        if (q.length === 0) {
          emptyStreak++;
          continue;
        }
        emptyStreak = 0;
        const c = q.shift()!;
        this.activeTurns.add(c.agent.id);
        void this.runAgentTurn(c.ws, c.roleCfg, c.agent, c.work).finally(() => {
          this.activeTurns.delete(c.agent.id);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private pendingWork(ws: WorkspaceConfig, agent: AgentRow): string | null {
    const last = this.lastTurnAt.get(agent.id) ?? 0;
    if (Date.now() - last < this.config.tickSeconds * 1000) return null; // one turn per tick per agent

    const unseen = this.store.unseenMessages(agent);
    const todo = this.store
      .listTasks(ws.id, 'todo')
      .filter((t) => t.assignee_role === agent.role);
    const inProgress = this.store
      .listTasks(ws.id, 'in_progress')
      .filter((t) => t.assignee_role === agent.role);
    const freshInProgress = inProgress.filter((t) => t.updated_at > last);
    const staleInProgress = inProgress.filter((t) => Date.now() - t.updated_at > STALE_TASK_MS);

    // Tasks in `review` are the reviewer's work regardless of assignee_role, which records
    // who IMPLEMENTED the task — moving it to review is how the protocol hands it over.
    // Nothing dispatched this status before, so the review column was unreachable: a task
    // moved there could only ever be picked up if somebody happened to message the reviewer
    // about it, and 17 had silently accumulated. Surfaced on the same fresh-or-stale terms
    // as in_progress, so a reviewer that clears its queue is not re-woken every tick.
    const reviewQueue =
      agent.role === 'reviewer'
        ? this.store
            .listTasks(ws.id, 'review')
            .filter((t) => t.updated_at > last || Date.now() - t.updated_at > STALE_TASK_MS)
        : [];

    if (
      unseen.length === 0 &&
      todo.length === 0 &&
      reviewQueue.length === 0 &&
      freshInProgress.length === 0 &&
      staleInProgress.length === 0
    ) {
      return null;
    }

    const parts: string[] = [];
    if (unseen.length > 0) {
      parts.push(
        'New messages on the bus:\n' +
          unseen.map((m) => `- [${m.id}] from ${m.from_agent} to ${m.to_role ?? 'all'}${m.task_id ? ` (task ${m.task_id})` : ''}: ${m.body}`).join('\n'),
      );
    }
    if (todo.length > 0) {
      parts.push(
        'Tasks assigned to you (todo):\n' +
          todo.map((t) => `- [${t.id}] (p${t.priority}) ${t.title}\n  ${t.description.slice(0, 500)}`).join('\n'),
      );
    }
    if (reviewQueue.length > 0) {
      // Capped so a large backlog cannot rebuild the giant prompts this change exists to
      // prevent; the count is stated rather than silently truncated, and the rest resurface
      // on later turns as this batch is cleared.
      const shown = reviewQueue.slice(0, 10);
      const more = reviewQueue.length - shown.length;
      parts.push(
        `Tasks waiting for your review (${reviewQueue.length} in the review column${more > 0 ? `, showing ${shown.length}` : ''}):\n` +
          shown.map((t) => `- [${t.id}] (p${t.priority}) ${t.title}\n  ${t.description.slice(0, 400)}`).join('\n') +
          (more > 0 ? `\n…and ${more} more — clear these first, the rest will follow.` : ''),
      );
    }
    if (staleInProgress.length > 0) {
      parts.push(
        'These in_progress tasks of yours have not been updated in a while — continue them or update their status:\n' +
          staleInProgress.map((t) => `- [${t.id}] ${t.title}`).join('\n'),
      );
    }
    if (parts.length === 0 && freshInProgress.length > 0) {
      parts.push(
        'Your in_progress tasks were updated:\n' + freshInProgress.map((t) => `- [${t.id}] ${t.title}`).join('\n'),
      );
    }
    parts.push(
      'Work now. Move tasks you start to in_progress and tasks you finish to review (or done for trivial fixes). ' +
        'Coordinate via bus_post_message; create follow-up tasks with bus_create_task. End your turn when this batch of work is done or genuinely blocked.',
    );
    return parts.join('\n\n');
  }

  private async runAgentTurn(ws: WorkspaceConfig, roleCfg: RoleConfig, agent: AgentRow, prompt: string) {
    this.lastTurnAt.set(agent.id, Date.now());
    const maxMsgIdAtStart = this.maxMessageId(ws.id);
    const deps: TurnDeps = { store: this.store, dbPath: this.config.dbPath, onEvent: this.onEvent, cli: this.cli ?? undefined };
    const result = await runTurn(deps, ws, agent, this.systemPrompt(ws, roleCfg, agent), prompt);

    // Messages included in this prompt are delivered even if the agent never called bus_read_messages.
    const fresh = this.store.getAgent(agent.id);
    if (fresh && fresh.last_seen_message_id < maxMsgIdAtStart) {
      this.store.updateAgent(agent.id, { last_seen_message_id: maxMsgIdAtStart });
    }

    const limit = contextLimitFor(agent.model, ws.contextLimit);
    if (result.ok && result.contextTokens >= limit) {
      await this.succession(ws, roleCfg, this.store.getAgent(agent.id)!);
    }
  }

  /** Retire a near-limit session: it writes a handoff brief to the bus, a new generation inherits it. */
  private async succession(ws: WorkspaceConfig, roleCfg: RoleConfig, agent: AgentRow) {
    const deps: TurnDeps = { store: this.store, dbPath: this.config.dbPath, onEvent: this.onEvent, cli: this.cli ?? undefined };
    const handoffPrompt =
      'Your session is near its context limit and will be retired. Write a complete handoff brief for your successor ' +
      '(same role, fresh session) and post it with bus_post_message to your own role. Include: current state of your tasks ' +
      '(ids + where each stands), key decisions made and why, file paths and gotchas discovered, and exact next steps. ' +
      'Update any of your in_progress tasks with a status note. This is your final turn.';
    // Anchor the successor's cursor on what the predecessor posts from HERE on, not on its
    // whole history. Captured before the turn so the brief can be identified by position.
    const beforeHandoff = this.maxMessageId(ws.id);
    await runTurn(deps, ws, agent, this.systemPrompt(ws, roleCfg, agent), handoffPrompt);

    const successor = this.store.createAgent(ws.id, agent.role, agent.model, agent.generation + 1, agent.id);
    // Successor must see the handoff but not the entire backlog. Take the FIRST message the
    // predecessor posted during the handoff turn: handoffPrompt asks for the brief first and
    // task status notes second, and bus_update_task's note is itself a BROADCAST from the same
    // agent (bus/server.ts:97) with a higher id. So neither end of its full history works —
    // the first message overall rewinds to the start of its working life (3-55 messages, up to
    // 54k chars replayed), and the last message is usually a trailing task note, which puts the
    // brief BELOW the cursor and hands the successor a one-line note instead of its handoff.
    const posted = this.store
      .unseenMessages({ ...successor, last_seen_message_id: beforeHandoff })
      .filter((m) => m.from_agent === agent.name);
    const cursor = posted.length > 0 ? posted[0].id - 1 : this.maxMessageId(ws.id);
    this.store.updateAgent(successor.id, { last_seen_message_id: cursor });
    this.store.updateAgent(agent.id, { status: 'retired' });
    this.store.addEvent(ws.id, successor.id, successor.name, 'succession', {
      from: agent.name,
      to: successor.name,
      reason: `context ${agent.context_tokens} tokens ≥ limit`,
    });
    this.onEvent(ws.id);
  }

  private systemPrompt(ws: WorkspaceConfig, roleCfg: RoleConfig, agent: AgentRow): string {
    const team = ws.roles.map((r) => `- ${r.role}${r.role === agent.role ? ' (you)' : ''}`).join('\n');
    const owner = ownerNameFrom(this.config);
    return [
      `You are "${agent.name}", the ${agent.role} on an autonomous agent team working on the "${ws.name}" project at ${ws.path}. `,
      `${owner} is the human owner, watching a dashboard but not in the loop turn-by-turn — do not wait for them and never ask them questions unless truly blocked (then post a broadcast bus message explaining what you need).`,
      `Your team (each role is a separate agent session — communicate ONLY via the flightdeck-bus tools):\n${team}`,
      `Protocol: keep the task board truthful (bus_update_task as you start/finish), hand off work by creating tasks for other roles, request review from the reviewer by moving tasks to review status and messaging them, report meaningful progress on the bus directed to the role that needs it (usually lead) — broadcast (no to_role) only decisions or blockers that concern every role, since broadcasts land in every agent's context and on the owner's dashboard; session-handoff briefs and standby notices go to your own role, never to everyone. Prefer small, verifiable steps; run tests/builds to check your work.`,
      `Role brief: ${roleCfg.prompt}`,
    ].join('\n\n');
  }

  private maxMessageId(workspaceId: string): number {
    const row = this.store.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE workspace_id = ?`)
      .get(workspaceId) as { m: number };
    return row.m;
  }

  private workspace(id: string): WorkspaceConfig {
    const ws = this.config.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`unknown workspace ${id}`);
    return ws;
  }
}
