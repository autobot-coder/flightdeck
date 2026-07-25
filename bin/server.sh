#!/bin/bash
# Flightdeck server manager (macOS / Linux)
# Usage: ./bin/server.sh [start|stop|restart|status|logs|help]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

LOG_FILE="/tmp/flightdeck.log"
PORT=$(node -p "require('$PROJECT_ROOT/flightdeck.config.json').port" 2>/dev/null || echo "4400")
# `node -p` prints "undefined" and exits 0 when the config exists but names no `port`, so
# the `||` fallback above never fires for it. Anything non-numeric means use the default —
# otherwise every command below targets a port called "undefined": start reports failure
# while the server runs, and stop/restart can never find it again.
case "$PORT" in '' | *[!0-9]*) PORT=4400 ;; esac
URL="http://localhost:$PORT"

listening_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

# Is this pid OUR server, rather than whatever else happens to hold the port?
#
# The server runs as `node … <PROJECT_ROOT>/node_modules/tsx/… src/index.ts`, so its command
# line always carries the project root. Without this check `stop` killed any listener and
# reported "✓ stopped cleanly" — an unrelated program on the configured port was terminated
# and the user was told their server had shut down.
#
# Deliberately matches on the process, NOT on liveness: a wedged server that no longer answers
# HTTP still has the right command line, so the SIGTERM/SIGKILL escalation below is unaffected.
# That was the stated reason a naive "is it responding?" guard would have been worse than none.
is_ours() {
  local cmd
  cmd=$(ps -o command= -p "$1" 2>/dev/null) || return 1
  # BOTH conditions: the project root AND our entry point. Matching the root alone is too
  # loose — any unrelated script living inside the project directory would pass, which is
  # exactly how the first version of this guard let a foreign listener through.
  case "$cmd" in
    *"$PROJECT_ROOT"*) : ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *src/index.ts*) return 0 ;;
    *) return 1 ;;
  esac
}

is_up() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null)" = "200" ]
}

do_stop() {
  local pids foreign
  pids=$(listening_pids)
  if [ -z "$pids" ]; then
    echo "  (nothing running on port $PORT)"
    return 0
  fi

  # Refuse to kill somebody else's process. Reported per-pid because the honest failure here
  # is "your port is taken", which is actionable, where a silent kill was not.
  foreign=""
  for pid in $pids; do
    is_ours "$pid" || foreign="$foreign $pid"
  done
  if [ -n "$foreign" ] && [ "$FORCE" != "1" ]; then
    echo "  ✗ refusing to stop: port $PORT is held by a process that is not this Flightdeck."
    for pid in $foreign; do
      echo "      pid $pid: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-100)"
    done
    echo "    This is not $PROJECT_ROOT. Change \"port\" in flightdeck.config.json, stop that"
    echo "    process yourself, or re-run with --force if you are certain."
    return 1
  fi

  # SIGINT == Ctrl-C: lets the orchestrator shut its agent children down cleanly.
  echo "  stopping PID(s): $(echo $pids | tr '\n' ' ')"
  for pid in $pids; do kill -INT "$pid" 2>/dev/null || true; done

  for _ in $(seq 1 10); do
    [ -z "$(listening_pids)" ] && { echo "  ✓ stopped cleanly"; return 0; }
    sleep 1
  done

  echo "  ! still alive after SIGINT — escalating to SIGTERM"
  for pid in $(listening_pids); do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 5); do
    [ -z "$(listening_pids)" ] && { echo "  ✓ stopped (SIGTERM)"; return 0; }
    sleep 1
  done

  echo "  !! SIGTERM failed — force killing (agent children may be orphaned)"
  for pid in $(listening_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
  [ -z "$(listening_pids)" ] || { echo "  ✗ could not free port $PORT"; return 1; }
  echo "  ✓ stopped (SIGKILL)"
}

do_start() {
  if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo "node_modules missing — running npm install..."
    npm install
  fi

  echo "Starting Flightdeck on port $PORT..."
  # nohup + disown so the server outlives the terminal window you launched it from.
  nohup npm run start > "$LOG_FILE" 2>&1 &
  disown

  for _ in $(seq 1 30); do
    if is_up; then
      echo "✓ running at $URL"
      echo "  opening dashboard..."
      open "$URL" 2>/dev/null || echo "  open $URL in your browser"
      echo "  logs: $LOG_FILE"
      echo "  NOTE: if you already had a dashboard tab open, hard-refresh it (Cmd+Shift+R)."
      return 0
    fi
    sleep 1
  done

  echo "✗ server did not come up within 30s. Last 30 log lines:"
  echo "---"
  tail -n 30 "$LOG_FILE" 2>/dev/null || echo "(no log at $LOG_FILE)"
  return 1
}

# --force may appear anywhere; strip it so the command word keeps its position.
FORCE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--force" ] || [ "$a" = "-f" ]; then FORCE=1; else ARGS+=("$a"); fi
done
set -- "${ARGS[@]:-}"

case "${1:-restart}" in
  start)
    if is_up; then
      echo "Already running at $URL — opening dashboard."
      open "$URL" 2>/dev/null || true
      exit 0
    fi
    do_start
    ;;
  stop)
    echo "Stopping Flightdeck..."
    do_stop
    ;;
  restart)
    echo "Restarting Flightdeck..."
    do_stop
    do_start
    ;;
  status)
    if is_up; then
      echo "✓ running at $URL (PID: $(listening_pids | tr '\n' ' '))"
    else
      echo "✗ not running on port $PORT"
      exit 1
    fi
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  help | *)
    cat <<EOF
Flightdeck server manager

Usage: ./bin/server.sh [command]

Commands:
  start      Start it (no-op + opens browser if already up)
  stop       Stop it gracefully (SIGINT, so agents shut down cleanly)
  restart    Stop then start — the default if you pass no command
  status     Is it running?
  logs       Tail $LOG_FILE
  help       This message

Options:
  --force    Let stop/restart kill a listener that is NOT this Flightdeck.
             Without it, stop refuses rather than terminating an unrelated
             process that happens to hold port $PORT.
EOF
    ;;
esac
