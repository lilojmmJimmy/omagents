# MyAgents Project Status & Next-Phase Roadmap

> **Current Baseline**: `v0.1c+` (`v0.1a` -> `v0.1b` -> `v0.1c` delivered, plus Codex CLI native resume / dynamic MCP / latest-turn wrap-up)  
> **Updated**: `2026-11-19`  
> **Scope**: Single entry point summarizing delivered capabilities, verified quality baseline, resolved engineering fixes, and the backlog entering `v0.2`.

---

## 1. Current State

MyAgents is a server-side multi-agent orchestration middleware and React web workspace platform with zero C++ dependencies in `core` (Node.js >= 22.13 native `node:sqlite`), launched via `pnpm start`:

1. **Dual-Track Single-Agent Execution & Hot-Restart Survival (`v0.1a`)**
2. **5-Layer Agent Isolation, Deadlock-Free `open-channel` Collaboration & Git Worktree Isolation (`v0.1b`)**
3. **Pregel Super-step `roundtable`, Unified Inbox / Webhooks / `SourcePlugin` Lockdown, and Full `CodexCliDriver` Support (`v0.1c+`)**

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

### 2.5 Directory Overview

| Path | Responsibility |
| --- | --- |
| `packages/protocol/src/` | Zod schemas (`models.ts`, `room.ts`, `collab.ts`, `inbox.ts`, `rpc.ts`) and Node utilities (`node/`) |
| `packages/plugin-sdk/src/` | Extension SPI (`SourcePlugin`, `InboundEnvelope`, `PluginContext`, `StrategyPlugin`) |
| `packages/daemon/src/` | Thin detached PTY/pipe session host (`pipe-session.ts`, `pty-session.ts`, `session-host.ts`) |
| `packages/core/src/collab/` | `CollabEngine`, strategies (`single`, `open-channel`, `roundtable`), `context-builder.ts`, `rw-lock.ts` |
| `packages/core/src/inbox/` | `InboxService`, `PluginManager` (`generic-webhook`, `github-webhook`) |
| `packages/core/src/runtime/` | `BuiltinDriver`, `ClaudeCodeDriver`, `CodexCliDriver`, `AcpCliDriver`, `AgentEnvironmentIsolator`, `EnvCheckService` |
| `packages/core/src/mcp/` | `collab-tools.json`, `mcp-bridge.mjs`, `mcp-config.ts` |
| `packages/core/src/workspace/` | `WorkspaceService`, `WorktreeService`, `GitService`, `TerminalService`, `path-guard.ts` |
| `packages/core/src/storage/` | `CoreDatabase` (`node:sqlite` WAL + forward migrations v1-v3) |
| `packages/core/src/security/` | `AuthService` and extension hooks (`hooks.ts`) |
| `packages/core/src/transport/` | Fastify HTTP server (`/webhooks` raw scope) and WS `/rpc` router |
| `packages/web/src/` | React 19 workbench (`App.tsx`, `store/app-store.ts`, `components/`) |
| `scripts/` | `dev.mjs`, `start.mjs`, `smoke.mjs`, `verify-claude-live.mjs`, `verify-claude-v01b-live.mjs` |
| `docs/` | Architecture specifications (`01`-`05`), design review, and milestone test reports |

---

## 3. Verified Quality Baseline

Latest verification results after all `v0.1c+` wrap-up changes:

| Check | Outcome | Notes |
| --- | --- | --- |
| **`pnpm run build`** | **Passed (exit `0`)** | Vite v6.4.6 web bundle (`1863 modules`) + `tsc -p .` across all 5 packages (`protocol`, `plugin-sdk`, `daemon`, `web`, `core`) |
| **`pnpm test`** | **Passed (`12` files / `42` tests, `0` skipped)** | Covers `e2e`, `acceptance`, `open-channel`, `roundtable`, `latest-turn`, `inbox`, `worktree`, `environment-isolator`, `cli-drivers` (unit + real daemon integration), `claude-driver`, `path-guard`, `rw-lock` |
| **Isolated Live `codex-cli 0.170.0` Verification** | **Passed (exit `0`)** | Verified 2-turn native `exec resume` (`thread_id` recall) and dynamic `-c mcp_servers.myagents.*` discovery against `mcp-bridge.mjs` in an isolated non-git temp workspace |
| **Prior `v0.1c` Checks** | **Passed** | `node scripts/smoke.mjs`, `verify-claude-v01b-live.mjs --mock-anthropic`, and headless Web UI verification documented in [V0.1C-TEST-REPORT.md](./V0.1C-TEST-REPORT.md) |

---

## 4. Backlog & Next-Phase Roadmap

> Reserved tables and SPI contracts (`files`, `file_refs`, `file_deletion_outbox`, `mcp_servers`, `skills`, `background_jobs`, `approval_requests`, `ApprovalGate`, `reply_target_json`) already exist in the codebase.

### 4.1 Group A: Remaining `v0.1` Tail Items (Non-Blocking)

| ID | Priority | Task | Reserved Infra | Scope & Acceptance Criteria |
| --- | :---: | :--- | :--- | :--- |
| **T-101** | P1 | **Chat & Inbox Attachment Blob Storage + GC** | `files`, `file_refs`, `file_deletion_outbox` tables ([database.ts](../packages/core/src/storage/database.ts#L259-L289)) | Content-addressed blob store (`~/.myagents/blobs/<aa>/<bb>/<sha256>`), transactional `file_refs` ref-counting, and scheduled outbox GC (best wired alongside **T-202**) |
| **T-102** | P2 | **Gemini / ACP CLI Live Integration & Resume Eval** | `AcpCliDriver` ([cli-drivers.ts](../packages/core/src/runtime/cli-drivers.ts)) | `CodexCliDriver` stdin/EOF, native resume, dynamic MCP, and isolation flags are verified; run live integration against `gemini` CLI once installed and evaluate native ACP resume/MCP flags |
| **T-103** | P2 | **Inbox UX Polish (Rule Workspace + Outbound Reply)** | `inbox_items.reply_target_json`, `RoutingRuleAction.workspaceId` | Add optional target workspace selector in [InboxView.tsx](../packages/web/src/components/InboxView.tsx) routing rule form; invoke source plugin reply callback when an inbox item transitions to `resolved` |

### 4.2 Group B: `v0.2a` Ecosystem & Governance Mainline

| ID | Priority | Task | Reserved Infra | Scope & Acceptance Criteria |
| --- | :---: | :--- | :--- | :--- |
| **T-201** | P0 | **External MCP Servers & Skill Registry** | `mcp_servers`, `skills` tables; `Agent.mcpServerIds / skillIds`; `writeRoomMemberMcpConfig` | CRUD/RPC and Web UI for external MCP servers (`stdio` / `http`, blocking reserved name `myagents`) and local/Git skills; inject merged configs at runtime into `BuiltinDriver`, `ClaudeCodeDriver`, and `CodexCliDriver` |
| **T-202** | P0 | **Background Jobs & Cron Scheduler** | `background_jobs` table (`sync_source`, `backup_snapshot`, `routine_tick`) | Unified background job runner + cron scheduler (`run_after`, idempotency keys, exponential backoff retries) powering pull-based `SourcePlugin` sync, scheduled routines, and attachment outbox GC (`T-101`) |
| **T-203** | P1 | **Human-in-the-Loop Tool Approval (HITL)** | `approval_requests` table; `ApprovalGate` SPI ([hooks.ts](../packages/core/src/security/hooks.ts)) | Pause `WorkNode` into `awaiting_human` on policy-matched high-risk actions, persist `approval_requests`, push WebSocket prompt to Web UI, and resume/deny execution upon user decision |

### 4.3 Group C: `v0.2b+` Channels & Operations

| ID | Priority | Task | Scope & Acceptance Criteria |
| --- | :---: | :--- | :--- |
| **T-301** | P2 | **Additional Inbound/Outbound Channel Plugins** | Extend [plugin-sdk](../packages/plugin-sdk/src/index.ts) `SourcePlugin` for Email (IMAP/SMTP), Lark/Feishu, DingTalk, Slack, and Jira |
| **T-302** | P2 | **Global Usage & Cost Analytics Dashboard** | Aggregate `work_nodes.usage_json` across rooms, agents, models, and time windows |
| **T-303** | P2 | **Consistent Async Backups (`VACUUM INTO` / S3)** | Scheduled SQLite WAL snapshots via `background_jobs.backup_snapshot` to local archives or S3-compatible storage |
| **T-304** | P3 | **Managed Browser Tool & Multi-User RBAC** | Controlled browser automation tool and multi-user role-based access control + audit trail |

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
