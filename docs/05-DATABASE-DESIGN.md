# 05. 数据库与存储设计文档（Database & Storage Design）

> **文档状态**：v2.0 定稿（采用 Node 22+ 原生 `node:sqlite`；已修复评审指出的 `agent_sessions` 席位主键、`work_nodes` 单一真相源、`work_node_deps`、`work_deliveries`、`node_events`、`terminal_sessions`、`visible_seq`、`file_refs`、`auth_*` 等全部缺口与不一致）

---

## 1. 运行时引擎与存储分层

- **主状态库**：Node 22+ 原生 `node:sqlite`（`DatabaseSync`），零 `better-sqlite3` C++ 编译依赖，同步事务天然适配 Per-Room Actor 零 `await` 竞态模型。
- **初始化 PRAGMA**：
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
  ```
- **Blob 大对象存储**：`~/.myagents/blobs/<aa>/<bb>/<sha256>`（**不带扩展名**，相同内容不同文件名严格只存一份物理文件）；由 `file_refs` + `file_deletion_outbox` 保证引用计数与删除最终一致。
- **异步备份**：低峰期通过 `VACUUM INTO` 导出一致性 SQLite 快照，并异步分发至 `BackupAdapter`（与 Blob/工作区保持最终一致，文档明确不承诺跨文件系统原子快照）。

---

## 2. ER 关系总览

```mermaid
erDiagram
  auth_config ||--o{ auth_sessions : "issues"
  model_providers ||--o{ agents : "supplies LLM"
  workspaces ||--o{ agents : "default private"
  workspaces ||--o{ rooms : "primary workspace"
  workspaces ||--o{ work_nodes : "execution / worktree"
  workspaces ||--o{ terminal_sessions : "cwd"

  rooms ||--o{ room_members : "fixed roster"
  agents ||--o{ room_members : "fills seat"
  room_members ||--|| agent_sessions : "1:1 strict serial"
  rooms ||--o{ room_messages : "seq & visible_seq"
  rooms ||--o{ work_nodes : "single source of truth"
  rooms ||--o{ work_deliveries : "2-phase child delivery"

  work_nodes ||--o{ work_node_deps : "DAG edges"
  work_nodes ||--o{ node_events : "tool & step timeline"
  work_nodes ||--o{ approval_requests : "HITL (v0.2+)"

  files ||--o{ file_refs : "ref counting"
  files ||--o{ file_deletion_outbox : "GC outbox"
```

---

## 3. 完整 SQLite 表结构 DDL（22 张表，分期按需激活）

> 首期迁移脚本 `0001_init.sql` 一次性建好核心主干表（表 1~15），二三期按增量迁移 `0002_*.sql` 追加收件箱与生态表（表 16~22），保证表结构干净、零冗余。

### 3.1 元数据与极简登录安全基线（`0001_init.sql` · `[v0.1a]`）

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL
);

-- 极简账号配置（默认 admin / admin，scryptSync 加盐哈希）
CREATE TABLE auth_config (
  id                  TEXT    PRIMARY KEY DEFAULT 'default',
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL, -- "scrypt:<saltHex>:<hashHex>"
  is_default_password INTEGER NOT NULL DEFAULT 1 CHECK (is_default_password IN (0, 1)),
  updated_at          INTEGER NOT NULL
);

-- 登录会话表（重启 core 不掉登录态）
CREATE TABLE auth_sessions (
  token_hash  TEXT    PRIMARY KEY,      -- SHA-256(sessionToken)
  username    TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
```

### 3.2 模型服务商、工作区、Agent 与终端（`0001_init.sql` · `[v0.1a]`）

```sql
CREATE TABLE model_providers (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL CHECK (kind IN ('openai-compat', 'anthropic', 'ollama', 'custom')),
  base_url       TEXT    NOT NULL,
  api_key_ref    TEXT,                  -- 经 SecretProvider 解析
  default_model  TEXT    NOT NULL,
  models_json    TEXT    NOT NULL DEFAULT '[]',
  extra_json     TEXT    NOT NULL DEFAULT '{}', -- headers / timeoutMs / maxRetries
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id                  TEXT    PRIMARY KEY,
  kind                TEXT    NOT NULL CHECK (kind IN ('agent_private', 'project', 'git_worktree', 'shared')),
  name                TEXT    NOT NULL,
  root_path           TEXT    NOT NULL UNIQUE,
  is_git              INTEGER NOT NULL DEFAULT 0 CHECK (is_git IN (0, 1)),
  git_common_dir      TEXT,             -- 归一化 Git common dir，供 RepoMutex 使用
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
CREATE INDEX idx_workspaces_kind ON workspaces(kind);
CREATE INDEX idx_workspaces_owner ON workspaces(owner_type, owner_id);

CREATE TABLE agents (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  bio                   TEXT    NOT NULL DEFAULT '',
  avatar_json           TEXT    NOT NULL DEFAULT '{}',
  system_prompt         TEXT    NOT NULL DEFAULT '',
  driver_kind           TEXT    NOT NULL CHECK (driver_kind IN ('builtin', 'claude', 'acp', 'codex', 'custom')),
  -- provider_id 为唯一关联源，driver_config_json 不再重复存 providerId
  provider_id           TEXT    REFERENCES model_providers(id) ON DELETE SET NULL,
  driver_config_json    TEXT    NOT NULL DEFAULT '{}', -- { model, temperature?, maxSteps?, cliPath?, effort?, dialect? }
  default_workspace_id  TEXT    NOT NULL REFERENCES workspaces(id),
  permission_mode       TEXT    NOT NULL DEFAULT 'workspace-write'
                        CHECK (permission_mode IN ('read-only', 'workspace-write', 'full')),
  isolation_mode        TEXT    NOT NULL DEFAULT 'standard'
                        CHECK (isolation_mode IN ('standard', 'isolated-home', 'lockdown')),
  skill_ids_json        TEXT    NOT NULL DEFAULT '[]',
  mcp_server_ids_json   TEXT    NOT NULL DEFAULT '[]',
  max_running_turns     INTEGER NOT NULL DEFAULT 2 CHECK (max_running_turns >= 1), -- 创建 builtin 时应用层默认设为 5
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_agents_active ON agents(archived_at);

-- Web 终端持久化归属表（支持重启 core 自动对账恢复）
CREATE TABLE terminal_sessions (
  id                TEXT    PRIMARY KEY,
  workspace_id      TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daemon_session_id TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL DEFAULT 'Terminal',
  status            TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'exited')),
  exit_code         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_terminal_sessions_ws ON terminal_sessions(workspace_id, status);
```

### 3.3 统一协作核心（`0001_init.sql` · `[v0.1a 启用 single，v0.1b/c 激活多 Agent]`）

```sql
CREATE TABLE rooms (
  id                    TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL,
  purpose               TEXT    NOT NULL DEFAULT '',
  strategy_id           TEXT    NOT NULL, -- 'single' | 'open-channel' | 'roundtable' | ...
  strategy_config_json  TEXT    NOT NULL DEFAULT '{}',
  strategy_state_json   TEXT    NOT NULL DEFAULT '{}', -- 仅通过 Reducer 归约更新
  -- 运行状态与 archived_at 彻底解耦
  state                 TEXT    NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'running', 'pausing', 'paused', 'done')),
  primary_workspace_id  TEXT    REFERENCES workspaces(id) ON DELETE SET NULL,
  shared_memories_json  TEXT    NOT NULL DEFAULT '[]',
  summary_text          TEXT,
  summary_upto_seq      INTEGER NOT NULL DEFAULT 0,
  last_seq              INTEGER NOT NULL DEFAULT 0,    -- Room 单调递增序号分配器
  pinned_at             INTEGER,
  archived_at           INTEGER,
  deleted_at            INTEGER,                       -- 软删标记，配合停进程 Saga 杜绝孤儿进程
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_rooms_list ON rooms(deleted_at, archived_at, pinned_at DESC, updated_at DESC);

CREATE TABLE room_members (
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
CREATE INDEX idx_room_members_room ON room_members(room_id, removed_at, position);
-- 保证同一 Room 至多存在 1 个活跃 lead（或 1 个活跃 chair）
CREATE UNIQUE INDEX idx_room_single_lead ON room_members(room_id)
  WHERE role_kind = 'lead' AND removed_at IS NULL;
CREATE UNIQUE INDEX idx_room_single_chair ON room_members(room_id)
  WHERE role_kind = 'chair' AND removed_at IS NULL;

CREATE TABLE room_messages (
  id               TEXT    PRIMARY KEY,
  room_id          TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  visible_seq      INTEGER NOT NULL,     -- public 时等于 seq；private 时为 0，Reveal 时推进为新 last_seq
  author_kind      TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'system', 'intake')),
  author_id        TEXT    NOT NULL,     -- author_kind='agent' 时为 room_member_id
  author_name      TEXT    NOT NULL,
  kind             TEXT    NOT NULL DEFAULT 'chat'
                   CHECK (kind IN ('chat', 'result', 'reply', 'summary', 'routing_notice', 'system_notice', 'intake_seed')),
  content          TEXT    NOT NULL,
  attachments_json TEXT    NOT NULL DEFAULT '[]',
  reply_to_msg_id  TEXT    REFERENCES room_messages(id) ON DELETE SET NULL,
  work_node_id     TEXT,
  visibility_scope TEXT    NOT NULL DEFAULT 'public' CHECK (visibility_scope IN ('public', 'private')),
  visible_to_json  TEXT    NOT NULL DEFAULT '[]',      -- private 时允许查看的 room_member_id[]
  meta_json        TEXT    NOT NULL DEFAULT '{}',
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE(room_id, seq),
  UNIQUE(room_id, idempotency_key)
);
CREATE INDEX idx_room_messages_seq ON room_messages(room_id, seq DESC);
CREATE INDEX idx_room_messages_visible_seq ON room_messages(room_id, visibility_scope, visible_seq);

-- 唯一任务调度真相源（不再由 job_queue 镜像）
CREATE TABLE work_nodes (
  id                     TEXT    PRIMARY KEY,
  room_id                TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  root_node_id           TEXT    NOT NULL,
  parent_node_id         TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL,
  supersedes_node_id     TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL, -- Reassign 审计链
  transferred_to_node_id TEXT    REFERENCES work_nodes(id) ON DELETE SET NULL, -- Transfer 审计链
  request_msg_id         TEXT    REFERENCES room_messages(id) ON DELETE SET NULL,
  assignee_member_id     TEXT    NOT NULL REFERENCES room_members(id),         -- 协作层一等身份
  assignee_agent_id      TEXT    NOT NULL REFERENCES agents(id),               -- 冗余供并发配额统计
  kind                   TEXT    NOT NULL
                         CHECK (kind IN ('turn', 'delegation', 'subtask', 'transfer', 'member_reply', 'routing', 'round_post', 'summary')),
  status                 TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN (
                           'queued', 'waiting_deps', 'waiting_lock', 'starting', 'running',
                           'waiting_children', 'awaiting_human', 'paused',
                           'completed', 'failed', 'cancelled'
                         )),
  superstep              INTEGER,                     -- Super-step 策略超步编号
  lease_token            TEXT,                        -- Scheduler CAS 预留租约，取消穿透复核
  instruction            TEXT    NOT NULL,
  expected_result        TEXT,
  workspace_mode         TEXT    NOT NULL DEFAULT 'shared-rw'
                         CHECK (workspace_mode IN ('read-only', 'shared-rw', 'worktree')),
  workspace_id           TEXT    REFERENCES workspaces(id) ON DELETE SET NULL,
  resources_json         TEXT    NOT NULL DEFAULT '[]',
  visibility_on_publish  TEXT    NOT NULL DEFAULT '{"scope":"public"}',
  driver_snapshot_json   TEXT    NOT NULL DEFAULT '{}', -- 记录执行时的实际模型/驱动快照，便于成本核算
  result_text            TEXT,
  result_json            TEXT,
  usage_json             TEXT,
  error_text             TEXT,
  attempt                INTEGER NOT NULL DEFAULT 1,
  depth                  INTEGER NOT NULL DEFAULT 0,
  delivered_at           INTEGER,                     -- 结果是否已通过 work_deliveries 投递给父节点
  idempotency_key        TEXT,
  created_at             INTEGER NOT NULL,
  started_at             INTEGER,
  ended_at               INTEGER,
  updated_at             INTEGER NOT NULL,
  UNIQUE(room_id, idempotency_key)
);
CREATE INDEX idx_work_nodes_sched ON work_nodes(status, created_at ASC);
CREATE INDEX idx_work_nodes_room ON work_nodes(room_id, status);
CREATE INDEX idx_work_nodes_root ON work_nodes(root_node_id);
CREATE INDEX idx_work_nodes_parent ON work_nodes(parent_node_id);
CREATE INDEX idx_work_nodes_agent_active ON work_nodes(assignee_agent_id, status);

-- DAG 前置依赖关系表（O(1) 反向查询下游节点）
CREATE TABLE work_node_deps (
  node_id       TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, depends_on_id)
);
CREATE INDEX idx_work_node_deps_rev ON work_node_deps(depends_on_id);

-- 两阶段结果投递表（崩溃重启不漏唤醒、不重复唤醒）
CREATE TABLE work_deliveries (
  id                  TEXT    PRIMARY KEY,
  room_id             TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  target_node_id      TEXT    NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  child_node_ids_json TEXT    NOT NULL,
  payload_text        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER
);
CREATE INDEX idx_work_deliveries_pending ON work_deliveries(status, created_at ASC);

-- 过程事件持久化表（工具调用、思考块、状态通知，刷新页面可完整还原）
CREATE TABLE node_events (
  id           TEXT    PRIMARY KEY,
  node_id      TEXT    NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('thinking', 'tool_start', 'tool_result', 'notice', 'error')),
  payload_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(node_id, attempt, seq)
);
CREATE INDEX idx_node_events_node ON node_events(node_id, attempt, seq ASC);

-- Agent 会话映射表（严格按 room_member_id 1:1 绑定，单席位串行）
CREATE TABLE agent_sessions (
  id                   TEXT    PRIMARY KEY,
  room_id              TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_member_id       TEXT    NOT NULL UNIQUE REFERENCES room_members(id) ON DELETE CASCADE,
  agent_id             TEXT    NOT NULL REFERENCES agents(id),
  driver_kind          TEXT    NOT NULL,
  daemon_session_id    TEXT,
  native_session_id    TEXT,
  config_hash          TEXT,                         -- 热会话配置漂移检测
  last_delivered_seq   INTEGER NOT NULL DEFAULT 0,   -- 配合 room_messages.visible_seq 拉增量
  last_consumed_offset INTEGER NOT NULL DEFAULT 0,   -- 配合 daemon output-buffer 精准对账
  status               TEXT    NOT NULL DEFAULT 'cold'
                       CHECK (status IN ('cold', 'starting', 'ready', 'busy', 'hibernated', 'detached', 'crashed')),
  last_active_at       INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_agent_sessions_daemon ON agent_sessions(daemon_session_id);
```

### 3.4 附件、能力与后续阶段扩展表（`0001_init.sql` / `0002_v01bc.sql`）

```sql
-- 15. 附件文件表（storage_key 不带扩展名，按 sha256 物理去重）
CREATE TABLE files (
  id            TEXT    PRIMARY KEY,
  sha256        TEXT    NOT NULL,
  filename      TEXT    NOT NULL,
  mime          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_key   TEXT    NOT NULL,                    -- e.g. "ab/cd/<sha256>"
  backend_kind  TEXT    NOT NULL DEFAULT 'local',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_files_sha256 ON files(sha256);

-- 16. 统一附件引用计数表（彻底解决 GC 删不掉的漏洞）
CREATE TABLE file_refs (
  file_id     TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_type  TEXT    NOT NULL CHECK (owner_type IN ('message', 'inbox', 'room')),
  owner_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (file_id, owner_type, owner_id)
);
CREATE INDEX idx_file_refs_owner ON file_refs(owner_type, owner_id);

-- 17. 附件安全删除 Outbox（仅当同 sha256 零 file_refs 且过保护期后删物理 Blob）
CREATE TABLE file_deletion_outbox (
  id           TEXT    PRIMARY KEY,
  sha256       TEXT    NOT NULL,
  storage_key  TEXT    NOT NULL,
  backend_kind TEXT    NOT NULL DEFAULT 'local',
  retry_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

-- 18. 外部 MCP 服务器 & 19. Skill 仓库
CREATE TABLE mcp_servers (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL UNIQUE,          -- 禁止 'myagents'
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

CREATE TABLE skills (
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

-- === 以下表在 v0.1c / v0.2+ 激活（协议与迁移脚本预留） ===

-- 20. 通用 Webhook 端点配置 & 21. 统一收件箱 & 路由规则 & 插件实例
CREATE TABLE webhooks (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  secret_hash  TEXT    NOT NULL,                     -- X-Webhook-Secret 校验
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   INTEGER NOT NULL
);

CREATE TABLE routing_rules (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 100,
  source_filter TEXT,
  match_type    TEXT    NOT NULL CHECK (match_type IN ('keyword', 'regex', 'meta_equals', 'always')),
  match_expr    TEXT    NOT NULL DEFAULT '',
  allow_write   INTEGER NOT NULL DEFAULT 0 CHECK (allow_write IN (0, 1)), -- 默认 0 强制只读降权防注入
  action_json   TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE inbox_items (
  id                 TEXT    PRIMARY KEY,
  source             TEXT    NOT NULL,
  source_instance_id TEXT    NOT NULL DEFAULT 'default',
  external_key       TEXT    NOT NULL,
  external_url       TEXT,
  author_name        TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  content            TEXT    NOT NULL,
  attachments_json   TEXT    NOT NULL DEFAULT '[]',
  status             TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'ignored')),
  assigned_room_id   TEXT    REFERENCES rooms(id) ON DELETE SET NULL,
  assigned_root_node_id TEXT REFERENCES work_nodes(id) ON DELETE SET NULL, -- 精准跟踪单次处理完成状态
  matched_rule_id    TEXT    REFERENCES routing_rules(id) ON DELETE SET NULL,
  reply_target_json  TEXT,
  raw_meta_json      TEXT    NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(source, source_instance_id, external_key)
);

-- 22. 非节点类后台任务队列（仅 sync_source / backup_snapshot / routine_tick）与审批/定时预留
CREATE TABLE background_jobs (
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

CREATE TABLE approval_requests (
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
```

---

## 4. 关键事务与数据完整性规约

1. **Per-Room 同步原子事务**：写入 `room_messages`（原子递增 `rooms.last_seq`）、归约更新 `rooms.strategy_state_json`、写入新 `work_nodes` 与 `work_node_deps`、写入 `work_deliveries`，全部在**同一个 `node:sqlite` 同步事务**内提交，绝不跨 `await`。
2. **房间删除 Saga 流程**：调用 `rooms.delete` 时先标 `deleted_at` 阻断新调度 → 中断并释放关联的 `daemon` 外部 CLI 进程与终端 → 将关联 `file_refs` 清理并入 `file_deletion_outbox` → 最后物理删除行，杜绝孤儿进程。
3. **流式过程事件落盘策略**：Token 增量仅经内存节流走 WS `room.streamDelta` 推送，**绝不逐 Token 写 SQLite**；仅在工具开始/结束、思考块完成、回合终结时批量写入 `node_events` 与 `room_messages`。
4. **不可逆增量迁移纪律**：每个正式版本只增不改历史迁移 SQL，所有迁移脚本须配套数据保留与升级测试。
