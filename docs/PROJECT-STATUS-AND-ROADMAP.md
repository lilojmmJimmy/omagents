# MyAgents Project Status & Next-Phase Roadmap

> **Current Baseline**: `v0.2b` (`T-101`, `T-103`, `T-301` [Email & GitHub], `T-302` delivered alongside `v0.2a`; all `P3` items deferred)  
> **Updated**: `2026-11-20`  
> **Scope**: Single entry point summarizing delivered capabilities, verified quality baseline, and remaining deferred `P3` backlog.

---

## 1. Current State

MyAgents is a server-side multi-agent orchestration middleware and React web workspace platform with zero C++ dependencies in `core` (Node.js >= 22.13 native `node:sqlite`), launched via `pnpm start`:

1. **Dual-Track Single-Agent Execution & Hot-Restart Survival (`v0.1a`)**
2. **5-Layer Agent Isolation, Deadlock-Free `open-channel` Collaboration & Git Worktree Isolation (`v0.1b`)**
3. **Pregel Super-step `roundtable`, Unified Inbox / Webhooks / `SourcePlugin` Lockdown, and Full `CodexCliDriver` Support (`v0.1c+`)**
4. **External MCP Servers, Skill Registry, and Background Jobs / Cron Scheduler (`v0.2a`, `T-201` & `T-202`)**
5. **Attachment Blob Store (Manual Double-Confirmed Cleanup), Email / GitHub Channels, Inbox Replies, and Usage Analytics (`v0.2b`, `T-101`, `T-103`, `T-301`, `T-302`)**

---

## 2. Delivered Capabilities Summary

### 2.1 Stage 0: Architecture & Schema Baseline
- Finalized core design specifications in [01-PRD-FEATURES.md](./01-PRD-FEATURES.md), [02-ARCHITECTURE.md](./02-ARCHITECTURE.md), [03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md), [04-API-PROTOCOL.md](./04-API-PROTOCOL.md), and [05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md) (review notes in [DESIGN-REVIEW.md](./DESIGN-REVIEW.md)).
- Established core invariants: per-room synchronous SQLite transactions, fixed-roster collaboration without ad-hoc subagents, `room_member_id` seat serialization, `WorkNode` single source of truth, two-phase `work_deliveries`, and thin detached `daemon` process hosting.

### 2.2 Stage 1: `v0.1a` Single-Agent Foundation & Workbench
- **Workspace Packages**: `packages/protocol` (browser-safe Zod contracts + `@myagents/protocol/node`), `packages/plugin-sdk`, `packages/daemon` (`pipe-session`, `pty-session`, ring `OutputBuffer`), `packages/core`, and `packages/web` (React 19 + Vite 6 + Tailwind CSS v4 + Zustand + `@xterm/xterm`).
- **Security Baseline**: `admin/admin` login (`scryptSync` salted hashes), Settings password rotation, `HttpOnly` Cookie / Bearer auth, and WebSocket `Origin` verification.
- **Drivers**: `BuiltinDriver` (OpenAI-compatible streaming ReAct + 7 workspace tools + `<think>` CoT) and `ClaudeCodeDriver` (`stream-json` control handshake, `nativeSessionId` resume, `.jsonl` session discovery).
- **Workspaces & Web Workbench**: Agent private workspaces and local Git repo mounting, `path-guard.ts` traversal/symlink containment, `expectedMtimeMs` optimistic file locking, HTTP upload/download, Git diff, `/ws/terminal/:id` surviving `core` restarts, resizable 3-pane layout, CoT collapse cards, and token/TTFT/context metrics.

### 2.3 Stage 2: `v0.1b` 5-Layer Isolation & `open-channel` Collaboration
- **5-Layer Isolation (`environment-isolator.ts`)**: `spawnPipeClean` env sanitization, `isolated-home` / `lockdown` private `CLAUDE_CONFIG_DIR`, gated `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` for bound `providerId`, dual-layer subagent blocking (`Agent`/`Task`), `lockdown`/`fenced-ro` tool rules, and 16-char SHA-256 `configHash` drift detection.
- **`open-channel` Engine (`collab-engine.ts`, `open-channel-strategy.ts`, `context-builder.ts`)**: Deterministic `@member` / `@everyone` / `@Lead` routing (including CJK no-space prefix matching), `waiting_children` lock release with two-phase `work_deliveries`, DAG dependency resolution (`work_node_deps`), loop guardrails, `paused` room invariants, and cascade node controls (`stop`, `continue`, `cancel`, `retry`, `reassign`).
- **Parallel Git Worktrees & RW Locks (`worktree-service.ts`, `rw-lock.ts`)**: `RepoMutex` serialized worktree creation/cleanup, read-only worktree inheritance for reviewers, and write-preferring RW locks exempting isolated worktrees.
- **Restart-Resilient Stdio MCP Bridge (`packages/core/src/mcp/`)**: Single schema source (`collab-tools.json`) + `mcp-bridge.mjs` dynamically reading `<home>/run/core.json` and authenticating via `internalToken` across `core` restarts.

### 2.4 Stage 3: `v0.1c+` Roundtable, Unified Inbox, and Codex CLI Wrap-up
- **SQLite Migration `v3`**: Added `work_nodes.source_trust_level` and tables `webhooks`, `routing_rules`, `plugin_instances`, `inbox_items`, `background_jobs`, and `approval_requests`.
- **Pregel Super-step Roundtable (`roundtable-strategy.ts`)**: Pure reducer state, private round-1 blind posts (`visibilityScope: 'private'`) revealed atomically at superstep barriers (`room.messagesRevealed`), anonymous masking (`Member A/B/C` style anonymization), mid-discussion human interjection, partial-failure pause & recovery, Chair convergence summaries, and `rooms.handoff` preserving `sharedMemories`.
- **Unified Inbox & Webhooks (`inbox-service.ts`, `plugin-manager.ts`, `http-server.ts`)**: Isolated Fastify `/webhooks` raw `Buffer` scope, `generic-webhook` and HMAC-SHA256 `github-webhook` `SourcePlugin` implementations, idempotent deduplication, deterministic routing rules defaulting to `allowWrite = false` (`lockdown`), manual item creation/assignment, and automatic resolution on root node completion.
- **Codex & ACP Drivers (`cli-drivers.ts`, `daemon-protocol.ts` v2, `pipe-session.ts`)**:
  - Daemon protocol v2 (`stdinData`, `closeStdin`, `endInput`) and automatic idle daemon upgrade in `DaemonClient`.
  - `CodexCliDriver`: prompt delivered via stdin with EOF (`-`), `--skip-git-repo-check`, explicit `--sandbox read-only` / `workspace-write` / `--dangerously-bypass-approvals-and-sandbox`, `--ignore-user-config` + `--ignore-rules` isolation, native `thread_id` capture and `codex exec resume` with automatic fresh-`exec` fallback, dynamic MCP injection (`-c mcp_servers.<name>.*`), and lockdown MCP tool scoping (`collab_history`, `collab_publish`).
  - `AcpCliDriver`: `closeStdin: true`, `permissionMode: 'read-only'` enforcement, and single-chat `[Conversation History]` fallback in `combinePrompt`.
- **Latest-Turn Failure Tracking**: `pickLatestRetryableNode` (`packages/protocol/src/room.ts`) and scoped `RoomDetail.hasFailedNode` (`collab-engine.ts`) ensure retry banners and sidebar error indicators clear once newer turns succeed.

### 2.5 Stage 4: `v0.2a` Ecosystem Extensions & Background Scheduler (`T-201`, `T-202`)
- **SQLite Migration `v4` (`0004_v02a_cron_schedules`)**: Added `scheduled_jobs` table (`cron_expr`, `next_run_at`, `last_run_at`, `last_job_id`, `last_error`) and due-scan indexes (`idx_scheduled_jobs_due`, `idx_background_jobs_due`) while deferring `T-203` HITL wiring.
- **T-201 External MCP Servers & Skill Registry (`extensions.ts`, `mcp-client.ts`, `mcp-registry.ts`, `skill-registry.ts`)**:
  - Added `McpClient` supporting both `stdio` (via `planLaunch` + `createNdjsonParser`) and Streamable HTTP (`json` / SSE responses, `Mcp-Session-Id`) with `initialize`, `notifications/initialized`, paginated `listTools`, and `callTool`.
  - Added `McpRegistryService` with secret masking (`envKeys` / `headerKeys` instead of returning secrets over RPC), reserved name `'myagents'` guard, agent cascade cleanup on delete, live `probe`, and `writeRoomMemberMcpConfig` external server merging alongside collab tools.
  - Added `SkillRegistryService` for `local` paths and `git` repositories (cloned via `planLaunch`, commit hash pinning, safe `resolveContainedPath` cleanup, bounded `loadPromptSection` with 12-char `skillsHash` drift detection).
  - Wired multi-driver runtime injection across `BuiltinDriver` (external MCP tool execution bridged as `mcp__<server>__<tool>` + `Redactor` secret scrubbing), `ClaudeCodeDriver` (`--append-system-prompt` + merged MCP config), and `CodexCliDriver` (`combinePrompt` skills block + dynamic `-c mcp_servers.*` flags including `http_headers`), enforcing zero external MCP exposure in `lockdown` isolation mode.
  - Added [ExtensionsView.tsx](../packages/web/src/components/ExtensionsView.tsx) and capability checkboxes / inline editor in [AgentsView.tsx](../packages/web/src/components/AgentsView.tsx).
- **T-202 Background Jobs & Cron Scheduler (`cron.ts`, `job-scheduler.ts`, `builtin-handlers.ts`)**:
  - Added 5-field cron parser and next-run calculator (`computeNextCronRun`) validating field bounds and rejecting impossible wildcard calendar dates (e.g. Feb 31).
  - Added `JobSchedulerService` with startup crash recovery (`running -> pending`), transactional due schedule materialization (`sched:<id>:<next_run_at>` idempotency key), atomic job claiming, exponential backoff retries, terminal failure propagation to `scheduled_jobs.last_error`, and manual `triggerScheduleNow`.
  - Registered built-in handlers: `sync_source` (pull-based `SourcePlugin` ingestion), `routine_tick` (scheduled single-agent check defaulting to `read-only` unless `allowWrite: true`), and `backup_snapshot` (consistent SQLite `VACUUM INTO` snapshots + configurable retention pruning).
  - Wired RPC endpoints (`jobs.*`, `schedules.*`), real-time WebSocket `jobs.updated` notifications, and [JobsView.tsx](../packages/web/src/components/JobsView.tsx).

### 2.6 Stage 5: `v0.2b` Attachments, Email/GitHub Channels, Inbox Replies & Usage Analytics (`T-101`, `T-103`, `T-301`, `T-302`)
- **T-101 Attachment Blob Storage & Manual User Cleanup (`blob-service.ts`, `attachments.ts`)**:
  - Content-addressed SHA-256 blob storage under `~/.myagents/blobs/<aa>/<bb>/<sha256>` with transactional `file_refs` (`message`, `inbox`, `room`) and `file_deletion_outbox` queuing when ref counts reach zero.
  - Wired HTTP multipart upload (`POST /api/blobs/upload`) and XSS-safe download/preview (`GET /api/blobs/:fileId` with `X-Content-Type-Options: nosniff`, `inline` allowed only for safe raster images), [ChatView.tsx](../packages/web/src/components/ChatView.tsx) composer attachments, and automatic `[Attached Files]` context injection into agent turns in [collab-engine.ts](../packages/core/src/collab/collab-engine.ts).
  - Intentionally omits scheduled automatic blob GC: [SettingsView.tsx](../packages/web/src/components/SettingsView.tsx) provides a manual **Clean Up Unreferenced Blobs** action protected by a two-step double confirmation modal (`blobs.purgeUnreferenced` requiring `{ confirm: true }`).
- **T-103 & T-301 Email (IMAP/SMTP) & GitHub Plugins + Outbound Replies**:
  - Added pure-JS [email-plugin.ts](../packages/core/src/inbox/plugins/email-plugin.ts) (`imapflow` + `mailparser` + `nodemailer`) for provider-agnostic IMAP polling (with attachment ingestion into `BlobService` and cursor tracking) and threaded SMTP replies (`In-Reply-To`, `References`).
  - Enhanced [github-plugin.ts](../packages/core/src/inbox/plugins/github-plugin.ts) (`github-webhook`) with REST API PAT issue/PR polling and outbound issue/PR comment replies while preserving HMAC-SHA256 webhook intake.
  - Added plugin secret masking (`••••••••`) and update-time secret preservation in [plugin-manager.ts](../packages/core/src/inbox/plugin-manager.ts), routing rule target workspace selection + manual `Sync Now` / `Reply` / `Delete` controls in [InboxView.tsx](../packages/web/src/components/InboxView.tsx), and outbound reply callbacks upon item resolution (`setStatus('resolved')` & `onRootNodeSettled`).
- **T-302 Global Usage & Cost Analytics (`usage-service.ts`, `analytics.ts`, `AnalyticsView.tsx`)**:
  - Aggregated `work_nodes.usage_json` across `24h`, `7d`, `30d`, and `all` time windows with KPI totals, time-series usage trend chart, and breakdowns by model, agent, room, and recent runs in [AnalyticsView.tsx](../packages/web/src/components/AnalyticsView.tsx).

### 2.7 Directory Overview

| Path | Responsibility |
| --- | --- |
| `packages/protocol/src/` | Zod schemas (`models.ts`, `room.ts`, `collab.ts`, `inbox.ts`, `extensions.ts`, `attachments.ts`, `analytics.ts`, `rpc.ts`) and Node utilities (`node/`) |
| `packages/plugin-sdk/src/` | Extension SPI (`SourcePlugin`, `InboundEnvelope`, `PluginContext`, `StrategyPlugin`) |
| `packages/daemon/src/` | Thin detached PTY/pipe session host (`pipe-session.ts`, `pty-session.ts`, `session-host.ts`) |
| `packages/core/src/analytics/` | `UsageAnalyticsService` aggregating token usage, cost, and latency |
| `packages/core/src/collab/` | `CollabEngine`, strategies (`single`, `open-channel`, `roundtable`), `context-builder.ts`, `rw-lock.ts` |
| `packages/core/src/inbox/` | `InboxService`, `PluginManager`, `plugins/email-plugin.ts`, `plugins/github-plugin.ts` |
| `packages/core/src/jobs/` | `cron.ts`, `JobSchedulerService`, `registerBuiltInJobHandlers` (`sync_source`, `routine_tick`, `backup_snapshot`) |
| `packages/core/src/runtime/` | `BuiltinDriver`, `ClaudeCodeDriver`, `CodexCliDriver`, `AcpCliDriver`, `AgentEnvironmentIsolator`, `SkillRegistryService`, `EnvCheckService` |
| `packages/core/src/mcp/` | `collab-tools.json`, `mcp-bridge.mjs`, `mcp-config.ts`, `mcp-client.ts`, `McpRegistryService` |
| `packages/core/src/workspace/` | `WorkspaceService`, `WorktreeService`, `GitService`, `TerminalService`, `path-guard.ts` |
| `packages/core/src/storage/` | `CoreDatabase` (`node:sqlite` WAL + forward migrations `v1`-`v4`) and `BlobService` |
| `packages/core/src/security/` | `AuthService` and extension hooks (`hooks.ts`) |
| `packages/core/src/transport/` | Fastify HTTP server (`/webhooks` raw scope, `/api/blobs/*`) and WS `/rpc` router |
| `packages/web/src/` | React 19 workbench (`App.tsx`, `store/app-store.ts`, `components/`) |
| `scripts/` | `dev.mjs`, `start.mjs`, `smoke.mjs`, `verify-claude-live.mjs`, `verify-claude-v01b-live.mjs` |
| `docs/` | Architecture specifications (`01`-`05`), design review, and milestone test reports |

---

## 3. Verified Quality Baseline

Latest verification results after `v0.2b` (`T-101`, `T-103`, `T-301`, `T-302`) delivery:

| Check | Outcome | Notes |
| --- | --- | --- |
| **`pnpm run build`** | **Passed (exit `0`)** | Vite v6.4.6 web bundle (`1869 modules`) + `tsc -p .` across all 5 packages (`protocol`, `plugin-sdk`, `daemon`, `web`, `core`) |
| **`pnpm test`** | **Passed (`18` files / `56` tests, `0` skipped)** | Covers all prior `v0.1`/`v0.2a` suites plus `blob-service`, `channels` (`T-103` & `T-301` Email/GitHub), and `usage-service` (`T-302`) |
| **`node scripts/smoke.mjs`** | **Passed (exit `0`)** | Verified isolated production `core` + `daemon` startup, `HEALTH` (`ok: true`, `daemonConnected: true`), and `WEB_STATUS: 200 HAS_TITLE: true` |
| **Isolated Live `codex-cli 0.170.0` Verification** | **Passed (exit `0`)** | Verified 2-turn native `exec resume` (`thread_id` recall) and dynamic `-c mcp_servers.myagents.*` discovery against `mcp-bridge.mjs` in an isolated non-git temp workspace |

---

## 4. Backlog & Next-Phase Roadmap

> Reserved tables and SPI contracts (`files`, `file_refs`, `file_deletion_outbox`, `mcp_servers`, `skills`, `background_jobs`, `approval_requests`, `ApprovalGate`, `reply_target_json`) already exist in the codebase.  
> **Active Priority Policy**: All `P3` items (`T-102`, `T-203`, `T-303`, `T-304`) are currently deferred and excluded from active scheduling.

### 4.1 Group A: Remaining `v0.1` Tail Items

| ID | Priority | Status | Task | Reserved Infra | Scope & Acceptance Criteria |
| --- | :---: | :---: | :--- | :--- | :--- |
| **T-101** | P1 | **Delivered** | **Chat & Inbox Attachment Blob Storage + Manual Cleanup** | `files`, `file_refs`, `file_deletion_outbox` tables ([database.ts](../packages/core/src/storage/database.ts#L259-L289)) | Content-addressed SHA-256 store (`~/.myagents/blobs/<aa>/<bb>/<sha256>`), transactional `file_refs`, chat/inbox upload & preview, agent prompt attachment injection, and double-confirmed manual disk cleanup button in Settings (scheduled GC omitted) |
| **T-102** | P3 | **Deferred / Open** | **Gemini / ACP CLI Live Integration & Resume Eval** | `AcpCliDriver` ([cli-drivers.ts](../packages/core/src/runtime/cli-drivers.ts)) | Deferred (`P3`): `CodexCliDriver` stdin/EOF, native resume, dynamic MCP, and isolation flags are verified; live `gemini` CLI integration and native ACP resume/MCP eval deferred |
| **T-103** | P2 | **Delivered** | **Inbox UX Polish (Rule Workspace + Outbound Reply)** | `inbox_items.reply_target_json`, `RoutingRuleAction.workspaceId` | Added target project workspace selector in [InboxView.tsx](../packages/web/src/components/InboxView.tsx) routing rule form, manual reply action, and source plugin outbound reply callback on resolution |

### 4.2 Group B: `v0.2a` Ecosystem & Governance Mainline

| ID | Priority | Status | Task | Reserved Infra | Scope & Acceptance Criteria |
| --- | :---: | :---: | :--- | :--- | :--- |
| **T-201** | P0 | **Delivered** | **External MCP Servers & Skill Registry** | `mcp_servers`, `skills`, `Agent.mcpServerIds / skillIds` | CRUD/RPC and Web UI for external MCP servers (`stdio` / `http`, blocking reserved name `myagents`, secret masking) and local/Git skills (`pinnedCommit`, bounded prompt + `skillsHash`); injects merged configs across `BuiltinDriver`, `ClaudeCodeDriver`, and `CodexCliDriver` (blocked in `lockdown`) |
| **T-202** | P0 | **Delivered** | **Background Jobs & Cron Scheduler** | `background_jobs`, `scheduled_jobs` (`v4`) | Unified background job runner + 5-field cron scheduler (`run_after`, idempotency keys, exponential backoff retries, startup recovery) with built-in handlers (`sync_source`, `routine_tick`, `backup_snapshot` via `VACUUM INTO`) and Web UI |
| **T-203** | P3 | **Deferred / Open** | **Human-in-the-Loop Tool Approval (HITL)** | `approval_requests` table; `ApprovalGate` SPI ([hooks.ts](../packages/core/src/security/hooks.ts)) | Deferred (`P3`): pause `WorkNode` into `awaiting_human` on policy-matched high-risk actions, persist `approval_requests`, push WebSocket prompt to Web UI, and resume/deny execution upon user decision |

### 4.3 Group C: `v0.2b+` Channels & Operations

| ID | Priority | Status | Task | Scope & Acceptance Criteria |
| --- | :---: | :---: | :--- | :--- |
| **T-301** | P2 | **Delivered** | **Email & GitHub Channel Plugins** | Extended [plugin-sdk](../packages/plugin-sdk/src/index.ts) `SourcePlugin` for provider-agnostic IMAP/SMTP Email (with attachment storage & threaded replies) and GitHub PAT polling + issue/PR comment replies; other IM/ticket channels excluded from current scope |
| **T-302** | P2 | **Delivered** | **Global Usage & Cost Analytics Dashboard** | Aggregated `work_nodes.usage_json` across rooms, agents, models, and `24h`/`7d`/`30d`/`all` time windows in [AnalyticsView.tsx](../packages/web/src/components/AnalyticsView.tsx) |
| **T-303** | P3 | **Deferred / Open** | **Consistent Async Backups (S3 / Off-site Sync)** | Deferred (`P3`): local `VACUUM INTO` SQLite WAL snapshots + retention pruning shipped in **T-202**; S3-compatible off-site archive upload and checksum verification deferred |
| **T-304** | P3 | **Deferred / Open** | **Managed Browser Tool & Multi-User RBAC** | Deferred (`P3`): controlled browser automation tool and multi-user role-based access control + audit trail |

---

## 5. Quick Start

```bash
# Production server (http://127.0.0.1:3210, default admin / admin)
pnpm start

# Development hot-reload (daemon + core + Vite :5173)
pnpm dev

# Verification pipeline
pnpm run build && pnpm test
```
