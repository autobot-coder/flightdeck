import fs from 'node:fs';
import path from 'node:path';
import type { MissionConfig, RoleConfig, WorkspaceConfig } from './types.js';

/** Dashboard port when the config names none — the default documented in README.md:90. */
export const DEFAULT_PORT = 4400;

/**
 * Owns flightdeck.config.json. The in-memory `config` has dbPath resolved to an absolute
 * path and `port` defaulted, but SHARES the workspaces array with `raw`, so live
 * add/remove is seen by the supervisor immediately and persisted verbatim (dbPath stays
 * relative on disk, and an absent `port` stays absent — save() writes neither).
 */
export class ConfigStore {
  raw: MissionConfig;
  config: MissionConfig;

  constructor(public filePath: string, rootDir: string) {
    this.raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    this.config = {
      ...this.raw,
      // Without this, `port` stays undefined and app.listen() binds a random ephemeral
      // port: the app works but is unreachable at the URL it prints, and the launchers
      // can neither poll nor stop it (they look for a port named "undefined").
      port: this.raw.port ?? DEFAULT_PORT,
      dbPath: path.resolve(rootDir, this.raw.dbPath),
    };
  }

  /**
   * Rewrites the file, keeping whatever the operator edited on disk since boot.
   *
   * `workspaces` is the only key this app ever writes (add/remove, and role edits at the
   * four save() call sites), so ours wins there. It assigns no other field anywhere, so
   * disk wins for the rest and hand edits survive. Previously the whole file was rewritten
   * from the boot-time snapshot, so any edit made while the server ran — ownerName,
   * tickSeconds, a `models` catalog — was silently reverted by the next UI action.
   *
   * STILL LOST, deliberately: a workspace the operator hand-adds to the file. That is the
   * one key both sides write, and picking a winner is an owner ruling (t_c715bbcb).
   *
   * `raw`/`config` are left untouched on purpose — refreshing them would desync `config`,
   * a boot-time shallow copy the supervisor reads, and break the aliasing documented above.
   */
  save() {
    let onDisk: unknown = null;
    try {
      onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      // Deleted mid-run or hand-edited into invalid JSON: our own image is better than
      // nothing, and rewriting it restores a working file.
      onDisk = null;
    }
    const merged =
      onDisk && typeof onDisk === 'object' && !Array.isArray(onDisk)
        ? { ...(onDisk as Record<string, unknown>), workspaces: this.raw.workspaces }
        : this.raw;
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2) + '\n');
  }

  addWorkspace(ws: WorkspaceConfig) {
    this.raw.workspaces.push(ws);
    this.save();
  }

  removeWorkspace(id: string): boolean {
    const i = this.raw.workspaces.findIndex((w) => w.id === id);
    if (i === -1) return false;
    this.raw.workspaces.splice(i, 1);
    this.save();
    return true;
  }
}

/**
 * First run on a fresh clone: `flightdeck.config.json` is gitignored (it holds absolute paths
 * to the user's own projects), so seed it from the tracked example. Returns true when a new
 * file was written, so the caller can print the welcome banner exactly once.
 */
export function ensureConfigFile(configPath: string, examplePath: string): boolean {
  if (fs.existsSync(configPath)) return false;
  if (!fs.existsSync(examplePath)) {
    throw new Error(`no config at ${configPath} and no template at ${examplePath} to seed it from`);
  }
  fs.copyFileSync(examplePath, configPath);
  return true;
}

/** Used in agent system prompts when the config names no owner. */
export const DEFAULT_OWNER_NAME = 'the operator';

/** What agents call the human they work for. */
export function ownerNameFrom(config: Pick<MissionConfig, 'ownerName'>): string {
  return config.ownerName?.trim() || DEFAULT_OWNER_NAME;
}

/**
 * Author id recorded on goals and messages the human posts. Derived from `ownerName` so
 * the dashboard shows a real name, and stable at `operator` when none is configured —
 * a fresh clone must never attribute its user's messages to somebody else.
 */
export function ownerIdFrom(config: Pick<MissionConfig, 'ownerName'>): string {
  const slug = (config.ownerName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'operator';
}

export const KNOWN_ROLES = ['lead', 'builder', 'designer', 'reviewer', 'grunt'] as const;

/** A model offered to agents. `id` is passed to the CLI as `--model` verbatim. */
export interface ModelEntry {
  id: string;
  label: string;
}

/**
 * Catalog used when flightdeck.config.json has no `models` array. One entry per model, labelled
 * with the version it resolves to (owner ruling, 2026-07-25: names read `Claude-Opus-5`, and must
 * not repeat the model name the way `opus — claude-opus-5` did). This supersedes ruling #21's
 * label format and its "aliases AND pins" default — the duplicate pinned entries restated the
 * same four models, which is the repetition being removed.
 *
 * IDs stay the four bare aliases: every role in flightdeck.config.json and every DB agent row uses
 * them, so changing them would re-point live agents. Pinning an exact version is still fully
 * supported — add it to `models` in flightdeck.config.json (README.md:39-58).
 */
export const DEFAULT_MODEL_CATALOG: ModelEntry[] = [
  { id: 'sonnet', label: 'Claude-Sonnet-5' },
  { id: 'fable', label: 'Claude-Fable-5' },
  { id: 'opus', label: 'Claude-Opus-5' },
  { id: 'haiku', label: 'Claude-Haiku-4.5' },
];

/**
 * Normalizes the config's `models` array into the allow-list the server validates against.
 * Entries are free-form strings: Flightdeck does NOT gatekeep which model IDs exist, it
 * only offers what the operator configured. Falls back to the shipped catalog when absent or
 * empty, so configs written before the catalog existed keep working.
 */
export function modelCatalogFrom(models: MissionConfig['models']): ModelEntry[] {
  if (!Array.isArray(models)) return DEFAULT_MODEL_CATALOG;
  const seen = new Set<string>();
  const catalog: ModelEntry[] = [];
  for (const m of models) {
    const id = (typeof m === 'string' ? m : m?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = (typeof m === 'string' ? '' : m?.label ?? '').trim();
    catalog.push({ id, label: label || id });
  }
  return catalog.length ? catalog : DEFAULT_MODEL_CATALOG;
}

/** Role defaults must not error on a catalog that omits them — fall back to the first entry. */
export function resolveModel(catalog: ModelEntry[], desired: string): string {
  if (catalog.some((m) => m.id === desired)) return desired;
  return catalog[0]?.id ?? desired;
}

/**
 * Succession threshold per model. Current 1M-window models (fable, opus, sonnet) hand off
 * at 900k — leaving headroom so the handoff brief is written before the hard wall.
 * Haiku's window is still 200k, so its agents hand off at 180k.
 * A workspace's `contextLimit` overrides this for all its agents.
 * Matching is regex-based on purpose: it holds for pinned IDs too (`claude-haiku-4-5-20251001`).
 */
export function contextLimitFor(model: string, override?: number): number {
  if (override) return override;
  return /haiku/i.test(model) ? 180_000 : 900_000;
}

const DEFAULT_PROMPTS: Record<string, string> = {
  lead:
    'You are the tech lead. Decompose goals into small, concrete tasks with clear acceptance criteria and assign them to the right roles. ' +
    'You are the only role given untriaged (inbox) tasks and the only one shown a task the moment it becomes blocked — that is your queue, so ' +
    'when you see a blocker either decide it, or create a task for the role that can resolve it. If it is genuinely the owner\'s call, LEAVE it ' +
    'blocked and make sure its description states plainly what you need them to decide; you are shown each blocker once, so a blocker you leave ' +
    'vague will sit there unanswered. Keep the board moving and close the loop on review feedback. ' +
    'You do not write feature code yourself except tiny fixes.',
  builder:
    'You implement tasks end to end in this codebase. Follow existing patterns and conventions, run the build/tests before marking work for review, and describe what you changed when you move a task to review. ' +
    'Do not open speculative work for yourself when the board is empty — an empty board means done, and the owner will add the next goal. ' +
    'If you need something from another role, create a task for them rather than messaging them.',
  designer:
    'You own UI/UX quality: layout, typography, spacing, responsive behavior, and visual consistency. Review and refine UI the builder produces; make the tweaks yourself in code rather than writing essays. When new designs are needed, generate them yourself: propose several DISTINCT visual directions as standalone HTML mockups (different palette, typography, and layout each — never variations on one theme), and if the frontend-design skill is available, load it first for design craft. If the DesignSync tool is available, the owner keeps a design system in Claude Design: use it (list_projects, then list_files/get_file) to pull canonical components before designing, and push finished mockups/components up via finalize_plan + write_files so they can be reviewed visually in the Design System pane. Never wholesale-replace the remote project.',
  reviewer:
    'You review tasks in review status: read the diff, check correctness, run builds/tests, and either move the task to done with a short verdict or back to in_progress with specific, actionable feedback in the task description. ' +
    'Moving it back to in_progress is what re-wakes the builder — a message alone will not. Review what the task claims; do not re-run the whole investigation behind it.',
  grunt:
    'You handle mechanical, high-volume work: renames, boilerplate, fixture generation, lint cleanups, repetitive migrations. Do exactly what the task says, carefully, and report completion. Escalate anything requiring judgment to the lead via the bus.',
};

export function defaultRole(role: string, model: string): RoleConfig {
  return {
    role,
    model: role === 'grunt' ? 'haiku' : model,
    prompt: DEFAULT_PROMPTS[role] ?? `You are the ${role} on this team. Do ${role} work assigned to you well and coordinate via the bus.`,
  };
}
