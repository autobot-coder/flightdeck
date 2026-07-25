/**
 * GATE — openDb()'s migration path (t_8d4b9617).
 *
 * openDb() runs SCHEMA (all CREATE IF NOT EXISTS) and then migrate(), which is exactly what
 * happens to the operator's real database on every restart. This gate asserts a database written
 * by OLDER code survives that: no rows lost, and the added column correctly derived.
 *
 * ⚠️ THE TAUTOLOGY THIS AVOIDS. The obvious way to write this is to build the fixture through
 * today's Store and then assert today's migrate() preserves it. That proves nothing: today's
 * Store writes today's schema, so the migration has nothing to do and the gate passes whatever
 * migrate() contains. The fixture here is seeded with RAW SQL in the PRE-migration schema — an
 * `agents` table with NO total_input_tokens column — and section A asserts it really is historic
 * before anything else runs. If that assertion ever fails the fixture has drifted forward and
 * everything below it is worthless.
 *
 * This harness used to need a ~14 MB copy of a real database and skipped without one, so it
 * proved nothing on a normal run. It is now self-contained; FLIGHTDECK_TEST_DB still runs the
 * same row-count checks against a copy of a real database if you want them.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';

const WORK = mkdtempSync(join(tmpdir(), 'fd-dbmig-'));
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

let pass = 0;
const fails: string[] = [];
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label: string, actual: unknown, expected: unknown) =>
  ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const TABLES = ['workspaces', 'agents', 'tasks', 'messages', 'events', 'turns'] as const;
type Counts = Record<string, number>;
const counts = (db: Database.Database): Counts =>
  Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]));
const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tokensOf = (db: Database.Database, id: string) =>
  (db.prepare(`SELECT total_input_tokens t FROM agents WHERE id = ?`).get(id) as { t: number } | undefined)?.t;
const read = <T>(file: string, fn: (db: Database.Database) => T): T => {
  const db = new Database(file, { readonly: true });
  try { return fn(db); } finally { db.close(); }
};

/**
 * A database as PRE-migration code left it: no total_input_tokens on agents, and turns rows
 * carrying the input_tokens the column must later be derived from. Raw SQL on purpose — going
 * through today's writers would create today's schema and leave no migration to exercise.
 */
function seedHistoric(file: string) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, running INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL,
      model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', session_id TEXT,
      context_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, predecessor_id TEXT,
      last_seen_message_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox', assignee_role TEXT, created_by TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, from_agent TEXT NOT NULL,
      to_role TEXT, body TEXT NOT NULL, task_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, agent_id TEXT, agent_name TEXT,
      type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    INSERT INTO workspaces VALUES ('ws1', 'Ws One', '/tmp/ws1', 1), ('ws2', 'Ws Two', '/tmp/ws2', 0);
    -- ag1 has turns; ag2 has NONE (must land on 0, not NULL); ag3 is a later generation.
    INSERT INTO agents (id, workspace_id, role, name, model, status, total_output_tokens, turns, generation, created_at) VALUES
      ('ag1', 'ws1', 'builder',  'builder-1',  'opus', 'idle',    500, 2, 1, 1000),
      ('ag2', 'ws1', 'reviewer', 'reviewer-1', 'opus', 'idle',      0, 0, 1, 1001),
      ('ag3', 'ws1', 'builder',  'builder-2',  'opus', 'retired', 250, 1, 2, 1002);
    INSERT INTO tasks (id, workspace_id, title, created_by, status, created_at, updated_at) VALUES
      ('t1', 'ws1', 'a task',       'operator', 'todo',   1000, 1000),
      ('t2', 'ws1', 'another task', 'operator', 'review', 1001, 1001);
    INSERT INTO messages (workspace_id, from_agent, to_role, body, created_at) VALUES
      ('ws1', 'builder-1', 'lead', 'hello',     1000),
      ('ws1', 'lead-1',    NULL,   'broadcast', 1001),
      ('ws2', 'builder-1', NULL,   'other ws',  1002);
    INSERT INTO events (workspace_id, agent_id, agent_name, type, created_at) VALUES
      ('ws1', 'ag1', 'builder-1', 'turn_start', 1000);
    -- 111 + 222 = 333 for ag1; 44 for ag3; nothing for ag2.
    INSERT INTO turns (agent_id, prompt, input_tokens, output_tokens, created_at) VALUES
      ('ag1', 'p1', 111, 10, 1000),
      ('ag1', 'p2', 222, 20, 1001),
      ('ag3', 'p3',  44,  5, 1002);
  `);
  db.close();
}

console.log('GATE — openDb() migration path\n');

const FIXTURE = join(WORK, 'historic.db');
seedHistoric(FIXTURE);

// ---------------------------------------------------------------- A
console.log('A. the fixture really is PRE-migration (if this fails, nothing below means anything)');
read(FIXTURE, (db) => {
  ok('agents has NO total_input_tokens column yet',
    !cols(db, 'agents').includes('total_input_tokens'), cols(db, 'agents').join(','));
  ok('but it carries the turns the column must be derived from',
    (db.prepare(`SELECT COUNT(*) c FROM turns`).get() as { c: number }).c === 3);
});
const before = read(FIXTURE, counts);

// ---------------------------------------------------------------- B
console.log('\nB. openDb() migrates it: nothing lost, column added and derived');
let threw: string | null = null;
try { openDb(FIXTURE).close(); } catch (e) { threw = String(e); }
ok('openDb() completed without throwing', threw === null, threw ?? '');
read(FIXTURE, (db) => {
  const after = counts(db);
  for (const t of TABLES) eq(`row count preserved: ${t}`, after[t], before[t]);
  ok('total_input_tokens column now exists', cols(db, 'agents').includes('total_input_tokens'));
  eq('derived from turns: ag1 = 111 + 222', tokensOf(db, 'ag1'), 333);
  eq('an agent with NO turns lands on 0, not NULL', tokensOf(db, 'ag2'), 0);
  eq('derived per agent, not globally: ag3 = 44', tokensOf(db, 'ag3'), 44);
  eq('pre-existing total_output_tokens untouched',
    (db.prepare(`SELECT total_output_tokens o FROM agents WHERE id='ag1'`).get() as { o: number }).o, 500);
  eq('a non-default column value survives (ws2.running = 0)',
    (db.prepare(`SELECT running r FROM workspaces WHERE id='ws2'`).get() as { r: number }).r, 0);
});

// ---------------------------------------------------------------- C
// Ruling #15's addendum: the recompute must run on EVERY open, not once. A server still on
// pre-column code keeps writing turns without accumulating, so a one-shot backfill freezes
// stale. This is the assertion a one-shot implementation fails.
console.log('\nC. the recompute runs on every open, not once (the one-shot-backfill defect)');
{
  const w = new Database(FIXTURE);
  w.prepare(`INSERT INTO turns (agent_id, prompt, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?)`)
    .run('ag1', 'p4', 1000, 1, 2000);
  w.close();
  openDb(FIXTURE).close();
  eq('a turn inserted AFTER the first migration is picked up: 333 + 1000',
    read(FIXTURE, (db) => tokensOf(db, 'ag1')), 1333);
}

// ---------------------------------------------------------------- D
console.log('\nD. idempotent: re-opening an already-migrated DB changes nothing');
{
  const snap = read(FIXTURE, (db) => ({ c: counts(db), t: tokensOf(db, 'ag1') }));
  openDb(FIXTURE).close();
  openDb(FIXTURE).close();
  read(FIXTURE, (db) => {
    const after = counts(db);
    ok('row counts unchanged across two more opens',
      TABLES.every((t) => after[t] === snap.c[t]), JSON.stringify(after));
    eq('derived value unchanged', tokensOf(db, 'ag1'), snap.t);
  });
}

// ---------------------------------------------------------------- E
// Optional: the same row-count checks against a copy of a real database. Off by default — a
// populated image cannot be committed, and a gate must not depend on one machine's data.
console.log('\nE. optional real-database pass (FLIGHTDECK_TEST_DB)');
{
  const real = (process.env.FLIGHTDECK_TEST_DB ?? '').trim();
  if (!real) {
    console.log('  – not set; sections A-D already ran against the fixture, so nothing is skipped');
  } else if (/\/data\/(flightdeck|mission)\.db$/.test(real)) {
    ok('refuses to run against what looks like a LIVE database', false,
      `${real} — copy it first, this opens the file for WRITING`);
  } else if (!existsSync(real)) {
    ok('FLIGHTDECK_TEST_DB points at an existing file', false, real);
  } else {
    const b = read(real, counts);
    let t: string | null = null;
    try { openDb(real).close(); } catch (e) { t = String(e); }
    ok('openDb() completed on the real copy without throwing', t === null, t ?? '');
    const a = read(real, counts);
    for (const tbl of TABLES) eq(`real DB row count preserved: ${tbl}`, a[tbl], b[tbl]);
  }
}

console.log(`\n${fails.length === 0 ? '✓' : '✗'} ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `    - ${f}`).join('\n')); process.exit(1); }
