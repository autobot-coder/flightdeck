/**
 * The supervisor is the heartbeat of Flightdeck. Every tick it looks at each running
 * workspace and gives idle agents a turn.
 *
 * THE BOARD IS THE ONLY WAKE SIGNAL. An agent runs because of task state — a todo assigned to
 * it, its own unfinished in_progress work, the reviewer's `review` column, or the lead's
 * `inbox`/newly-`blocked` queues. Bus messages NEVER wake anyone: they are delivered to
 * whichever turn real work justifies. Waking on unread mail made talking self-sustaining,
 * since every turn also produces mail, and an idle board still burned turns indefinitely.
 * See pendingWork() for the queue definitions, which are the authoritative statement of this.
 *
 * Near the context limit it retires the session gracefully: the agent writes a handoff brief
 * onto the bus, and a fresh generation picks it up.
 */
import { contextLimitFor, ownerIdFrom, ownerNameFrom } from '../config.js';
import type { CliResolution } from '../preflight.js';
import type { Store } from '../db.js';
import type { AgentRow, MissionConfig, RoleConfig, TaskRow, TaskStatus, WorkspaceConfig } from '../types.js';
import { runTurn, type TurnDeps } from './session.js';
const STALE_TASK_MS = 30 * 60 * 1000;
/** Cap on unread bus messages injected into one prompt — see the note at the call site. */
const MAX_UNSEEN_IN_PROMPT = 15;
/** Cap on review-queue tasks listed in one prompt — same purpose, same budget. */
const MAX_REVIEW_IN_PROMPT = 10;

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

    // Two wake predicates, named once. `isFresh` = changed since this agent last ran;
    // `isStale` = untouched long enough that somebody should look again. Which of the two a
    // queue uses IS the policy, so every queue below states its choice explicitly rather than
    // encoding it in whichever characters happened to be typed.
    const isFresh = (t: TaskRow) => t.updated_at > last;
    const isStale = (t: TaskRow) => Date.now() - t.updated_at > STALE_TASK_MS;

    /** A status queue that can wake `role`. `null` role means "whoever the task is assigned to". */
    const queue = (role: string | null, status: TaskStatus, wakesOn: (t: TaskRow) => boolean) => {
      // Role check before the query: a non-matching role must not pay for the DB round-trip.
      if (role !== null && agent.role !== role) return [];
      return this.store
        .listTasks(ws.id, status)
        .filter((t) => (role === null ? t.assignee_role === agent.role : true) && wakesOn(t));
    };

    const inProgress = this.store.listTasks(ws.id, 'in_progress').filter((t) => t.assignee_role === agent.role);
    const freshInProgress = inProgress.filter(isFresh);
    const staleInProgress = inProgress.filter(isStale);

    // Declared as one list so the wake gate and the prompt render from the SAME source. When
    // they were mirrored by hand, a queue could be built and rendered but never wake anyone —
    // which is exactly how 17 review tasks silently accumulated.
    const queues = {
      // Your own assigned work. Any todo wakes you; it has not been started yet.
      todo: queue(null, 'todo', () => true),
      // `review` is the reviewer's work regardless of assignee_role, which records who
      // IMPLEMENTED it — moving a task to review is how the protocol hands it over. Nothing
      // dispatched this status before, so the column was unreachable.
      review: queue('reviewer', 'review', (t) => isFresh(t) || isStale(t)),
      // The lead's job is not only decomposing goals — it triages untriaged work and unblocks
      // people, and neither arrives as a task assigned to it. Without these two the lead would
      // wake for its own todos and nothing else, and the role would be pointless.
      inbox: queue('lead', 'inbox', (t) => isFresh(t) || isStale(t)),
      // FRESH ONLY, deliberately — note the missing isStale. A blocked task wakes the lead once,
      // when it becomes blocked. If the lead cannot clear it the decision is the owner's, and
      // re-firing on the stale timer would have the lead relitigate it every 30 minutes forever.
      blocked: queue('lead', 'blocked', isFresh),
      freshInProgress,
      staleInProgress,
    };

    // Messages are context, never a trigger. Agents narrate progress on every turn, so waking
    // on unread mail made talking self-sustaining: a broadcast woke two peers, whose replies
    // woke each other, and an empty board still burned 120 turns in simulation and never
    // settled. Unread mail is still DELIVERED below — it rides along with the next turn that
    // real work justifies. To ask something of another role, create a task for them: that
    // wakes them, and it is visible to the owner on the board.
    if (Object.values(queues).every((q) => q.length === 0)) return null;

    // Read AFTER the gate: mail no longer decides whether we run, and unseenMessages is a
    // SELECT * over full bodies. Fetching it first meant every idle tick — now the common
    // case — loaded and discarded the whole backlog.
    const unseen = this.store.unseenMessages(agent);
    const { todo, review: reviewQueue, inbox: inboxQueue, blocked: blockedQueue } = queues;

    const parts: string[] = [];
    if (unseen.length > 0) {
      // Capped: mail no longer wakes anyone, so a quiet spell can leave a long backlog for
      // whichever turn comes next. Take the most recent — older narration is the least useful
      // and the cursor advances past all of it regardless — and say what was dropped rather
      // than silently truncating.
      const shown = unseen.slice(-MAX_UNSEEN_IN_PROMPT);
      const dropped = unseen.length - shown.length;
      parts.push(
        `New messages on the bus${dropped > 0 ? ` (${unseen.length} unread, showing the ${shown.length} most recent)` : ''}:\n` +
          shown.map((m) => `- [${m.id}] from ${m.from_agent} to ${m.to_role ?? 'all'}${m.task_id ? ` (task ${m.task_id})` : ''}: ${m.body}`).join('\n') +
          (dropped > 0 ? `\n(${dropped} older message(s) not shown — ask on the bus if you need them.)` : ''),
      );
    }
    if (inboxQueue.length > 0) {
      parts.push(
        'Untriaged tasks (inbox) — decompose or assign them:\n' +
          inboxQueue.map((t) => `- [${t.id}] (p${t.priority}) ${t.title}\n  ${t.description.slice(0, 400)}`).join('\n'),
      );
    }
    if (blockedQueue.length > 0) {
      parts.push(
        'These tasks just became BLOCKED. Unblock what you can by deciding it or creating a task ' +
          'for the role that can resolve it. If it genuinely needs the owner, LEAVE it blocked and ' +
          'make sure its description states plainly what decision you need from them:\n' +
          blockedQueue.map((t) => `- [${t.id}] ${t.title}`).join('\n'),
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
      const shown = reviewQueue.slice(0, MAX_REVIEW_IN_PROMPT);
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
    // The successor inherits everything posted from the moment the handoff turn began, and
    // nothing older. Three other anchors were tried here and all lose messages:
    //
    //  - the predecessor's FIRST message ever — rewinds to the start of its working life,
    //    replaying 3-55 messages (up to 54k chars) into every new generation.
    //  - its LAST message — bus_update_task posts its note as a BROADCAST from the same agent
    //    (bus/server.ts:97) with a HIGHER id than the brief, and handoffPrompt asks for
    //    brief-then-notes. So this lands ABOVE the brief and drops it: measured 9/9 real
    //    successions. Masked because a trailing note usually repeats some state.
    //  - its first message DURING the handoff turn — delivers the brief, but silently drops
    //    anything ANOTHER agent posted between the turn starting and that first post. That
    //    window is a whole turn wide, and those messages are lost to the role entirely: the
    //    predecessor never saw them (they postdate its prompt) and the successor skips them.
    //
    // `beforeHandoff` has none of those failure modes, and needs no ability to recognise the
    // brief by content nor any reliance on prompt ordering holding.
    this.store.updateAgent(successor.id, { last_seen_message_id: beforeHandoff });
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
      `Protocol — THE BOARD IS THE ONLY WORK QUEUE. You are given a turn because of the board: a task ` +
        `assigned to you, something in your queue, or work you left unfinished. Messages NEVER cause anyone ` +
        `to run. They are delivered to whoever is next given a turn for a real reason, so treat the bus as a ` +
        `place to leave context, not a way to get someone's attention.\n` +
        `- Keep the board truthful: bus_update_task as you start and finish.\n` +
        `- TO ASK SOMETHING OF ANOTHER ROLE, CREATE A TASK FOR THEM (bus_create_task with their role). ` +
        `A message asking them to do something will not reach them in time to matter and may never be acted on.\n` +
        `- Request review by moving the task to review status; the reviewer's queue picks it up. No message needed.\n` +
        `- If you are stuck, set the task to blocked and put the WHOLE question in its description: what you tried, ` +
        `what the options are, and exactly what decision you need. The owner reads blocked tasks on the dashboard, ` +
        `and the lead is shown it once. A blocker announced only on the bus will be seen by nobody.\n` +
        `- Say less. Every message you write is read by someone later at a cost, and narrating progress that the ` +
        `board already shows is pure waste. Report to the lead when there is something a human would want to know; ` +
        `broadcast (no to_role) almost never — it is charged to every role.\n` +
        `Prefer small, verifiable steps; run tests/builds to check your work.`,
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
