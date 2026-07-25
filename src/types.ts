export type AgentStatus = 'idle' | 'working' | 'retired';
export type TaskStatus = 'inbox' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  roles: RoleConfig[];
  /** Tools headless sessions may use without prompting. Replaces the default list entirely. */
  allowedTools?: string[];
  /** Tools to allow in addition to the default list (e.g. DesignSync). */
  extraAllowedTools?: string[];
  /** Context-size threshold (tokens) that triggers succession. */
  contextLimit?: number;
}

export interface RoleConfig {
  role: string;
  model: string;
  prompt: string;
}

export interface MissionConfig {
  port: number;
  dbPath: string;
  /** Max concurrent claude sessions across all workspaces. */
  maxConcurrentTurns: number;
  /** Seconds between supervisor scheduling passes. */
  tickSeconds: number;
  /**
   * What agents call the human they work for, in system prompts and on goals they
   * receive. Defaults to "the operator" so a fresh clone never names someone else.
   */
  ownerName?: string;
  /**
   * Full path to the Claude CLI. Omit to auto-detect (native install, npm global, PATH).
   * Set it when the CLI lives somewhere unusual — see resolveCli in src/preflight.ts.
   */
  cliPath?: string;
  /**
   * Models offered to agents. Each entry is the exact `--model` value, either bare
   * (`"opus"`, `"claude-opus-5"`) or with a display label. Omit to use the shipped
   * default catalog — see DEFAULT_MODEL_CATALOG in config.ts.
   */
  models?: (string | { id: string; label?: string })[];
  workspaces: WorkspaceConfig[];
}

export interface AgentRow {
  id: string;
  workspace_id: string;
  role: string;
  name: string;
  model: string;
  status: AgentStatus;
  session_id: string | null;
  context_tokens: number;
  total_output_tokens: number;
  total_input_tokens: number;
  turns: number;
  generation: number;
  predecessor_id: string | null;
  last_seen_message_id: number;
  created_at: number;
}

export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_role: string | null;
  created_by: string;
  priority: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  workspace_id: string;
  from_agent: string;
  to_role: string | null;
  body: string;
  task_id: string | null;
  created_at: number;
}

export interface EventRow {
  id: number;
  workspace_id: string;
  agent_id: string | null;
  agent_name: string | null;
  type: string;
  payload: string; // JSON
  created_at: number;
}

export interface TurnRow {
  id: number;
  agent_id: string;
  prompt: string;
  result: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: number;
}
