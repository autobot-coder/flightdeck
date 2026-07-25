#!/usr/bin/env bash
# GATE 14 — zero-role workspaces (builder-40, task t_99ad5069)
#
# Usage:  bash roles-validation-test.sh [repo-root]
#
# Guards three things that were all broken before the fix:
#   A. boot-time config validation   — a workspace with no "roles" ARRAY must fail with a
#      pointer, not a raw "ws.roles is not iterable" stack. Runs the REAL app; the validation
#      sits before startServer(), so this section binds NO port.
#   B. API validators                — POST/PATCH must reject a non-empty roles array that
#      yields no usable entry ([{}], [{"role":"  "}]) while still treating [] as "use the
#      defaults". Real HTTP against a real booted server on its OWN port and OWN dbPath.
#   C. empty-roles workspace         — boots with a warning, answers a goal with an actionable
#      409 (not a 500), and stays repairable through the Settings endpoint.
#
# SAFETY: every port is asserted free before use and released after; the resolved port is
# echoed and the script ABORTS if anything resolves to 4400 (the operator's live server).
# maxConcurrentTurns is 0 in every config, so no agent is ever spawned.
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT_B=4455
PORT_C=4456
PASS=0; FAIL=0
WORK="$(mktemp -d)"
SRV_PIDS=()

# lsof lives in /usr/sbin and is NOT always on a sanitized PATH (builder-38's trap).
LSOF=/usr/sbin/lsof
[ -x "$LSOF" ] || LSOF=$(command -v lsof)

cleanup() {
  # Kill the LISTENER, not npx's pid: `npx tsx` spawns node as a child, so killing the npx
  # wrapper leaves an orphan still bound to the port (builder-39's npx-orphan trap).
  for p in "$PORT_B" "$PORT_C"; do
    local pid
    pid=$("$LSOF" -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)
    [ -n "$pid" ] && kill $pid 2>/dev/null
  done
  for p in "${SRV_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  sleep 2
  for p in "$PORT_B" "$PORT_C"; do
    if "$LSOF" -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
      echo "  ⚠ port $p STILL BOUND after cleanup — kill the listener by hand"
    else
      echo "  released port $p"
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected '$2', got '$3'"; fi
}

mkconfig() { # mkconfig <outfile> <port> <roles-json>
  mkdir -p "$WORK/proj" "$WORK/db"
  cat > "$1" <<EOF
{
  "ownerName": "Gate 14",
  "port": $2,
  "dbPath": "$WORK/db/$(basename "$1").db",
  "maxConcurrentTurns": 0,
  "tickSeconds": 3600,
  "workspaces": [
    { "id": "gws", "name": "Gws", "path": "$WORK/proj"$3 }
  ]
}
EOF
}

assert_port_free() { # assert_port_free <port>
  echo "  resolved PORT=$1"
  if [ "$1" = "4400" ]; then echo "  ABORT: resolves to 4400 (the live server)"; exit 9; fi
  if "$LSOF" -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "  ABORT: port $1 is already in use"; exit 9
  fi
}

boot() { # boot <config> <port> <logfile> -> sets BOOT_UP=yes|no
  local cfg="$1" port="$2" log="$3"
  assert_port_free "$port"
  ( cd "$ROOT" && nohup npx tsx src/index.ts "$cfg" > "$log" 2>&1 & echo $! > "$WORK/pid" )
  SRV_PIDS+=("$(cat "$WORK/pid")")
  BOOT_UP=no
  for _ in $(seq 1 30); do
    if curl -sf -m 2 "http://127.0.0.1:$port/api/state" >/dev/null 2>&1; then BOOT_UP=yes; break; fi
    sleep 1
  done
}

code() { # code <method> <url> [data]  -> prints HTTP status, body lands in $WORK/body
  if [ $# -ge 3 ]; then
    curl -s -o "$WORK/body" -w '%{http_code}' -X "$1" "$2" -H 'content-type: application/json' -d "$3"
  else
    curl -s -o "$WORK/body" -w '%{http_code}' -X "$1" "$2"
  fi
}

# check_req <label> <expected-code> <expected-body-substring|""> <method> <url> [payload]
#
# Asserts the REASON, not just the status. A status-only assertion gave this gate a FALSE
# GREEN: the create payload was built with escaped quotes nested inside a command
# substitution inside double quotes, so curl sent malformed JSON and Fastify answered
# 400 FST_ERR_CTP_INVALID_JSON_BODY. The request never reached the validator under test,
# yet "expected 400, got 400" passed — the gate stayed green with the fix deleted.
# Payloads are now built in plain variables, and every expected 4xx names its cause.
check_req() {
  local st
  st=$(code "$4" "$5" ${6+"$6"})
  if [ "$st" != "$2" ]; then
    bad "$1: expected HTTP $2, got $st — body: $(head -c 140 "$WORK/body")"
    return
  fi
  if [ -n "$3" ] && ! grep -qF "$3" "$WORK/body"; then
    bad "$1: got HTTP $2 but for the WRONG REASON (body lacks '$3'): $(head -c 160 "$WORK/body")"
    return
  fi
  ok "$1"
}

echo "GATE 14 — zero-role workspaces        repo: $ROOT"
echo

# ---------------------------------------------------------------- A
echo "A. boot-time validation of a missing \"roles\" array (binds NO port)"
mkconfig "$WORK/noroles.json" 4457 ""      # no "roles" key at all
out="$WORK/noroles.out"
( cd "$ROOT" && npx tsx src/index.ts "$WORK/noroles.json" >"$out" 2>&1 )
check "exit status is 1" "1" "$?"
if grep -q 'has no "roles" array' "$out"; then ok "prints a pointer naming the missing key"
else bad "pointer text missing; got: $(head -3 "$out" | tr '\n' ' ')"; fi
if grep -q 'not iterable' "$out"; then bad "still prints the raw TypeError stack"
else ok "no raw 'not iterable' stack"; fi
if grep -q 'roles"*: *\[' "$out"; then ok "suggests a concrete fix"; else bad "no example fix in the message"; fi
if "$LSOF" -iTCP:4457 -sTCP:LISTEN -n -P >/dev/null 2>&1; then bad "bound a port before failing"
else ok "bound no port (validation precedes startServer)"; fi
echo

# ---------------------------------------------------------------- B
echo "B. API validators, real HTTP"
mkconfig "$WORK/good.json" "$PORT_B" ',
      "roles": [ { "role": "lead", "model": "opus", "prompt": "p" }, { "role": "builder", "model": "opus", "prompt": "p" } ]'
boot "$WORK/good.json" "$PORT_B" "$WORK/good.log"
if [ "$BOOT_UP" != yes ]; then
  bad "server did not come up on $PORT_B — remaining B/C checks skipped"
  echo "$(cat "$WORK/good.log")"
else
  ok "server up on $PORT_B"
  B="http://127.0.0.1:$PORT_B"
  NEED="at least one role required"
  check_req "PATCH roles:[] rejected (control)"      "400" "$NEED" PATCH "$B/api/workspaces/gws" '{"roles":[]}'
  check_req "PATCH roles:[{}] rejected"              "400" "$NEED" PATCH "$B/api/workspaces/gws" '{"roles":[{}]}'
  check_req "PATCH roles:[{role:'  '}] rejected"     "400" "$NEED" PATCH "$B/api/workspaces/gws" '{"roles":[{"role":"  "}]}'
  check_req "PATCH roles:[{role:''}] rejected"       "400" "$NEED" PATCH "$B/api/workspaces/gws" '{"roles":[{"role":""}]}'

  roles=$(curl -s "$B/api/workspaces/gws/settings" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).roles.map(r=>r.role).join(",")))')
  check "roles survived every rejected PATCH"         "lead,builder" "$roles"

  # Payloads go in variables: the escaped-quote-inside-$()-inside-quotes form silently sent
  # malformed JSON and made this section pass with the fix removed.
  mkdir -p "$WORK/p1" "$WORK/p2"
  PAY_BAD="{\"name\":\"Zed\",\"path\":\"$WORK/p1\",\"roles\":[{}]}"
  PAY_DEF="{\"name\":\"Defs\",\"path\":\"$WORK/p2\",\"roles\":[]}"
  check_req "POST create roles:[{}] rejected"        "400" "$NEED" POST "$B/api/workspaces" "$PAY_BAD"
  # REGRESSION: an empty array still means "give me the shipped defaults".
  check_req "POST create roles:[] accepted"          "200" "" POST "$B/api/workspaces" "$PAY_DEF"
  got=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.agents.map(a=>a.role).sort().join(","))' "$WORK/body" 2>/dev/null)
  check "  ...and got the 3 default roles"            "builder,lead,reviewer" "$got"

  check_req "normal PATCH still accepted"            "200" "" PATCH "$B/api/workspaces/gws" '{"roles":[{"role":"lead","model":"opus"},{"role":"reviewer","model":"opus"}]}'
  check_req "goal on a healthy workspace"            "200" "task_id" POST "$B/api/workspaces/gws/goals" '{"text":"gate goal"}'
  # Capture the id HERE, immediately after the successful goal — $WORK/body holds only the most
  # recent response, so reading it after the 404 check below would parse the error instead.
  TASK_ID=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).task_id||"")}catch{process.stdout.write("")}})' < "$WORK/body")
  check_req "goal on an unknown workspace is 404"    "404" "unknown workspace" POST "$B/api/workspaces/nosuch/goals" '{"text":"x"}'

  # ---- t_937774ad: PATCH /api/tasks/:id must not answer 200 to a field it ignores ----
  # db.ts DROPS keys outside its allowlist, which is the right safety behaviour but silent: a
  # typo'd field name used to return 200 with an unchanged task. The route now says so. The
  # allowlist is read from db.ts, so this must NOT reject title/description, which do work.
  if [ -z "$TASK_ID" ]; then
    bad "could not capture a task id from the goal response (later PATCH checks skipped)"
  else
    ok "captured task id $TASK_ID for the PATCH checks"
    check_req "PATCH unknown field is 400, not a silent 200" "400" "unknown field(s): boguscol" \
      PATCH "$B/api/tasks/$TASK_ID" '{"boguscol":"x"}'
    check_req "  ...and the error names what IS updatable"   "400" "updatable: status" \
      PATCH "$B/api/tasks/$TASK_ID" '{"boguscol":"x"}'
    # Regression: everything the data layer allows must still be accepted here. Rejecting
    # title/description would have narrowed the API, since they reach the DB today.
    check_req "PATCH status still accepted"                  "200" "" PATCH "$B/api/tasks/$TASK_ID" '{"status":"in_progress"}'
    check_req "PATCH title still accepted (not narrowed)"    "200" "" PATCH "$B/api/tasks/$TASK_ID" '{"title":"renamed by gate"}'
    check_req "PATCH description still accepted"             "200" "" PATCH "$B/api/tasks/$TASK_ID" '{"description":"d"}'
    check_req "PATCH priority still accepted"                "200" "" PATCH "$B/api/tasks/$TASK_ID" '{"priority":3}'
    # A mixed payload must be refused OUTRIGHT rather than half-applied.
    check_req "a valid+invalid mix is refused"               "400" "unknown field(s)" \
      PATCH "$B/api/tasks/$TASK_ID" '{"status":"done","boguscol":"x"}'
    left=$(curl -s "$B/api/workspaces/gws" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.tasks||[]).find(t=>t.id===process.argv[1]);process.stdout.write(t?t.status:"MISSING")})' "$TASK_ID")
    check "the refused mix applied NOTHING (status still in_progress)" "in_progress" "$left"
  fi

  # ---- t_2ec3ac4c: every :id route must RESOLVE the workspace, not assume it ----
  # /message stored a row against a nonexistent workspace (unreachable dead data); /pause and
  # /resume answered {"running":…} while setRunning's bare UPDATE matched no row at all.
  UNK="$B/api/workspaces/__nope__"
  check_req "unknown ws: /message is 404"            "404" "unknown workspace" POST "$UNK/message" '{"body":"orphan","to_role":null}'
  check_req "unknown ws: /pause is 404"              "404" "unknown workspace" POST "$UNK/pause" '{}'
  check_req "unknown ws: /resume is 404"             "404" "unknown workspace" POST "$UNK/resume" '{}'
  # Controls: the same three must still work on a real workspace.
  check_req "real ws: /message still 200"            "200" "ok" POST "$B/api/workspaces/gws/message" '{"body":"real","to_role":null}'
  check_req "real ws: /pause still 200"              "200" "running" POST "$B/api/workspaces/gws/pause" '{}'
  check_req "real ws: /resume still 200"             "200" "running" POST "$B/api/workspaces/gws/resume" '{}'
  # The DB is the authority, not the status code: no row may exist under the unknown id.
  orphans=$(node -e '
    const D=require("better-sqlite3")(process.argv[1],{readonly:true});
    const m=D.prepare("SELECT COUNT(*) c FROM messages WHERE workspace_id=?").get("__nope__").c;
    const w=D.prepare("SELECT COUNT(*) c FROM workspaces WHERE id=?").get("__nope__").c;
    process.stdout.write(String(m+w));' "$WORK/db/good.json.db" 2>/dev/null)
  check "no DB rows written under the unknown id"     "0" "$orphans"
fi
echo

# ---------------------------------------------------------------- C
echo "C. a workspace whose \"roles\" array is empty"
mkconfig "$WORK/empty.json" "$PORT_C" ',
      "roles": []'
boot "$WORK/empty.json" "$PORT_C" "$WORK/empty.log"
if [ "$BOOT_UP" != yes ]; then
  bad "server did not come up on $PORT_C — C checks skipped"
else
  ok "boots rather than refusing (an empty array is structurally valid)"
  if grep -q 'has no roles' "$WORK/empty.log"; then ok "warns the operator at boot"; else bad "no boot warning"; fi
  C="http://127.0.0.1:$PORT_C"
  check_req "goal answers 409 naming the cause"       "409" "workspace has no roles" POST "$C/api/workspaces/gws/goals" '{"text":"x"}'
  check_req "Settings still readable (so it is fixable)" "200" "\"roles\"" GET "$C/api/workspaces/gws/settings"
  check_req "adding a role repairs it"                "200" "" PATCH "$C/api/workspaces/gws" '{"roles":[{"role":"lead","model":"opus"}]}'
  check_req "goal works after the repair"             "200" "task_id" POST "$C/api/workspaces/gws/goals" '{"text":"after repair"}'
fi

echo
echo "──────────────────────────────────────────"
echo "GATE 14: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
