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

**Use the managed launcher — do not hand-roll the stop/start.** It already resolves the port
from config, stops gracefully with SIGINT so the orchestrator shuts its agent children down
cleanly, escalates only if that fails, starts detached, polls until the server answers, and
opens the browser. Reimplementing that in shell is how this skill became macOS-only.

1. **Restart** (this is stop + start; safe when nothing is running):

   - **macOS / Linux:**
     ```bash
     ./bin/server.sh restart
     ```
   - **Windows** (cmd or PowerShell):
     ```
     bin\server.cmd restart
     ```

   The launcher prints what it did and exits non-zero if the server never came up.

2. **If it refuses to stop**, it will say the port is held by something that is not this
   Flightdeck, and print the offending process. That is deliberate — it will not kill an
   unrelated program. Either free the port yourself, change `port` in `flightdeck.config.json`,
   or, if you are certain, re-run with `--force`.

3. **If it never comes up**, read the log the launcher names (`/tmp/flightdeck.log` on
   macOS/Linux, `flightdeck.log` in the project root on Windows) and report the error rather
   than retrying blindly.

4. **Open the dashboard** if the launcher did not (it opens one for you on `start`):
   `http://localhost:<port>` — the launcher prints the resolved URL.

5. **Tell the user:** (a) if they already had a dashboard tab open, that tab must be
   **hard-refreshed** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on macOS,
   <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on Windows/Linux — because the SPA never
   re-fetches `app.js` on its own and an old tab keeps running stale code after a restart;
   (b) the server is detached from this session and keeps running after they close this window.

## Notes

- Ideal restart moment is when no fleet agent is mid-turn, but the orchestrator handles SIGINT shutdown either way.
- The server is plain tsx with no watch mode — restarting is the only way changes to src/ take effect.
