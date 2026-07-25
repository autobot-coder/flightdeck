# Flightdeck test suite

```bash
npm test              # run everything
npm test roles        # run harnesses whose filename contains "roles"
```

There is no test framework. Each harness is a standalone script that prints its own
assertion lines and exits non-zero on failure; `tests/run.mjs` discovers `*-test.{mts,ts,cjs,sh}`,
runs them **serially** (several boot a real server on a fixed port or spawn stub CLIs, so they
would fight over ports in parallel) and aggregates the exit codes.

Exit codes: `0` pass, `77` **skip**, anything else fail. Skips are reported separately and never
counted as passes — a run that skipped something must not read as full coverage.

## What each harness guards

| harness | asserts |
|---|---|
| `preflight-test.mts` | owner-name/id defaults, config seeding, CLI resolution, Node floor |
| `win32-sim-test.mts` | Windows CLI candidate **order**, by real spawns with `process.platform` overridden |
| `nvm-fix-test.mts` | the npm-global root derived from `process.execPath` on both posix and win32 shapes |
| `mcp-spawn-test.mts` | the emitted MCP server entry is real JS and the bus server handshakes |
| `deps-test.mts` | every runtime dependency survives `npm install --omit=dev` |
| `typesdev-test.mts` | type-only packages stay out of production installs |
| `setupnode-test.mts` | the unsupported-Node banner actually reaches the setup screen |
| `config-merge-test.mts` | operator hand-edits to the config survive a UI write |
| `portdefault-test.sh` | the documented `port` default (4400) in **both** the app and the launchers |
| `roles-validation-test.sh` | no workspace can end up with zero roles; every `:id` route resolves its workspace |
| `catalog-test.ts` | model catalog + the live config's role models |
| `label-test.cjs` | model label rendering in `dashboard/app.js` |
| `ownerid-test.mts` | author id/display name derived for the human |
| `dbmig-test.mts` | `openDb()`'s migration path: a database written by older code keeps every row, and `total_input_tokens` is re-derived from `turns` on **every** open |
| `db-allowlist-test.mts` | `updateTask`/`updateAgent` interpolate column names, so only allowlisted columns may be written — no mass-assignment, no column-name SQL injection |
| `mkdir-hue-test.mts` | `POST /api/mkdir` cannot create a directory outside its `parent`, and `hue` is always stored as an integer 0-359 |

## Two things to know before changing anything here

**1. Negative controls are the point.** Several harnesses assert against a **pre-fix image** of
the file they cover, kept in `tests/fixtures/` (`base29`, `base30`, `base31`). A case that passes
against *both* the fixed file and the pre-fix image proves nothing — it is not testing the fix.
Do not delete the fixtures to "clean up", and do not point a harness at the current tree for both
halves of a comparison.

**2. A green suite is not proof the suite works.** These harnesses have been mutation-verified:
revert the fix a gate covers, confirm the gate goes red, and **read the failure text** — a crash
and a failed assertion both exit 1, and only one of them means what you want. One gate here scored
a full green with half its fix deleted, because it asserted an HTTP *status code* while its request
was malformed and never reached the code under test. Assert the reason, not just the code.

## Skips are deliberate, not breakage

Two harnesses declare a precondition and skip when it is absent:

- `catalog-test.ts`, `ownerid-test.mts` — these check the **operator's real `flightdeck.config.json`**,
  which is gitignored. That is intentional: a clean-clone fixture only ever exercises the default
  path, and running against a real config is what caught a restart-time owner-identity bug. In a
  fresh clone they skip.

`dbmig-test.mts` used to skip too, because it needed a ~14 MB copy of a real database. It now seeds
its own fixture and always runs. You can still point it at a copy of a real database for the
row-count checks:

```bash
cp data/flightdeck.db /tmp/mig.db && FLIGHTDECK_TEST_DB=/tmp/mig.db npm test dbmig
```

It refuses a path that looks live, because it opens the file for **writing**.

⚠️ If you touch that fixture, keep it seeded with **raw SQL in the pre-migration schema**. Building
it through today's `Store` would write today's schema, leaving the migration nothing to do — the
gate would then pass regardless of what `migrate()` contains. Its section A asserts the fixture is
genuinely historic for exactly this reason; if that assertion fails, everything below it is void.

## Provenance

These harnesses were built across many sessions while fixing the defects they now guard, and were
promoted into the repo from per-session scratch directories. They were absolute-path bound; they are
now repo-relative (each derives the repo root from its own location, like `src/index.ts` does) and
verified to pass from a checkout at a different path with no operator config present.
