import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATION_0001_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_config (
  id                  TEXT    PRIMARY KEY DEFAULT 'default',
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  is_default_password INTEGER NOT NULL DEFAULT 1 CHECK (is_default_password IN (0, 1)),
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT    PRIMARY KEY,
  username     TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS model_providers (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL CHECK (kind IN ('openai-compat', 'anthropic', 'ollama', 'custom')),
  base_url       TEXT    NOT NULL,
  api_key_ref    TEXT,
  default_model  TEXT    NOT NULL,
  models_json    TEXT    NOT NULL DEFAULT '[]',
  extra_json     TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                  TEXT    PRIMARY KEY,
  kind                TEXT    NOT NULL CHECK (kind IN ('agent_private', 'project', 'git_worktree', 'shared')),
  name                TEXT    NOT NULL,
  root_path           TEXT    NOT NULL UNIQUE,
  is_git              INTEGER NOT NULL DEFAULT 0 CHECK (is_git IN (0, 1)),
  git_common_dir      TEXT,
  git_branch          TEXT,
  base_commit         TEXT,
  parent_workspace_id TEXT    REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_type          TEXT    NOT NULL CHECK (owner_type IN ('agent', 'room', 'work_node', 'global')),
  owner_id            TEXT,
  readonly_refs_json  TEXT    NOT NULL DEFAULT '[]',
  cleaned_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS agents (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  bio                   TEXT    NOT NULL DEFAULT '',
  avatar_json           TEXT    NOT NULL DEFAULT '{}',
  system_prompt         TEXT    NOT NULL DEFAULT '',
  driver_kind           TEXT    NOT NULL CHECK (driver_kind IN ('builtin', 'claude', 'acp', 'codex', 'custom')),
  provider_id           TEXT    REFERENCES model_providers(id) ON DELETE SET NULL,
  driver_config_json    TEXT    NOT NULL DEFAULT '{}',
  default_workspace_id  TEXT    NOT NULL REFERENCES workspaces(id),
  permission_mode       TEXT    NOT NULL DEFAULT 'workspace-write'
                        CHECK (permission_mode IN ('read-only', 'workspace-write', 'full')),
  isolation_mode        TEXT    NOT NULL DEFAULT 'standard'
                        CHECK (isolation_mode IN ('standard', 'isolated-home', 'lockdown')),
  skill_ids_json        TEXT    NOT NULL DEFAULT '[]',
  mcp_server_ids_json   TEXT    NOT NULL DEFAULT '[]',
  max_running_turns     INTEGER NOT NULL DEFAULT 2 CHECK (max_running_turns >= 1),
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(archived_at);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id                TEXT    PRIMARY KEY,
  workspace_id      TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daemon_session_id TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL DEFAULT 'Terminal',
  status            TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'exited')),
  exit_code         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_ws ON terminal_sessions(workspace_id, status);

CREATE TABLE IF NOT EXISTS rooms (
  id                    TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL,
  purpose               TEXT    NOT NULL DEFAULT '',
  strategy_id           TEXT    NOT NULL,
  strategy_config_json  TEXT    NOT NULL DEFAULT '{}',
  strategy_state_json   TEXT    NOT NULL DEFAULT '{}',
  state                 TEXT    NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'running', 'pausing', 'paused', 'done')),
  primary_workspace_id  TEXT    REFERENCES workspaces(id) ON DELETE SET NULL,
  shared_memories_json  TEXT    NOT NULL DEFAULT '[]',
  summary_text          TEXT,
  summary_upto_seq      INTEGER NOT NULL DEFAULT 0,
  last_seq              INTEGER NOT NULL DEFAULT 0,
  pinned_at             INTEGER,
  archived_at           INTEGER,
  deleted_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_list ON rooms(deleted_at, archived_at, pinned_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS room_members (
  id            TEXT    PRIMARY KEY,
  room_id       TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id      TEXT    NOT NULL REFERENCES agents(id),
  display_name  TEXT    NOT NULL,
  role_kind     TEXT    NOT NULL DEFAULT 'member' CHECK (role_kind IN ('lead', 'chair', 'member')),
  role_prompt   TEXT    NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  joined_at     INTEGER NOT NULL,
  removed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, removed_at, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_single_lead ON room_members(room_id)
  WHERE role_kind = 'lead' AND removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_single_chair ON room_members(room_id)
  WHERE role_kind = 'chair' AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS room_messages (
  id               TEXT    PRIMARY KEY,
  room_id          TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  visible_seq      INTEGER NOT NULL,
  author_kind      TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'system', 'intake')),
  author_id        TEXT    NOT NULL,
  author_name      TEXT    NOT NULL,
  kind             TEXT    NOT NULL DEFAULT 'chat'
                   CHECK (kind IN ('chat', 'result', 'reply', 'summary', 'routing_notice', 'system_notice', 'intake_seed')),
  content          TEXT    NOT NULL,
  attachments_json TEXT    NOT NULL DEFAULT '[]',
  reply_to_msg_id  TEXT    REFERENCES room_messages(id) ON DELETE SET NULL,
  work_node_id     TEXT,
  visibility_scope TEXT    NOT NULL DEFAULT 'public' CHECK (visibility_scope IN ('public', 'private')),
  visible_to_json  TEXT    NOT NULL DEFAULT '[]',
  meta_json        TEXT    NOT NULL DEFAULT '{}',
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE(room_id, seq),
  UNIQUE(room_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_room_messages_seq ON room_messages(room_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_room_messages_visible_seq ON room_messages(room_id, visibility_scope, visible_seq);

CREATE TABLE IF NOT EXISTS work_nodes (
  id                     TEXT    PRIMARY KEY,
  room_id                TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  root_node_id           TEXT    NOT NULL,
  parent_node_id         TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL,
  supersedes_node_id     TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL,
  transferred_to_node_id TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL,
  request_msg_id         TEXT    REFERENCES room_messages(id) ON DELETE SET NULL,
  assignee_member_id     TEXT    NOT NULL REFERENCES room_members(id),
  assignee_agent_id      TEXT    NOT NULL REFERENCES agents(id),
  kind                   TEXT    NOT NULL
                         CHECK (kind IN ('turn', 'delegation', 'subtask', 'transfer', 'member_reply', 'routing', 'round_post', 'summary')),
  status                 TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN (
                           'queued', 'waiting_deps', 'waiting_lock', 'starting', 'running',
                           'waiting_children', 'awaiting_human', 'paused',
                           'completed', 'failed', 'cancelled'
                         )),
  superstep              INTEGER,
  lease_token            TEXT,
  instruction            TEXT    NOT NULL,
  expected_result        TEXT,
  workspace_mode         TEXT    NOT NULL DEFAULT 'shared-rw'
                         CHECK (workspace_mode IN ('read-only', 'shared-rw', 'worktree')),
  workspace_id           TEXT    REFERENCES workspaces(id) ON DELETE SET NULL,
  resources_json         TEXT    NOT NULL DEFAULT '[]',
  visibility_on_publish  TEXT    NOT NULL DEFAULT '{"scope":"public"}',
  driver_snapshot_json   TEXT    NOT NULL DEFAULT '{}',
  result_text            TEXT,
  result_json            TEXT,
  usage_json             TEXT,
  error_text             TEXT,
  attempt                INTEGER NOT NULL DEFAULT 1,
  depth                  INTEGER NOT NULL DEFAULT 0,
  delivered_at           INTEGER,
  idempotency_key        TEXT,
  created_at             INTEGER NOT NULL,
  started_at             INTEGER,
  ended_at               INTEGER,
  updated_at             INTEGER NOT NULL,
  UNIQUE(room_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_work_nodes_sched ON work_nodes(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_work_nodes_room ON work_nodes(room_id, status);
CREATE INDEX IF NOT EXISTS idx_work_nodes_root ON work_nodes(root_node_id);
CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_work_nodes_agent_active ON work_nodes(assignee_agent_id, status);

CREATE TABLE IF NOT EXISTS work_node_deps (
  node_id       TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_work_node_deps_rev ON work_node_deps(depends_on_id);

CREATE TABLE IF NOT EXISTS work_deliveries (
  id                  TEXT    PRIMARY KEY,
  room_id             TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  target_node_id      TEXT    NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  child_node_ids_json TEXT    NOT NULL,
  payload_text        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_deliveries_pending ON work_deliveries(status, created_at ASC);

CREATE TABLE IF NOT EXISTS node_events (
  id           TEXT    PRIMARY KEY,
  node_id      TEXT    NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('thinking', 'tool_start', 'tool_result', 'notice', 'error')),
  payload_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(node_id, attempt, seq)
);
CREATE INDEX IF NOT EXISTS idx_node_events_node ON node_events(node_id, attempt, seq ASC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                   TEXT    PRIMARY KEY,
  room_id              TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_member_id       TEXT    NOT NULL UNIQUE REFERENCES room_members(id) ON DELETE CASCADE,
  agent_id             TEXT    NOT NULL REFERENCES agents(id),
  driver_kind          TEXT    NOT NULL,
  daemon_session_id    TEXT,
  native_session_id    TEXT,
  config_hash          TEXT,
  last_delivered_seq   INTEGER NOT NULL DEFAULT 0,
  last_consumed_offset INTEGER NOT NULL DEFAULT 0,
  status               TEXT    NOT NULL DEFAULT 'cold'
                       CHECK (status IN ('cold', 'starting', 'ready', 'busy', 'hibernated', 'detached', 'crashed')),
  last_active_at       INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_daemon ON agent_sessions(daemon_session_id);

CREATE TABLE IF NOT EXISTS files (
  id            TEXT    PRIMARY KEY,
  sha256        TEXT    NOT NULL,
  filename      TEXT    NOT NULL,
  mime          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_key   TEXT    NOT NULL,
  backend_kind  TEXT    NOT NULL DEFAULT 'local',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);

CREATE TABLE IF NOT EXISTS file_refs (
  file_id     TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_type  TEXT    NOT NULL CHECK (owner_type IN ('message', 'inbox', 'room')),
  owner_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (file_id, owner_type, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_file_refs_owner ON file_refs(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS file_deletion_outbox (
  id           TEXT    PRIMARY KEY,
  sha256       TEXT    NOT NULL,
  storage_key  TEXT    NOT NULL,
  backend_kind TEXT    NOT NULL DEFAULT 'local',
  retry_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL UNIQUE,
  transport        TEXT    NOT NULL CHECK (transport IN ('stdio', 'http')),
  command          TEXT,
  args_json        TEXT    NOT NULL DEFAULT '[]',
  url              TEXT,
  env_refs_json    TEXT    NOT NULL DEFAULT '{}',
  header_refs_json TEXT    NOT NULL DEFAULT '{}',
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  source_type    TEXT    NOT NULL CHECK (source_type IN ('local', 'git')),
  source_uri     TEXT    NOT NULL,
  pinned_commit  TEXT,
  local_path     TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
`

export class CoreDatabase {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA temp_store = MEMORY')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`
    )
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
      | { v: number | null }
      | undefined
    const current = row?.v ?? 0
    if (current < 1) {
      this.transaction(() => {
        this.db.exec(MIGRATION_0001_SQL)
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(1, '0001_init', Date.now())
      })
    }
    if (current < 2) {
      this.transaction(() => {
        const cols = this.db.prepare('PRAGMA table_info(work_nodes)').all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === 'blocking_reason')) {
          this.db.exec('ALTER TABLE work_nodes ADD COLUMN blocking_reason TEXT')
        }
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(2, '0002_work_node_blocking_reason', Date.now())
      })
    }
    if (current < 3) {
      this.transaction(() => {
        const cols = this.db.prepare('PRAGMA table_info(work_nodes)').all() as Array<{ name: string }>
        if (!cols.some((c) => c.name === 'source_trust_level')) {
          this.db.exec("ALTER TABLE work_nodes ADD COLUMN source_trust_level TEXT NOT NULL DEFAULT 'trusted'")
        }
        this.db.exec(`
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  secret_hash  TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 100,
  source_filter TEXT,
  match_type    TEXT    NOT NULL CHECK (match_type IN ('keyword', 'regex', 'meta_equals', 'always')),
  match_expr    TEXT    NOT NULL DEFAULT '',
  allow_write   INTEGER NOT NULL DEFAULT 0 CHECK (allow_write IN (0, 1)),
  action_json   TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_instances (
  id            TEXT    PRIMARY KEY,
  plugin_id     TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  config_json   TEXT    NOT NULL DEFAULT '{}',
  cursor        TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_sync_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_items (
  id                    TEXT    PRIMARY KEY,
  source                TEXT    NOT NULL,
  source_instance_id    TEXT    NOT NULL DEFAULT 'default',
  external_key          TEXT    NOT NULL,
  external_url          TEXT,
  author_name           TEXT    NOT NULL,
  title                 TEXT    NOT NULL,
  content               TEXT    NOT NULL,
  attachments_json      TEXT    NOT NULL DEFAULT '[]',
  status                TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'ignored')),
  assigned_room_id      TEXT    REFERENCES rooms(id) ON DELETE SET NULL,
  assigned_root_node_id TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL,
  matched_rule_id       TEXT    REFERENCES routing_rules(id) ON DELETE SET NULL,
  reply_target_json     TEXT,
  raw_meta_json         TEXT    NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(source, source_instance_id, external_key)
);
CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status, created_at DESC);

CREATE TABLE IF NOT EXISTS background_jobs (
  id              TEXT    PRIMARY KEY,
  job_type        TEXT    NOT NULL CHECK (job_type IN ('sync_source', 'backup_snapshot', 'routine_tick')),
  payload_json    TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  run_after       INTEGER NOT NULL DEFAULT 0,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT    UNIQUE,
  error_text      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id            TEXT    PRIMARY KEY,
  room_id       TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  work_node_id  TEXT    NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  tool_name     TEXT    NOT NULL,
  args_json     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  decision_note TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
        `)
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(3, '0003_v01c_inbox_roundtable', Date.now())
      })
    }
    if (current < 4) {
      this.transaction(() => {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  job_type     TEXT    NOT NULL CHECK (job_type IN ('sync_source', 'backup_snapshot', 'routine_tick')),
  cron_expr    TEXT    NOT NULL,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at  INTEGER NOT NULL,
  last_run_at  INTEGER,
  last_job_id  TEXT    REFERENCES background_jobs(id) ON DELETE SET NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at ASC);
CREATE INDEX IF NOT EXISTS idx_background_jobs_due ON background_jobs(status, run_after ASC);
        `)
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(4, '0004_v02a_cron_schedules', Date.now())
      })
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}
