/**
 * GATE — column allowlists on updateTask / updateAgent (t_fd350415).
 *
 * A SQL identifier cannot be parameterised, so db.ts interpolates key names into its UPDATE
 * ... SET clauses. Both updaters used to interpolate whatever keys the caller passed, and
 * PATCH /api/tasks/:id hands over the raw request body — so an HTTP client could rewrite a
 * task's primary key, move it to another workspace, or run a subquery through a crafted key.
 *
 * ⚠️ WHAT THIS GATE ASSERTS, AND WHY IT IS NOT A STATUS CHECK. Unknown keys are DROPPED, not
 * rejected, so the call returns normally either way — a test that only checked "did it throw"
 * or "what status came back" would pass against the vulnerable code too. Every case here
 * asserts the ROW: the stored record must be byte-identical to the baseline afterwards, and the
 * hijacked id must not exist. That is the difference between a gate and a decoration.
 *
 * The MCP bus path is NOT the hole — bus_update_task builds its fields explicitly from
 * zod-validated inputs (bus/server.ts:94-96) — but the fix lives in db.ts so every caller,
 * present and future, is covered rather than one route.
 *
 * No server, no CLI: temp DB, removed on exit.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, Store } from '../src/db.ts';
import type { AgentRow, TaskRow } from '../src/types.ts';

const WORK = mkdtempSync(join(tmpdir(), 'fd-allowlist-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let pass = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label: string, actual: unknown, expected: unknown) =>
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const store = new Store(openDb(join(WORK, 'allowlist.db')));
store.upsertWorkspace('ws1', 'Ws One', '/tmp/ws1');
store.upsertWorkspace('ws2', 'Ws Two', '/tmp/ws2');

console.log('GATE — db.ts column allowlists\n');

// ---------------------------------------------------------------- A
// Each payload is one of reviewer-1's reproduced attacks. The assertion is on the ROW, because
// the call itself succeeds in both the vulnerable and the fixed version.
console.log('A. a crafted key cannot change the stored row');
{
  const ATTACKS: Array<[string, Record<string, unknown>]> = [
    ['a column that does not exist', { boguscol: 'x' }],
    ['column-name SQL injection', { 'status=(SELECT 1),priority': 9 }],
    ['mass-assign workspace_id', { workspace_id: 'attacker' }],
    ['rewrite the primary key', { id: 't_HIJACKED' }],
    ['rewrite provenance (created_by)', { created_by: 'someone-else' }],
    ['rewrite created_at', { created_at: 0 }],
    ['several at once', { id: 't_HIJACKED2', workspace_id: 'attacker', created_by: 'x' }],
  ];
  for (const [label, payload] of ATTACKS) {
    const t = store.createTask('ws1', 'title', 'desc', 'operator', 'builder', 'todo', 2);
    const before = JSON.stringify(store.getTask(t.id));
    let threw = false;
    try { store.updateTask(t.id, payload as never); } catch { threw = true; }
    const after = JSON.stringify(store.getTask(t.id));
    ok(`${label}: row unchanged`, before === after && !threw,
      threw ? 'it threw instead of ignoring the key' : `before ${before}\n        after  ${after}`);
  }
  ok('no hijacked row was created',
    store.getTask('t_HIJACKED') === undefined && store.getTask('t_HIJACKED2') === undefined);
}

// ---------------------------------------------------------------- B
// Regression: the allowlist must not have broken any legitimate write. If this section fails the
// fix is too strict, which would be a worse outcome than the hole.
console.log('\nB. every legitimate task field still writes');
{
  const t = store.createTask('ws1', 'orig title', 'orig desc', 'operator', 'builder', 'todo', 2);
  store.updateTask(t.id, { status: 'review' });
  eq('status', store.getTask(t.id)?.status, 'review');
  store.updateTask(t.id, { assignee_role: 'reviewer' });
  eq('assignee_role', store.getTask(t.id)?.assignee_role, 'reviewer');
  store.updateTask(t.id, { priority: 1 });
  eq('priority', store.getTask(t.id)?.priority, 1);
  store.updateTask(t.id, { title: 'new title' });
  eq('title', store.getTask(t.id)?.title, 'new title');
  store.updateTask(t.id, { description: 'new desc' });
  eq('description', store.getTask(t.id)?.description, 'new desc');

  // The realistic shape of an attack: one valid key alongside one forbidden key. The valid part
  // must land and the forbidden part must not — dropping the whole call would also be wrong.
  const before = store.getTask(t.id)!;
  store.updateTask(t.id, { status: 'done', workspace_id: 'attacker' } as never);
  const after = store.getTask(t.id)!;
  eq('mixed payload: the valid key still applies', after.status, 'done');
  eq('mixed payload: the forbidden key is ignored', after.workspace_id, before.workspace_id);
}

// ---------------------------------------------------------------- C
console.log('\nC. the same protection on updateAgent');
{
  const agent = store.createAgent('ws1', 'builder', 'opus', 1);
  const snap = JSON.stringify(store.getAgent(agent.id));
  for (const [label, payload] of [
    ['id', { id: 'ag_HIJACKED' }],
    ['workspace_id', { workspace_id: 'ws2' }],
    ['role', { role: 'lead' }],
    ['name', { name: 'impostor-9' }],
    ['generation', { generation: 99 }],
    ['created_at', { created_at: 0 }],
    ['injection via key', { 'status=(SELECT 1),turns': 5 }],
  ] as Array<[string, Record<string, unknown>]>) {
    store.updateAgent(agent.id, payload as never);
    ok(`forbidden agent field ignored: ${label}`, JSON.stringify(store.getAgent(agent.id)) === snap,
      `row changed: ${JSON.stringify(store.getAgent(agent.id))}`);
  }
  ok('no hijacked agent row', store.getAgent('ag_HIJACKED') === undefined);

  // Regression: every field the real callers write must still work.
  store.updateAgent(agent.id, { status: 'working', session_id: 'sess-1', context_tokens: 10 });
  store.updateAgent(agent.id, { total_output_tokens: 20, total_input_tokens: 30, turns: 2 });
  store.updateAgent(agent.id, { last_seen_message_id: 7, model: 'haiku' });
  const a = store.getAgent(agent.id) as AgentRow;
  eq('status writes', a.status, 'working');
  eq('session_id writes', a.session_id, 'sess-1');
  eq('context_tokens writes', a.context_tokens, 10);
  eq('total_output_tokens writes', a.total_output_tokens, 20);
  eq('total_input_tokens writes', a.total_input_tokens, 30);
  eq('turns writes', a.turns, 2);
  eq('last_seen_message_id writes', a.last_seen_message_id, 7);
  eq('model writes', a.model, 'haiku');
}

// ---------------------------------------------------------------- D
// An all-forbidden payload must leave the row completely alone — including updated_at, which
// updateTask appends to every write. If the guard ran the UPDATE anyway with only updated_at,
// the row would be silently touched on every rejected call.
console.log('\nD. an entirely-forbidden payload touches nothing at all');
{
  const t = store.createTask('ws1', 'title', 'desc', 'operator', 'builder', 'todo', 2);
  const before = store.getTask(t.id) as TaskRow;
  store.updateTask(t.id, { id: 'x', workspace_id: 'y' } as never);
  const after = store.getTask(t.id) as TaskRow;
  eq('updated_at was not bumped', after.updated_at, before.updated_at);
  ok('whole row identical', JSON.stringify(after) === JSON.stringify(before));
}

console.log(`\n${fails.length === 0 ? '✓' : '✗'} ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `    - ${f}`).join('\n')); process.exit(1); }
