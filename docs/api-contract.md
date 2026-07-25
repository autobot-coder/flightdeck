# Flightdeck — Dashboard ↔ Server API Contract (v1)

Server runs at `http://localhost:4400`. Dashboard is served from `/` (static files in `dashboard/`).

## REST

### GET /api/state
Full snapshot for the sidebar + overview.
```json
{
  "workspaces": [
    {
      "id": "acme-web",
      "name": "Acme Web",
      "path": "/Users/you/Projects/acme-web",
      "running": true,
      "agents": [
        {
          "id": "ag_x1",
          "role": "lead",
          "name": "lead-1",
          "model": "sonnet",
          "status": "idle",            // idle | working | retired
          "context_tokens": 84200,      // latest estimate of context size
          "context_limit": 180000,
          "total_output_tokens": 15000,
          "total_input_tokens": 2400000,  // Σ turns' final-request context (input + cache reads/creation)
          "turns": 12,
          "generation": 1,              // increments on succession
          "session_id": "uuid"
        }
      ],
      "task_counts": { "inbox": 1, "todo": 3, "in_progress": 2, "review": 0, "done": 9, "blocked": 0 }
    }
  ]
}
```

### GET /api/workspaces/:id
```json
{
  "workspace": { ...same shape as in /api/state... },
  "tasks": [
    {
      "id": "t_abc", "title": "...", "description": "...",
      "status": "todo",               // inbox | todo | in_progress | review | done | blocked
      "assignee_role": "builder", "created_by": "lead-1",
      "priority": 2,                   // 1 high, 2 normal, 3 low
      "created_at": 1752900000000, "updated_at": 1752900000000
    }
  ],
  "messages": [                        // newest last, max 200
    { "id": 1, "from_agent": "lead-1", "to_role": "builder", "body": "...", "task_id": "t_abc", "created_at": 1752900000000 }
  ],
  "events": [                          // newest last, max 200
    { "id": 5, "agent_id": "ag_x1", "agent_name": "lead-1", "type": "turn_start", "payload": {}, "created_at": 1752900000000 }
  ]
}
```
Event types: `turn_start`, `turn_end` (payload: `{input_tokens, output_tokens, cost_usd, duration_ms, summary}`), `tool_use` (payload: `{tool, detail}`), `agent_text` (payload: `{text}`), `succession` (payload: `{from, to, reason}`), `goal_posted`, `error` (payload: `{message}`).

`/api/state` also carries a `setup` block (added for the first-run experience) alongside `workspaces` and `known_models`:
```json
"setup": {
  "owner_name": "the operator",     // config ownerName, or the default
  "has_workspaces": false,
  "cli": {
    "ready": true,                  // false => agents cannot run
    "version": "2.1.219 (Claude Code)",
    "source": "native-binary",      // config | env | native-binary | npm-script | path
    "error": null                   // probe failure text when ready=false
  },
  "node": { "version": "22.3.0", "ok": true },
  "auth": { "mode": "cli-login", "detail": "…" },   // cli-login | api-key
  "platform": "darwin"
}
```
Clients must tolerate `setup` being absent (a server older than this field) — treat that as "no setup screen needed".

### GET /api/health
Readiness for the first-run setup screen: `{ "ok": bool, "setup": { … } }`, where `setup` is the block above and `ok` is `preflight passed && at least one workspace exists`.

Add `?recheck=1` to re-probe the Claude CLI and re-point the supervisor at the result. This exists so a user who installs the CLI while the server is running does **not** have to restart — restarting would kill every in-flight agent turn. Without the parameter the boot-time result is returned unchanged.

### POST /api/pick-folder
Opens the **native macOS Finder folder chooser** on the machine running the server (works because server and browser are the same machine). Blocks until the user picks or cancels (up to 5 min — client must not impose a short fetch timeout). Returns `{ "path": "/Users/you/Projects/my-app" }`. Errors: 410 `{error:"cancelled"}` (user cancelled — treat as a no-op, not an error), 409 (a dialog is already open), 501 (not macOS — fall back to GET /api/browse), 500 (other).

### GET /api/browse?path=/Users/you
Server-side folder browser for picking a project directory. `path` optional (defaults to the home directory; `~` accepted). Returns:
```json
{ "path": "/Users/you", "parent": "/Users", "dirs": [ { "name": "Projects", "path": "/Users/you/Projects" } ] }
```
`parent` is null at filesystem root. Hidden dirs and node_modules are filtered out. Error: 400 with `{error}` for unreadable paths.

### POST /api/workspaces
Create a workspace. Body:
```json
{ "name": "My App", "path": "~/Projects/my-app", "roles": ["lead","builder","reviewer"], "model": "sonnet" }
```
`roles` optional (default lead/builder/reviewer; valid: lead, builder, designer, reviewer, grunt — grunt always runs haiku). `model` optional (default sonnet). Returns the workspace object (same shape as in /api/state). Errors: 400 (missing/invalid name, path not a directory, unknown role), 409 (id already exists — id is the slugified name).

### POST /api/workspaces — per-role models
`roles` entries may be either strings (`"builder"` — uses the workspace `model`, grunt forced to haiku) or objects `{ "role": "builder", "model": "fable" }` where the explicit model wins. Valid models: `sonnet`, `fable`, `opus`, `haiku`.

### GET /api/workspaces/:id/settings
Full editable config for the settings UI:
```json
{
  "id": "acme-web", "name": "Acme Web", "path": "/Users/you/Projects/acme-web",
  "contextLimit": null,
  "extraAllowedTools": ["DesignSync"],
  "roles": [ { "role": "lead", "model": "sonnet", "prompt": "You are the tech lead..." } ],
  "known_roles": ["lead","builder","designer","reviewer","grunt"],
  "known_models": ["sonnet","fable","opus","haiku"]
}
```

### PATCH /api/workspaces/:id
Update workspace settings. Body — any subset of:
```json
{
  "name": "New Name",
  "path": "~/Projects/elsewhere",
  "contextLimit": 500000,
  "extraAllowedTools": ["DesignSync"],
  "roles": [ { "role": "lead", "model": "fable", "prompt": "..." } ]
}
```
Semantics: `contextLimit: null` resets to model-aware defaults (900k / 180k haiku); `extraAllowedTools: []` clears; `roles` REPLACES the role list — omitted roles are removed (their agents retired; 409 if agents are mid-turn), new roles get fresh agents, model changes apply to the active agent's next turn, and an empty/omitted `prompt` on an existing role keeps its current prompt. Returns the workspace object (same shape as /api/state); also pushed as a WS frame `{ "type": "workspace", "workspace_id": ..., "workspace": ... }` — upsert it into the sidebar/agent strip like any other frame.

### PATCH /api/workspaces/:id/roles/:role
Quick single-role model switch. Body `{ "model": "fable" }`. Returns the updated agent object (WS `agent` frame also pushed). Errors: 400 unknown model, 404 unknown workspace/role.

### DELETE /api/workspaces/:id
Remove a workspace from the config and purge all its history (agents, tasks, messages, events, turns). Returns `{ "ok": true }`. Errors: 404 (unknown), 409 (agents mid-turn — retry shortly; UI should surface the server's error message).

### POST /api/workspaces/:id/goals
Body `{ "text": "Build the checkout flow" }` → creates a goal task for the lead and wakes it. Returns `{ "task_id": "t_x" }`.

### POST /api/workspaces/:id/message
User speaks on the bus. Body `{ "body": "...", "to_role": "builder" | null }` (null = broadcast). Returns `{ "ok": true }`.

### POST /api/workspaces/:id/pause  and  POST /api/workspaces/:id/resume
Toggle the supervisor loop for that workspace. Returns `{ "running": bool }`.

### PATCH /api/tasks/:id
Body: any of `{ "status": "...", "assignee_role": "...", "priority": 1 }`. Returns updated task.

### GET /api/agents/:id/turns
Turn history for an agent, newest last, max 50:
```json
[ { "id": 1, "prompt_preview": "first 200 chars", "result_preview": "first 500 chars",
    "input_tokens": 1000, "output_tokens": 400, "cost_usd": 0.01, "duration_ms": 42000, "created_at": 1752900000000 } ]
```

## WebSocket

`ws://localhost:4400/ws`. Server pushes JSON frames:
```json
{ "type": "event",   "workspace_id": "acme-web", "event": { ...event shape above... } }
{ "type": "message", "workspace_id": "acme-web", "message": { ...message shape above... } }
{ "type": "task",    "workspace_id": "acme-web", "task": { ...task shape above... } }
{ "type": "agent",   "workspace_id": "acme-web", "agent": { ...agent shape above... } }
```
On any frame for the currently viewed workspace, update that piece of UI in place (upsert by id). No client→server messages needed in v1 (use REST).

## Dashboard requirements (v1)

Single-page, no build step: `dashboard/index.html` + `app.js` + `style.css`, vanilla JS. Dark, flightdeck aesthetic. Layout:
- Left sidebar: workspace list with running dot + task counts; click to switch.
- Top strip: agent cards — role, generation, model, status pill (pulsing when working), context meter (context_tokens/context_limit, amber >70%, red >90%), turns count. Click card → modal with turn history (GET /api/agents/:id/turns).
- Main: task board as 6 columns (inbox/todo/in_progress/review/done/blocked); cards show title, assignee role chip, priority. Drag-drop optional; a status dropdown on each card is enough.
- Right panel, two tabs: **Comms** (bus messages, chat-style, from → to) and **Activity** (events feed, compact lines, tool_use collapsed).
- Bottom bar: goal input ("Set a goal for this workspace…") posting to /goals, plus a smaller "message the team" input with a role selector posting to /message. Pause/Resume button in the header.
- Poll /api/workspaces/:id on switch, then rely on WS; reconnect WS with backoff; timestamps rendered as HH:MM.
