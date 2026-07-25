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
];

/** Fresh workspace per case, so one case's board cannot wake the next one's lead. */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lead-'));
  const dbPath = path.join(tmp, 'l.db');
  const store = new Store(openDb(dbPath));
  const ws = { id: 'w', name: 'W', path: tmp, roles: ROLES };
  const config = { port: 0, dbPath, maxConcurrentTurns: 1, tickSeconds: 0, workspaces: [ws] };
  store.upsertWorkspace(ws.id, ws.name, ws.path);
  const sup = new Supervisor(store, config, () => {});
  const lead = store.createAgent(ws.id, 'lead', 'sonnet');
  const builder = store.createAgent(ws.id, 'builder', 'sonnet');
  const work = (a: any) => (sup as any).pendingWork(ws, store.getAgent(a.id)!);
  return { store, ws, sup, lead, builder, work, tmp };
}

// 1. Goal decomposition — postGoal files a todo against the lead.
{
  const f = fixture();
  f.sup.postGoal(f.ws.id, 'Ship the onboarding flow');
  const w = f.work(f.lead);
  check('L1 lead wakes to decompose an owner goal', !!w && w.includes('todo'),
    w ? 'got a prompt with its todo' : 'NOT WOKEN — goals would never be decomposed');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// 2. Triage — an inbox task belongs to nobody, so only a status-based queue surfaces it.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Something to triage', 'unassigned work', 'operator', null, 'inbox', 2);
  const w = f.work(f.lead);
  check('L2 lead wakes to triage inbox work', !!w && w.includes(t.id),
    w ? 'inbox task surfaced' : 'NOT WOKEN — untriaged work would sit forever');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// 3. Unblocking — the blocked task is assigned to the BUILDER, not the lead.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Stuck on a ruling', 'needs a decision', 'builder-1', 'builder', 'blocked', 1);
  const w = f.work(f.lead);
  check('L3 lead wakes when someone else becomes blocked', !!w && w.includes(t.id),
    w ? 'blocked task surfaced to the lead' : 'NOT WOKEN — nobody would ever unblock anyone');
  fs.rmSync(f.tmp, { recursive: true, force: true });
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
  check('L4 lead does NOT wake for chatter, broadcast or directed', f.work(f.lead) === null,
    f.work(f.lead) === null ? 'stayed idle with 6 unread' : 'woken by talk alone — the loop is still open');
  check('L5 builder does NOT wake for chatter either', f.work(f.builder) === null,
    f.work(f.builder) === null ? 'stayed idle' : 'woken by talk alone');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// 5. A blocked task the lead could not clear must not re-wake it every stale interval —
//    that decision belongs to the owner, and relitigating it is exactly the burn we removed.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Owner ruling needed', 'policy call', 'builder-1', 'builder', 'blocked', 1);
  check('L6 blocked wakes the lead the first time', !!f.work(f.lead), 'first look happens');
  (f.sup as any).lastTurnAt.set(f.lead.id, Date.now() + 1000); // lead has now looked at it
  // Age it well past the stale threshold: a stale-eligible queue would re-fire here.
  f.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, t.id);
  check('L7 an unresolved blocked task does NOT re-wake the lead forever', f.work(f.lead) === null,
    f.work(f.lead) === null ? 'left for the owner, no re-litigation' : 'lead re-woken — 30-minute burn loop');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

// 6. Delivery path intact: a task created FOR another role is what wakes them.
{
  const f = fixture();
  const t = f.store.createTask(f.ws.id, 'Please do X', 'handed over by the lead', 'lead-1', 'builder', 'todo', 1);
  check('L8 creating a task for a role wakes that role', !!f.work(f.builder) && f.work(f.builder)!.includes(t.id),
    'builder picked up the handed-over task');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? 'ALL LEAD CHECKS PASSED' : failures.length + ' FAILURE(S)'}`);
process.exit(failures.length === 0 ? 0 : 1);
