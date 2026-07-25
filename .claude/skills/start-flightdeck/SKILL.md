---
name: start-flightdeck
description: Restart (or cold-start) the Flightdeck dev server and open the dashboard in the browser. For the owner's interactive session only — Flightdeck fleet agents must NEVER run this.
---

# Start / restart Flightdeck

Restart the Flightdeck dev server (or start it if it isn't running) and open the dashboard in the browser.

## ⛔ Safety guard — check this first

If you are a **Flightdeck fleet agent** (a lead/builder/designer/reviewer/grunt session coordinating via flightdeck-bus tools), **STOP — do not run this skill.** The dev server is the fleet's parent orchestrator; fleet agents are its child processes, and restarting it kills the whole fleet mid-task. Post a broadcast bus message asking the owner to run /start-flightdeck from their own terminal instead.

Only proceed if this is an interactive session started directly by the user (no flightdeck-bus tools in play).

## Steps

Work from the project root — the directory containing `flightdeck.config.json` and `bin/server.sh`.

1. **Resolve the port** from config — don't hardcode it:
   ```bash
   PORT=$(node -p "require('./flightdeck.config.json').port")
   ```
   The examples below use $PORT; keep that substitution (or re-resolve it) in every command you run.

2. **Check for a running server** (note: this can print MULTIPLE pids):
   ```bash
   lsof -nP -iTCP:$PORT -sTCP:LISTEN -t
   ```
   - No output → nothing running, skip to step 4.

3. **Stop every listed pid gracefully** (SIGINT is the equivalent of Ctrl-C — the orchestrator needs it to shut down its agent children cleanly):
   ```bash
   for pid in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t); do kill -INT "$pid"; done
   ```
   Poll for up to ~10 seconds until every pid is gone (kill -0 "$pid" fails). If any survive, escalate once to kill -TERM and poll again. **Never** start with kill -9; only use it as a last resort if TERM also fails, and say so in your summary. Note: if the server was started in a visible terminal window, that terminal's process will simply exit — that's expected.

4. **Start the server DETACHED** so it outlives this Claude Code session — do NOT use the Bash tool's run_in_background for the server itself (a background shell dies when this session ends, and the whole agent fleet with it):
   ```bash
   nohup npm run start > /tmp/flightdeck.log 2>&1 & disown
   ```
   Then poll until it's up (up to ~30 seconds):
   ```bash
   curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/"
   ```
   Success = 200. If it never comes up, read /tmp/flightdeck.log and report the error instead of continuing.

5. **Open the dashboard:**
   ```bash
   open "http://localhost:$PORT"
   ```

6. **Tell the user:** (a) if they already had a dashboard tab open, that tab must be **hard-refreshed** (Cmd+Shift+R) — the SPA never re-fetches app.js on its own, so an old tab keeps running stale code even after a server restart; (b) the server is detached from this session (logs at /tmp/flightdeck.log) and keeps running after they close this Claude Code window.

## Notes

- Ideal restart moment is when no fleet agent is mid-turn, but the orchestrator handles SIGINT shutdown either way.
- The server is plain tsx with no watch mode — restarting is the only way changes to src/ take effect.
