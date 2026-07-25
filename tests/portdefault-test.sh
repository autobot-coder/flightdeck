#!/bin/bash
# GATE 13 — builder-39. The documented `port` default (README.md:90 "default 4400").
#
# This is the FIRST gate that covers bin/ at all; the inherited 12 are TypeScript /
# preflight / config only (builder-38, msg 1442).
#
# Guards three fixes:
#   src/config.ts   ConfigStore defaults port  -> app binds 4400, not a random ephemeral port
#   bin/server.sh   non-numeric PORT guard     -> launcher polls/stops 4400, not "undefined"
#   bin/server.cmd  same guard, Windows        -> text assertion only (batch cannot run here)
#
# SAFETY: starts no server and signals nothing. Pure resolution logic + a real ConfigStore.
# Run:  bash <scratchpad>/portdefault-test.sh [repo-root]
set -uo pipefail
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1"; }
chk()  { [ "$2" = "$3" ] && ok "$1 -> $2" || bad "$1: expected '$3', got '$2'"; }

cfg() { # cfg <file> <json-body>
  printf '%s\n' "$2" > "$TMP/$1"
}
cfg noport.json   '{ "dbPath": "data/x.db", "maxConcurrentTurns": 0, "tickSeconds": 60, "workspaces": [] }'
cfg withport.json '{ "port": 4421, "dbPath": "data/x.db", "maxConcurrentTurns": 0, "tickSeconds": 60, "workspaces": [] }'
cfg junkport.json '{ "port": "not-a-port", "dbPath": "data/x.db", "maxConcurrentTurns": 0, "tickSeconds": 60, "workspaces": [] }'
cfg zeroport.json '{ "port": 0, "dbPath": "data/x.db", "maxConcurrentTurns": 0, "tickSeconds": 60, "workspaces": [] }'

echo "== A. src/config.ts — ConfigStore applies the documented default =="
# Uses the REAL ConfigStore, not a reimplementation.
node --input-type=module -e "
import { ConfigStore, DEFAULT_PORT } from '${REPO}/src/config.ts';
const p = (f) => new ConfigStore('${TMP}/' + f, '${TMP}').config.port;
console.log('DEFAULT_PORT=' + DEFAULT_PORT);
console.log('noport=' + p('noport.json'));
console.log('withport=' + p('withport.json'));
console.log('raw_untouched=' + (new ConfigStore('${TMP}/noport.json','${TMP}').raw.port));
console.log('zeroport=' + p('zeroport.json'));
" --import "${REPO}/node_modules/tsx/dist/loader.mjs" > "$TMP/a.out" 2>"$TMP/a.err" || {
  echo "  (node/tsx invocation failed — see below)"; cat "$TMP/a.err" | head -5; }
get() { grep -m1 "^$1=" "$TMP/a.out" | cut -d= -f2-; }
chk "DEFAULT_PORT exported"                 "$(get DEFAULT_PORT)"  "4400"
chk "config.port with no \`port\` key"        "$(get noport)"        "4400"
chk "config.port honours an explicit port"  "$(get withport)"      "4421"
chk "raw.port left absent (save() must not invent one)" "$(get raw_untouched)" "undefined"

echo "== B. bin/server.sh — the real resolution lines, extracted from the real file =="
# Pull lines 11..(the case guard) straight out of the shipped script so this gate cannot
# drift from it, then evaluate them against each config.
resolve() { # resolve <config-file> <script>
  local pr="$TMP" cfgfile="$2"
  local snippet
  snippet=$(sed -n '/^PORT=\$(node -p/,/^URL=/p' "$1" | grep -v '^URL=')
  [ -z "$snippet" ] && { echo "NO-SNIPPET"; return; }
  PROJECT_ROOT="$pr" bash -c "
    cd '$pr' && ln -sf '$cfgfile' flightdeck.config.json 2>/dev/null
    PROJECT_ROOT='$pr'
    $snippet
    echo \"\$PORT\""
}
SH="$REPO/bin/server.sh"
grep -q '^case "\$PORT" in' "$SH" && ok "guard line present in bin/server.sh" \
  || bad "guard line MISSING in bin/server.sh — the fix is not in the file under test"
chk "server.sh resolves a port-less config"  "$(resolve "$SH" noport.json)"   "4400"
chk "server.sh honours an explicit port"     "$(resolve "$SH" withport.json)" "4421"
chk "server.sh rejects a non-numeric port"   "$(resolve "$SH" junkport.json)" "4400"
# `port: 0` is NOT defaulted, by design and in BOTH layers: config.ts uses `??` (absent/null
# only) and the shell guard accepts 0 as numeric. 0 means "ephemeral" to Node, so overriding
# it would be a new policy no ruling covers. What matters is that the two layers AGREE —
# a divergence here recreates the exact bug this gate exists to catch. Unruled edge, flagged
# to the owner, deliberately NOT fixed.
sh_zero="$(resolve "$SH" zeroport.json)"
ts_zero="$(get zeroport)"
chk "server.sh passes port 0 through (documented as unruled)" "$sh_zero" "0"
[ "$sh_zero" = "$ts_zero" ] && ok "launcher and ConfigStore AGREE on port 0 (both '$sh_zero')" \
  || bad "port 0 DIVERGES: server.sh='$sh_zero' but ConfigStore='$ts_zero' — unreachable-server bug is back"
rm -f "$TMP/flightdeck.config.json"

echo "== C. bin/server.cmd — parity (text assertion; batch is not executable here) =="
CMD="$REPO/bin/server.cmd"
grep -q 'findstr /r /c:"\^\[0-9\]\[0-9\]\*\$"' "$CMD" \
  && ok "numeric guard present in bin/server.cmd" \
  || bad "numeric guard MISSING in bin/server.cmd — Windows keeps the defect"
grep -q 'if not defined PORT set "PORT=4400"' "$CMD" \
  && ok "server.cmd still keeps its missing-file fallback" \
  || bad "server.cmd lost its 'if not defined PORT' fallback"
c_sh=$(grep -c '4400' "$SH"); c_cmd=$(grep -c '4400' "$CMD")
[ "$c_sh" -ge 2 ] && [ "$c_cmd" -ge 2 ] && ok "both launchers carry the 4400 default ($c_sh / $c_cmd refs)" \
  || bad "default drifted between launchers (sh=$c_sh cmd=$c_cmd)"

echo "== D. mutation — with the guard removed, B must go RED =="
MUT="$TMP/server-mutated.sh"
grep -v '^case "\$PORT" in' "$SH" > "$MUT"
mres=$(resolve "$MUT" noport.json)
if [ "$mres" = "undefined" ]; then
  ok "mutant (guard deleted) resolves 'undefined' — the gate is sensitive to this fix"
else
  bad "mutant still resolved '$mres' — THIS GATE IS BLIND, do not trust its green"
fi

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
