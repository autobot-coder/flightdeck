/**
 * GATE — the succession cursor (t_04903f2c, residual on the closed t_96002366).
 *
 * When a session hits its context limit it writes a handoff brief and a fresh generation
 * inherits it. Which messages that successor inherits is decided by ONE number: the
 * `last_seen_message_id` its cursor is anchored on. This file exists because that number has
 * been wrong twice, in OPPOSITE directions.
 *
 * ⚠️ WHY THE OBVIOUS TEST IS WORTHLESS (reviewer-1): an assertion like "the cursor is not 0"
 * passes under BOTH historical bugs and proves nothing. One bug replayed the predecessor's
 * entire working life (3-55 messages, up to 54k chars); the other skipped past the brief. Any
 * assertion that merely bounds the cursor is satisfied by both. So this gate evaluates all
 * FOUR candidate anchors against one fixture timeline and asserts which messages each one
 * actually delivers — the shipped anchor must pass where every rejected anchor fails.
 *
 * Uses the REAL Store and the REAL unseenMessages() query. Section D re-reads the shipped
 * supervisor.ts so the gate cannot go green while the source uses a different anchor.
 *
 * No server, no CLI, no real turn: temp DB only, deleted on exit.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, Store } from '../src/db.ts';
import type { AgentRow } from '../src/types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = mkdtempSync(join(tmpdir(), 'fd-succession-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let pass = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------- fixture
const store = new Store(openDb(join(WORK, 'succession.db')));
const WS = 'ws1';
store.upsertWorkspace(WS, 'Ws1', WORK);

const predecessor = store.createAgent(WS, 'builder', 'opus', 1);   // builder-1
store.createAgent(WS, 'lead', 'opus', 1);                          // lead-1

// --- messages from BEFORE the handoff turn: the successor must NOT inherit these ---
const ancient = store.postMessage(WS, 'builder-1', 'builder', 'builder-1 early working note', null);
store.postMessage(WS, 'lead-1', 'builder', 'old directive the predecessor already saw', null);
const lastOld = store.postMessage(WS, 'builder-1', null, 'builder-1 mid-session broadcast', null);

// --- the supervisor captures this BEFORE running the handoff turn ---
const beforeHandoff = store.db
  .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE workspace_id = ?`)
  .get(WS) as { m: number };

// --- the handoff turn. Another agent posts DURING it, before the predecessor does. ---
// This is the window the residual dropped: the predecessor never saw it (it postdates its
// prompt) and an anchor set on the predecessor's own first post skips it too.
const interleaved = store.postMessage(WS, 'lead-1', 'builder', 'URGENT lead directive mid-handoff', null);
const brief = store.postMessage(WS, 'builder-1', 'builder', 'HANDOFF BRIEF: state, decisions, next steps', null);
// bus_update_task posts its note as a BROADCAST from the same agent (bus/server.ts:97), so it
// lands with a HIGHER id than the brief — this is what made the last-message anchor fail.
const trailingNote = store.postMessage(WS, 'builder-1', null, 'task note: t_x moved to review', null);

const successor = store.createAgent(WS, 'builder', 'opus', 2, predecessor.id);

/** What the successor would actually receive with a given cursor, using the real query. */
function inherited(cursor: number) {
  const row = { ...successor, last_seen_message_id: cursor } as AgentRow;
  return store.unseenMessages(row).map((m) => m.id);
}

// The four anchors that have been used or proposed here.
const ANCHORS = {
  beforeHandoff: beforeHandoff.m,                 // shipped
  firstEver: ancient.id - 1,                      // bug 1: replays the whole working life
  lastMessage: trailingNote.id - 1,               // bug 2: lands above the brief
  firstInTurn: brief.id - 1,                      // residual: drops the interleaved message
};

console.log('GATE — succession cursor\n');
console.log(`  timeline: ancient=${ancient.id} lastOld=${lastOld.id} | beforeHandoff=${beforeHandoff.m} |`
  + ` interleaved=${interleaved.id} brief=${brief.id} trailingNote=${trailingNote.id}\n`);

// ---------------------------------------------------------------- A
console.log('A. the shipped anchor delivers the brief AND loses nothing');
{
  const got = inherited(ANCHORS.beforeHandoff);
  ok('brief is in the successor\'s unseen set', got.includes(brief.id), `got ${JSON.stringify(got)}`);
  ok('the mid-handoff message from another agent is delivered too', got.includes(interleaved.id),
    `got ${JSON.stringify(got)}`);
  ok('the trailing task note is delivered', got.includes(trailingNote.id), `got ${JSON.stringify(got)}`);
  ok('nothing from before the handoff turn is replayed',
    !got.includes(ancient.id) && !got.includes(lastOld.id), `got ${JSON.stringify(got)}`);
  ok('exactly the handoff turn: 3 messages', got.length === 3, `got ${got.length}: ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------- B
// Negative controls. Each rejected anchor MUST fail in its own distinct way — that is what
// makes section A meaningful rather than a check that would pass regardless.
console.log('\nB. every rejected anchor fails, each in its own way (discrimination)');
{
  const firstEver = inherited(ANCHORS.firstEver);
  ok('REJECTED firstEver: really does over-replay the predecessor\'s history',
    firstEver.includes(ancient.id) && firstEver.includes(lastOld.id),
    `got ${JSON.stringify(firstEver)}`);
  ok('  ...and so delivers MORE than the handoff turn', firstEver.length > 3, `got ${firstEver.length}`);

  const lastMessage = inherited(ANCHORS.lastMessage);
  ok('REJECTED lastMessage: really does DROP the brief',
    !lastMessage.includes(brief.id), `got ${JSON.stringify(lastMessage)}`);
  ok('  ...and hands over only the trailing note',
    lastMessage.length === 1 && lastMessage[0] === trailingNote.id, `got ${JSON.stringify(lastMessage)}`);

  const firstInTurn = inherited(ANCHORS.firstInTurn);
  ok('REJECTED firstInTurn: delivers the brief', firstInTurn.includes(brief.id),
    `got ${JSON.stringify(firstInTurn)}`);
  ok('  ...but really does LOSE the mid-handoff message (the residual)',
    !firstInTurn.includes(interleaved.id), `got ${JSON.stringify(firstInTurn)}`);
}

// ---------------------------------------------------------------- C
console.log('\nC. the loss is permanent, not merely deferred');
{
  // The predecessor's prompt was built from its own cursor BEFORE the handoff turn, so
  // `interleaved` was not in it. Under the residual anchor the successor skips it as well, so
  // no agent in this role ever reads it — a loss, not a delay. Asserted from the successor
  // side, which is the side the cursor controls.
  ok('under the residual anchor the mid-handoff message reaches NEITHER generation',
    !inherited(ANCHORS.firstInTurn).includes(interleaved.id)
      && inherited(ANCHORS.beforeHandoff).includes(interleaved.id),
    'the shipped anchor must be the thing that rescues it');
}

// ---------------------------------------------------------------- D
// Drift guard: sections A-C would stay green if supervisor.ts silently changed anchor, because
// they only exercise the Store. Read the shipped source and require the anchor be the
// pre-turn id, extracted from the file rather than restated here.
console.log('\nD. the shipped supervisor.ts actually uses the pre-turn anchor');
{
  const src = readFileSync(join(REPO, 'src/orchestrator/supervisor.ts'), 'utf8');
  ok('succession() captures maxMessageId BEFORE the handoff turn',
    /const beforeHandoff = this\.maxMessageId\(ws\.id\);[\s\S]{0,400}?await runTurn\(/.test(src));
  // Bound to the updateAgent CALL, not to the bare identifier: the loose form was also
  // satisfied by `unseenMessages({ ...successor, last_seen_message_id: beforeHandoff })`, so
  // it stayed green under a mutant that restored the rejected cursor. Found by mutation-
  // testing this gate, which is the only way that shows up.
  ok('the successor cursor assignment IS beforeHandoff',
    /updateAgent\(\s*successor\.id\s*,\s*\{\s*last_seen_message_id:\s*beforeHandoff\s*\}\s*\)/.test(src));
  ok('no anchor derived from the predecessor\'s own posts remains',
    !/last_seen_message_id:\s*cursor\s*\}/.test(src) && !/posted\[0\]\.id\s*-\s*1/.test(src));
  ok('supervisor.ts exists where this gate expects it',
    existsSync(join(REPO, 'src/orchestrator/supervisor.ts')));
}

console.log(`\n${fails.length === 0 ? '✓' : '✗'} ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `    - ${f}`).join('\n')); process.exit(1); }
