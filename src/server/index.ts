import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Store } from '../db.js';
import type { ConfigStore } from '../config.js';
import { contextLimitFor, defaultRole, modelCatalogFrom, ownerNameFrom, resolveModel, KNOWN_ROLES } from '../config.js';
import type { Supervisor } from '../orchestrator/supervisor.js';
import { preflight, MIN_NODE_MAJOR, type PreflightReport } from '../preflight.js';
import type { AgentRow, EventRow, MissionConfig, TaskStatus, WorkspaceConfig } from '../types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startServer(
  store: Store,
  supervisor: Supervisor,
  configStore: ConfigStore,
  preflightReport?: PreflightReport,
) {
  const config = configStore.config;
  // The model allow-list is config-owned, not a hardcoded const: whatever `models` lists is
  // what the three validation sites accept and what the dropdowns offer. Read once at boot,
  // like `port` — editing the catalog takes effect on restart.
  const modelCatalog = modelCatalogFrom(config.models);
  const modelIds = modelCatalog.map((m) => m.id);
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: path.join(ROOT, 'dashboard') });

  const sockets = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const broadcast = (frame: unknown) => {
    const data = JSON.stringify(frame);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  // The supervisor/session layer calls this after inserting events; we push the latest
  // rows for that workspace. Sending a coarse refresh frame keeps the client trivial.
  const lastSentEventId = new Map<string, number>();
  const onEvent = (workspaceId: string) => {
    const since = lastSentEventId.get(workspaceId) ?? 0;
    const events = store.recentEvents(workspaceId, 50).filter((e) => e.id > since);
    if (events.length > 0) lastSentEventId.set(workspaceId, events[events.length - 1].id);
    for (const e of events) broadcast({ type: 'event', workspace_id: workspaceId, event: eventJson(e) });
    for (const agent of store.listAgents(workspaceId)) {
      broadcast({ type: 'agent', workspace_id: workspaceId, agent: agentJson(agent, contextLimit(config, workspaceId)) });
    }
    const msgs = store.recentMessages(workspaceId, 20);
    for (const m of msgs) broadcast({ type: 'message', workspace_id: workspaceId, message: m });
    for (const t of store.listTasks(workspaceId)) broadcast({ type: 'task', workspace_id: workspaceId, task: t });
  };

  /**
   * Everything the first-run setup screen needs to tell the user what to do next: whether
   * the CLI is usable, and whether any project has been added yet. Additive — existing
   * clients that only read `workspaces`/`known_models` are unaffected.
   */
  let report = preflightReport;
  const setupJson = () => ({
    owner_name: ownerNameFrom(config),
    has_workspaces: config.workspaces.length > 0,
    cli: {
      ready: report?.cli.found ?? true,
      version: report?.cli.version ?? null,
      source: report?.cli.source ?? null,
      error: report?.cli.error ?? null,
    },
    // `min_major` travels with the verdict so the setup screen can name the required
    // version without hardcoding a copy of MIN_NODE_MAJOR that could drift from it.
    node: report ? { version: report.node.version, ok: report.node.ok, min_major: MIN_NODE_MAJOR } : null,
    auth: report ? { mode: report.auth.mode, detail: report.auth.detail } : null,
    platform: report?.platform ?? process.platform,
  });

  app.get('/api/state', async () => ({
    workspaces: config.workspaces.map((ws) => workspaceJson(store, config, ws.id)),
    known_models: modelCatalog,
    setup: setupJson(),
  }));

  /**
   * `?recheck=1` re-probes the CLI and re-points the supervisor at the result. That matters:
   * installing the CLI would otherwise need a server restart, and restarting kills every
   * running agent. With this, the setup screen's "Check again" button is enough.
   */
  app.get('/api/health', async (req) => {
    if (((req.query ?? {}) as { recheck?: string }).recheck) {
      report = await preflight(config.cliPath);
      supervisor.cli = report.cli;
    }
    return { ok: (report?.ok ?? true) && config.workspaces.length > 0, setup: setupJson() };
  });

  app.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    return {
      workspace: workspaceJson(store, config, id),
      tasks: store.listTasks(id),
      messages: store.recentMessages(id),
      events: store.recentEvents(id).map(eventJson),
    };
  });

  // Native macOS Finder folder chooser — possible because the server runs on the user's own machine.
  let pickerOpen = false;
  app.post('/api/pick-folder', async (_req, reply) => {
    if (process.platform !== 'darwin') return reply.code(501).send({ error: 'native picker only on macOS' });
    if (pickerOpen) return reply.code(409).send({ error: 'a Finder dialog is already open' });
    pickerOpen = true;
    try {
      return await new Promise((resolve) => {
        execFile(
          'osascript',
          ['-e', 'tell application "System Events" to activate', '-e', 'POSIX path of (choose folder with prompt "Select a project folder for Flightdeck")'],
          { timeout: 300_000 },
          (err, stdout, stderr) => {
            if (err) {
              const msg = `${stderr ?? ''} ${err.message}`;
              const cancelled = /-128|cancel/i.test(msg);
              resolve(reply.code(cancelled ? 410 : 500).send({ error: cancelled ? 'cancelled' : msg.trim() }));
            } else {
              resolve({ path: stdout.trim().replace(/\/+$/, '') });
            }
          },
        );
      });
    } finally {
      pickerOpen = false;
    }
  });

  app.get('/api/browse', async (req, reply) => {
    let p = ((req.query ?? {}) as { path?: string }).path?.trim() || os.homedir();
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { path: p, parent: path.dirname(p) === p ? null : path.dirname(p), dirs };
    } catch (err) {
      return reply.code(400).send({ error: `cannot read ${p}: ${(err as Error).message}` });
    }
  });

  app.post('/api/workspaces', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      path?: string;
      roles?: (string | { role: string; model?: string })[];
      model?: string;
    };
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) return reply.code(400).send({ error: 'name must contain letters or numbers' });
    if (config.workspaces.some((w) => w.id === id)) return reply.code(409).send({ error: `workspace "${id}" already exists` });

    let dir = body.path?.trim();
    if (!dir) return reply.code(400).send({ error: 'path required' });
    if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return reply.code(400).send({ error: `path is not a directory: ${dir}` });
    }

    const fallbackModel = resolveModel(modelCatalog, body.model?.trim() || 'sonnet');
    const requested = (body.roles?.length ? body.roles : ['lead', 'builder', 'reviewer']).map((r) =>
      typeof r === 'string' ? { role: r, model: undefined as string | undefined } : { role: r.role, model: r.model },
    );
    const seen = new Set<string>();
    const roleSpecs: { role: string; model?: string }[] = [];
    for (const r of requested) {
      const role = r.role?.toLowerCase().trim();
      if (!role || seen.has(role)) continue;
      seen.add(role);
      roleSpecs.push({ role, model: r.model?.trim() || undefined });
    }
    // An OMITTED or empty `roles` means "use the defaults" — handled above. A non-empty array
    // that survives the loop with nothing usable ([{}], [""]) is a malformed request, not a
    // request for the defaults: creating the workspace anyway leaves it with no agents, no way
    // to run a goal, and a role-less `roles: []` saved into the operator's config file.
    if (roleSpecs.length === 0) return reply.code(400).send({ error: 'at least one role required' });
    const unknown = roleSpecs.filter((r) => !(KNOWN_ROLES as readonly string[]).includes(r.role));
    if (unknown.length > 0) return reply.code(400).send({ error: `unknown roles: ${unknown.map((r) => r.role).join(', ')}` });
    const badModel = roleSpecs.find((r) => r.model && !modelIds.includes(r.model));
    if (badModel) return reply.code(400).send({ error: `unknown model "${badModel.model}" for role ${badModel.role}` });

    const ws: WorkspaceConfig = {
      id,
      name,
      path: dir,
      roles: roleSpecs.map((r) => {
        const base = defaultRole(r.role, fallbackModel);
        // grunt's haiku default may not be in a custom catalog — resolve rather than error.
        return { ...base, model: r.model || resolveModel(modelCatalog, base.model) };
      }),
    };
    configStore.addWorkspace(ws);
    supervisor.bootstrapWorkspace(ws);
    return workspaceJson(store, config, id);
  });

  app.get('/api/workspaces/:id/settings', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    return {
      id: ws.id,
      name: ws.name,
      path: ws.path,
      contextLimit: ws.contextLimit ?? null,
      extraAllowedTools: ws.extraAllowedTools ?? [],
      roles: ws.roles.map((r) => ({ role: r.role, model: r.model, prompt: r.prompt })),
      known_roles: KNOWN_ROLES,
      known_models: modelCatalog,
    };
  });

  app.patch('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    const body = (req.body ?? {}) as {
      name?: string;
      path?: string;
      contextLimit?: number | null;
      extraAllowedTools?: string[] | null;
      roles?: { role: string; model?: string; prompt?: string }[];
    };

    if (body.path !== undefined) {
      let dir = body.path.trim();
      if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
      dir = path.resolve(dir);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return reply.code(400).send({ error: `path is not a directory: ${dir}` });
      }
      body.path = dir;
    }

    let newRoles: { role: string; model: string; prompt: string }[] | undefined;
    if (body.roles !== undefined) {
      if (!Array.isArray(body.roles) || body.roles.length === 0) {
        return reply.code(400).send({ error: 'at least one role required' });
      }
      const seen = new Set<string>();
      newRoles = [];
      for (const r of body.roles) {
        const role = r.role?.toLowerCase().trim();
        if (!role || seen.has(role)) continue;
        seen.add(role);
        if (!(KNOWN_ROLES as readonly string[]).includes(role)) {
          return reply.code(400).send({ error: `unknown role: ${role}` });
        }
        // Never orphan a running agent: a role already on a model the catalog no longer lists
        // (legacy alias, retired pin) may be saved back unchanged. Only a NEW value is validated.
        const existing = ws.roles.find((x) => x.role === role)?.model;
        const supplied = r.model?.trim();
        if (supplied && supplied !== existing && !modelIds.includes(supplied)) {
          return reply.code(400).send({ error: `unknown model "${supplied}" for role ${role}` });
        }
        const model = supplied || existing || resolveModel(modelCatalog, 'sonnet');
        const prompt = r.prompt?.trim() || ws.roles.find((x) => x.role === role)?.prompt || defaultRole(role, model).prompt;
        newRoles.push({ role, model, prompt });
      }
      // The check above rejects an empty REQUEST; this one rejects an empty RESULT. The loop
      // skips entries with a blank role name, so [{}] passed the length check and stripped the
      // workspace to zero roles — retiring every agent and persisting `roles: []` to disk.
      if (newRoles.length === 0) return reply.code(400).send({ error: 'at least one role required' });
      const removed = ws.roles.filter((r) => !newRoles!.some((n) => n.role === r.role));
      if (removed.length > 0 && supervisor.isBusy(id)) {
        return reply.code(409).send({ error: 'agents are mid-turn — pause the workspace before removing roles' });
      }
    }

    if (body.name?.trim()) ws.name = body.name.trim();
    if (body.path !== undefined) ws.path = body.path;
    if (body.contextLimit !== undefined) {
      if (body.contextLimit === null) delete ws.contextLimit;
      else if (typeof body.contextLimit === 'number' && body.contextLimit >= 20000) ws.contextLimit = Math.floor(body.contextLimit);
      else return reply.code(400).send({ error: 'contextLimit must be a number ≥ 20000, or null to reset' });
    }
    if (body.extraAllowedTools !== undefined) {
      const tools = (body.extraAllowedTools ?? []).map((t) => t.trim()).filter(Boolean);
      if (tools.length === 0) delete ws.extraAllowedTools;
      else ws.extraAllowedTools = tools;
    }
    if (newRoles) {
      for (const old of ws.roles) {
        if (!newRoles.some((n) => n.role === old.role)) {
          const agent = store.getActiveAgent(id, old.role);
          if (agent) store.updateAgent(agent.id, { status: 'retired' });
        }
      }
      ws.roles = newRoles;
      for (const r of newRoles) {
        const agent = store.getActiveAgent(id, r.role);
        if (!agent) store.createAgent(id, r.role, r.model);
        else if (agent.model !== r.model) store.updateAgent(agent.id, { model: r.model });
      }
    }
    configStore.save();
    store.upsertWorkspace(id, ws.name, ws.path);
    const json = workspaceJson(store, config, id);
    broadcast({ type: 'workspace', workspace_id: id, workspace: json });
    return json;
  });

  app.patch('/api/workspaces/:id/roles/:role', async (req, reply) => {
    const { id, role } = req.params as { id: string; role: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    const roleCfg = ws.roles.find((r) => r.role === role);
    if (!roleCfg) return reply.code(404).send({ error: `no role "${role}" in this workspace` });
    const model = ((req.body ?? {}) as { model?: string }).model?.trim();
    // Re-selecting the role's current model is always allowed, even if the catalog dropped it.
    if (!model || (model !== roleCfg.model && !modelIds.includes(model))) {
      return reply.code(400).send({ error: `model must be one of: ${modelIds.join(', ')}` });
    }
    roleCfg.model = model;
    configStore.save();
    const agent = store.getActiveAgent(id, role);
    if (agent) {
      // Takes effect on the agent's next turn; the resumed session simply switches model.
      store.updateAgent(agent.id, { model });
      const fresh = store.getAgent(agent.id)!;
      broadcast({ type: 'agent', workspace_id: id, agent: agentJson(fresh, ws.contextLimit) });
      return agentJson(fresh, ws.contextLimit);
    }
    return { ok: true };
  });

  app.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!config.workspaces.some((w) => w.id === id)) return reply.code(404).send({ error: 'unknown workspace' });
    if (supervisor.isBusy(id)) {
      return reply.code(409).send({ error: 'agents are mid-turn in this workspace — pause it and try again in a moment' });
    }
    configStore.removeWorkspace(id);
    store.purgeWorkspace(id);
    lastSentEventId.delete(id);
    return { ok: true };
  });

  app.post('/api/workspaces/:id/goals', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text?.trim()) return reply.code(400).send({ error: 'text required' });
    // A hand-edited `"roles": []` leaves no agent to hand the goal to. Without this the goal
    // reached postGoal(), which read roles[0] and answered a bare 500 with an internal message.
    if (ws.roles.length === 0) {
      return reply.code(409).send({ error: 'workspace has no roles — add at least one role before posting a goal' });
    }
    const taskId = supervisor.postGoal(id, text.trim());
    return { task_id: taskId };
  });

  app.post('/api/workspaces/:id/message', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Without this the message was stored against a workspace id that does not exist: no
    // agent's unseenMessages() can ever reach it, so a typo'd id looked like a successful send.
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    const { body, to_role } = (req.body ?? {}) as { body?: string; to_role?: string | null };
    if (!body?.trim()) return reply.code(400).send({ error: 'body required' });
    supervisor.postUserMessage(id, body.trim(), to_role ?? null);
    return { ok: true };
  });

  // setRunning is a bare UPDATE, so an unknown id matched no row and these still answered
  // {"running":…} — reporting a state change that never happened.
  app.post('/api/workspaces/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    store.setRunning(id, false);
    return { running: false };
  });

  app.post('/api/workspaces/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ws = config.workspaces.find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'unknown workspace' });
    store.setRunning(id, true);
    void supervisor.tick();
    return { running: true };
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = store.getTask(id);
    if (!task) return reply.code(404).send({ error: 'unknown task' });
    const body = (req.body ?? {}) as { status?: TaskStatus; assignee_role?: string; priority?: number };
    store.updateTask(id, body);
    const updated = store.getTask(id)!;
    broadcast({ type: 'task', workspace_id: updated.workspace_id, task: updated });
    void supervisor.tick();
    return updated;
  });

  app.get('/api/agents/:id/turns', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
    return store.listTurns(id).map((t) => ({
      id: t.id,
      prompt_preview: t.prompt.slice(0, 200),
      result_preview: t.result.slice(0, 500),
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cost_usd: t.cost_usd,
      duration_ms: t.duration_ms,
      created_at: t.created_at,
    }));
  });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  return { app, onEvent };
}

function contextLimit(config: MissionConfig, workspaceId: string): number | undefined {
  return config.workspaces.find((w) => w.id === workspaceId)?.contextLimit;
}

function agentJson(a: AgentRow, override?: number) {
  return {
    id: a.id,
    role: a.role,
    name: a.name,
    model: a.model,
    status: a.status,
    context_tokens: a.context_tokens,
    context_limit: contextLimitFor(a.model, override),
    total_output_tokens: a.total_output_tokens,
    total_input_tokens: a.total_input_tokens,
    turns: a.turns,
    generation: a.generation,
    session_id: a.session_id,
  };
}

function eventJson(e: EventRow) {
  let payload: unknown = {};
  try {
    payload = JSON.parse(e.payload);
  } catch {
    /* keep {} */
  }
  return { id: e.id, agent_id: e.agent_id, agent_name: e.agent_name, type: e.type, payload, created_at: e.created_at };
}

function workspaceJson(store: Store, config: MissionConfig, id: string) {
  const ws = config.workspaces.find((w) => w.id === id)!;
  return {
    id: ws.id,
    name: ws.name,
    path: ws.path,
    running: store.isRunning(ws.id),
    agents: store.listAgents(ws.id).map((a) => agentJson(a, contextLimit(config, id))),
    task_counts: store.taskCounts(ws.id),
  };
}
