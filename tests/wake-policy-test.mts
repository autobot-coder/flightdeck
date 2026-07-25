/**
 * Proves the lead role still functions once talking no longer wakes anyone.
 *
 * The lead's job is three things, and only ONE of them is a task assigned to it:
 *   1. decompose the owner's goals  (arrives as a todo assigned to lead)
 *   2. triage untriaged work        (inbox — assigned to nobody)
 *   3. unblock people               (blocked — assigned to whoever was stuck)
 * If the wake rule only honoured (1), the lead would be a goal-splitter and nothing else.
 *
 * Also pins the two things that must NOT happen: waking on chatter, and relitigating a
 * blocked task the owner is meant to decide.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, Store } from '../src/db.ts';
import { Supervisor } from '../src/orchestrator/supervisor.ts';

const failures: string[] = [];
const check = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
};

const ROLES = [
  { role: 'lead', model: 'sonnet', prompt: 'lead' },
  { role: 'builder', model: 'sonnet', prompt: 'build' },
  { role: 'reviewer', model: 'sonnet', prompt: 'review' },
];

const TMPDIRS: string[] = [];
process.on('exit', () => { for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true }); });

/** Fresh workspace per case, so one case's board cannot wake the next one's lead. */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lead-'));
  TMPDIRS.push(tmp);
  const dbPath = path.join(tmp, 'l.db');
  const store = new Store(openDb(dbPath));
  const ws = { id: 'w', name: 'W', path: tmp, roles: ROLES };
  const config = { port: 0, dbPath, maxConcurrentTurns: 1, tickSeconds: 0, workspaces: [ws] };
  store.upsertWorkspace(ws.id, ws.name, ws.path);
  const sup = new Supervisor(store, config, () => {});
  const lead = store.createAgent(ws.id, 'lead', 'sonnet');
  const builder = store.createAgent(ws.id, 'builder', 'sonnet');
  const reviewer = store.createAgent(ws.id, 'reviewer', 'sonnet');
  const work = (a: any) => (sup as any).pendingWork(ws, store.getAgent(a.id)!);
  return { store, ws, sup, lead, builder, reviewer, work, tmp };
}

// 1. Goal decomposition — postGoal files a todo against the lead.
{
  const f = fixture();
  f.sup.postGoal(f.ws.id, 'Ship the onboarding flow');
  const w = f.work(f.lead);
  check('L1 lead wakes to decompose an owner goal', !!w && w.prompt.includes('todo'),
    w ? 'got a prompt with its todo' : 'NOT WOKEN — goals would never be decomposed');
}

// 2. Triage — an inbox task belongs to nobody, so only a status-based queue surfaces it.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Something to triage', 'unassigned work', 'operator', null, 'inbox', 2);
  const w = f.work(f.lead);
  check('L2 lead wakes to triage inbox work', !!w && w.prompt.includes(t.id),
    w ? 'inbox task surfaced' : 'NOT WOKEN — untriaged work would sit forever');
}

// 3. Unblocking — the blocked task is assigned to the BUILDER, not the lead.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Stuck on a ruling', 'needs a decision', 'builder-1', 'builder', 'blocked', 1);
  const w = f.work(f.lead);
  check('L3 lead wakes when someone else becomes blocked', !!w && w.prompt.includes(t.id),
    w ? 'blocked task surfaced to the lead' : 'NOT WOKEN — nobody would ever unblock anyone');
}

// 4. Chatter must not wake anyone — this is the whole point of the change.
{
  const f = fixture();
  // Sender must not be either agent under test: unseenMessages excludes an agent's OWN posts,
  // so narrating as 'builder-1' would leave the builder trivially unwoken and the assertion
  // would pass even with the old wake-gate in place.
  for (let i = 0; i < 5; i++) f.store.postMessage(f.ws.id, 'designer-1', null, 'status narration ' + i, null);
  f.store.postMessage(f.ws.id, 'designer-1', 'lead', 'a directed report, still just talk', null);
  f.store.postMessage(f.ws.id, 'designer-1', 'builder', 'a directed report to the builder', null);
  const leadWork = f.work(f.lead);
  const builderWork = f.work(f.builder);
  check('L4 lead does NOT wake for chatter, broadcast or directed', leadWork === null,
    leadWork === null ? 'stayed idle with 6 unread' : 'woken by talk alone — the loop is still open');
  check('L5 builder does NOT wake for chatter either', builderWork === null,
    builderWork === null ? 'stayed idle' : 'woken by talk alone');
}

// 5. A blocked task the lead could not clear must not re-wake it every stale interval —
//    that decision belongs to the owner, and relitigating it is exactly the burn we removed.
{
  const HOUR = 60 * 60 * 1000;
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Owner ruling needed', 'policy call', 'builder-1', 'builder', 'blocked', 1);
  check('L6 blocked wakes the lead the first time', !!f.work(f.lead), 'first look happens');

  // The lead has now looked at it: its turn is strictly AFTER the task was blocked. Derived
  // from the row rather than the wall clock — `Date.now() - 1` raced task creation and left the
  // task still "fresh". And it MUST stay in the past: a future stamp makes pendingWork's
  // `Date.now() - last < tickSeconds` throttle return null before any queue is built, so every
  // assertion below would pass vacuously, including for a policy that re-woke the lead each tick.
  const blockedAt = (f.store.getTask(t.id) as any).updated_at;
  (f.sup as any).lastTurnAt.set(f.lead.id, blockedAt + 1);
  const immediately = f.work(f.lead);
  check('L7 an unchanged blocked task does NOT re-wake the lead on the next tick', immediately === null,
    immediately === null ? 'no per-tick relitigation' : 'lead re-woken immediately — burn loop');

  // But it must not be lost forever either: the lead's one dispatch can fail (lastTurnAt is
  // stamped at turn START and never rolled back), which would otherwise surface a blocker ZERO
  // times. After a full stale interval with no lead turn, it is re-offered exactly once.
  f.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - HOUR, t.id);
  (f.sup as any).lastTurnAt.set(f.lead.id, Date.now() - HOUR);
  const afterStale = f.work(f.lead);
  check('L7b a long-unresolved blocker IS re-offered once the stale window passes',
    !!afterStale && afterStale.prompt.includes(t.id),
    afterStale ? 're-surfaced after the window' : 'NEVER re-offered — a failed lead turn loses the blocker');
}

// 6. Delivery path intact: a task created FOR another role is what wakes them.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Please do X', 'handed over by the lead', 'lead-1', 'builder', 'todo', 1);
  const w = f.work(f.builder);
  check('L8 creating a task for a role wakes that role', !!w && w.prompt.includes(t.id),
    'builder picked up the handed-over task');
}

// 7. The review column — the queue that silently accumulated 17 tasks — must wake the reviewer.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Needs review', 'built by someone else', 'builder-1', 'builder', 'review', 1);
  const w = f.work(f.reviewer);
  check('L9 review column wakes the reviewer, not its assignee', !!w && w.prompt.includes(t.id),
    w ? 'reviewer picked it up' : 'NOT WOKEN — the review column is unreachable again');
  check('L10 the builder is not re-woken by its own in-review task', f.work(f.builder) === null,
    'builder correctly idle');
}

// 8. The OWNER must always get through. Suppressing agent chatter took the dashboard Comms
//    composer down with it: the owner could send an instruction, be told it was sent, and have
//    nothing ever happen.
{
  const f = fixture();
  f.sup.postUserMessage(f.ws.id, 'stop what you are doing and do X instead', 'builder');
  const w = f.work(f.builder);
  check('L11 a message from the OWNER wakes the addressed role', !!w && w.prompt.includes('do X instead'),
    w ? 'owner instruction delivered' : 'NOT WOKEN — the Comms composer is a dead control');
}

// 9. A workspace need not have a lead. Hard-coding the role stranded blocked/inbox work with no
//    wake path at all, and the board stopped silently.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nolead-'));
  TMPDIRS.push(tmp);
  const dbPath = path.join(tmp, 'n.db');
  const store = new Store(openDb(dbPath));
  const roles = [{ role: 'builder', model: 'sonnet', prompt: 'build' }];
  const ws = { id: 'w', name: 'W', path: tmp, roles };
  store.upsertWorkspace(ws.id, ws.name, ws.path);
  const sup = new Supervisor(store, { port: 0, dbPath, maxConcurrentTurns: 1, tickSeconds: 0, workspaces: [ws] }, () => {});
  const builder = store.createAgent(ws.id, 'builder', 'sonnet');
  const t = store.createTask(ws.id, 'Stuck, no lead exists', 'needs triage', 'builder-1', 'builder', 'blocked', 1);
  const w = (sup as any).pendingWork(ws, store.getAgent(builder.id)!);
  check('L12 a lead-less team still has a wake path for blocked work', !!w && w.prompt.includes(t.id),
    w ? 'fell back to the first configured role' : 'STRANDED — no role can ever be woken for it');
}

// 10. The prompt cap must defer mail, never destroy it: the cursor may only advance as far as
//     the prompt actually reached, or a successor's handoff brief (its OLDEST unread) is lost.
{
  const f = fixture();
  f.store.createTask(f.ws.id, 'some work', '', 'lead-1', 'builder', 'todo', 1);
  const first = f.store.postMessage(f.ws.id, 'designer-1', 'builder', 'HANDOFF BRIEF — oldest, must survive', null);
  for (let i = 0; i < 25; i++) f.store.postMessage(f.ws.id, 'designer-1', 'builder', 'chatter ' + i, null);
  const w = f.work(f.builder)!;
  check('L13 the cap keeps the OLDEST mail, so a handoff brief is never trimmed',
    w.prompt.includes('HANDOFF BRIEF'), 'oldest message present in the prompt');
  check('L14 the delivery cursor stops at what was actually shown',
    w.deliveredThrough > 0 && w.deliveredThrough < first.id + 25,
    `deliveredThrough=${w.deliveredThrough} (not the full backlog), so the rest are deferred not destroyed`);
}

console.log(`\n${failures.length === 0 ? 'ALL LEAD CHECKS PASSED' : failures.length + ' FAILURE(S)'}`);
process.exit(failures.length === 0 ? 0 : 1);
