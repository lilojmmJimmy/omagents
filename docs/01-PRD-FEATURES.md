# 01. Product Requirements & Feature Spec (PRD)

> **Status**: v2.0 Final (architecture review findings and phased scope incorporated)  
> **Positioning**: Server-First Multi-Agent Control Plane & React Web Workspace  
> **Stack**: TypeScript + Node.js 22+ (`node:sqlite` + backend `protocol` / `daemon` / `core` / `plugin-sdk`) + React Web SPA

---

## 1. Product Vision & Core Objectives

### 1.1 Key Pain Points
1. **Task-Weight Mismatch**: Lightweight tasks (Q&A, document drafting, message triage, quick file edits) should run on an **in-process Builtin Agent with sub-millisecond cold start**, without launching heavy external CLIs.
2. **External CLI Operations**: High-capability external CLIs such as Claude Code run locally in terminals and lack persistent server-side hosting, web UI access, process survival across restarts, and unified workspace management.
3. **Fragmented Multi-Agent Orchestration**: Many tools separate delegation, teams, and group chats into rigid silos, making new collaboration modes hard to add and allowing external CLIs to spawn untracked ad-hoc subagents.
4. **Disconnected External Inputs**: Email, IM, Jira, and GitHub events need to be normalized into unified text + file tickets inside an Inbox, then manually assigned or auto-routed to agents.

### 1.2 Core Design Principles
- **Server-First + Clean React Web UI**: No heavy desktop shell required; deploy the backend on a workstation, VPS, or container and connect via browser.
- **Unified Dual-Track Agent Abstraction**: Both in-process Builtin Agents (any OpenAI-compatible API) and external CLIs implement a single `AgentDriver` interface.
- **Sound Kernel First, Phased Feature Rollout**: Build the core kernel once around unified `Room + WorkNode + CollabEngine + CollabStrategy`, agent isolation hooks, and auth baseline. Ship **`v0.1a`** focused on single-agent (`builtin` + `claude`) reliability and workspace tooling, then layer open-channel collaboration (`v0.1b`) and roundtable/inbox (`v0.1c`) without rewrites.
- **Fixed Member Rosters & Subagent Restrictions**: Collaborative rooms use explicit fixed rosters and block ad-hoc nested subagent spawning at both orchestration and CLI flag layers.

---

## 2. Phased Delivery Roadmap

| Phase | Positioning | Core Deliverables |
| :--- | :--- | :--- |
| **`v0.1a` (Initial Baseline)** | **Production-runnable single-agent server workbench** | - Minimal security baseline (`admin/admin` auth, `HttpOnly` cookie/Bearer, WS `Origin` check)<br>- Thin `daemon` (Pipe + PTY + ring buffer) with `core` hot-restart reattachment<br>- **Dual-track agents**: in-process `BuiltinDriver` (OpenAI-compatible API) + external `ClaudeCodeDriver`<br>- **Workspace system**: `agent_private` persistent workspaces + registered `project` directories + file editor / Git diff / Web terminal<br>- Unified `Room + WorkNode` kernel running `single` strategy with extension hooks ready<br>- Clean React 3-pane Web UI |
| **`v0.1b` (Isolation & Open Channels)** | **5-layer agent isolation + race-free group collaboration** | - Complete 5-layer agent sandbox (`spawnPipeClean`, `CLAUDE_CONFIG_DIR` isolation, env sanitization, Lockdown read-only enforcement, `config_hash` drift rebuild)<br>- Race-free scheduler (writer-preferring RW lock, two-phase `work_deliveries`, `waiting_children` lock/slot yield)<br>- Restart-resilient `mcp-main` stdio bridge + `collab_*` primitives<br>- `open-channel` strategy: deterministic `@` + Lead routing, task node tree, `Stop/Continue/Cancel/Retry/Reassign`, Git worktree isolation, dual-layer subagent blocking |
| **`v0.1c` (Roundtable & Inbox)** | **Super-step discussions + Unified Inbox** | - Pregel Super-step barrier + Reducer-driven `roundtable` strategy (blind round -> `visible_seq` reveal -> Chair summary -> one-click execution handoff)<br>- Unified Inbox (`InboxItem`: manual creation, generic HMAC webhook verification, rule-based auto-routing with default Lockdown isolation, `plugin-sdk` adapter interface)<br>- `file_refs` reference counting + Outbox blob garbage collection |
| **`v0.2+` (Ecosystem & Scale)** | **Additional drivers, sources, jobs & analytics** | - Additional external CLIs (`Codex`, `Gemini / ACP`) and source plugins (`Email IMAP`, `GitHub`)<br>- Scheduled Jobs & Cron engine, usage & cost analytics, extension management (MCP & Skills), attachment blob manual GC UI, Web approval / RBAC foundations |

---

## 3. Initial Baseline (`v0.1a`) Detailed Specification

### 3.1 Minimal Security Baseline
- **Authentication**: Default `admin / admin` (override via `MYAGENTS_ADMIN_USER` / `MYAGENTS_ADMIN_PASS`), hashed with `scryptSync` + per-user salt in SQLite, editable from Settings.
- **Session & Route Protection**: `HttpOnly` session cookies and `Authorization: Bearer` tokens. Every HTTP API and WebSocket endpoint (except `/health`, login, webhooks, and public assets) requires authentication, with WS `Origin` validation to mitigate CSWSH.
- **Non-Local Bind Warning**: When bound outside `127.0.0.1` while still using default `admin/admin`, emit console warnings and display a Web banner linking to password settings.

### 3.2 Model Providers & Dual-Track Agents
- **Model Providers**: CRUD management for OpenAI-compatible endpoints (`baseUrl`, `apiKey`, `defaultModel`, `models[]`) plus connectivity probing (`providers.probe`).
- **Builtin Agent (`builtin` driver)**:
  - Runs in-process with millisecond startup via streaming tool-calling ReAct loop (default `maxSteps = 25`).
  - Exposes permission-scoped workspace tools: `workspace_list`, `workspace_read`, `workspace_grep`, `workspace_write`, `workspace_patch`, `workspace_exec` (proxied through `daemon` with timeout guards).
- **External Claude Code Agent (`claude` driver)**:
  - Spawns local `claude` CLI (`-p --input-format stream-json --output-format stream-json`) managed via `daemon` `pipe-session` for streaming text, tool step events, and `nativeSessionId` resume.
  - Startup diagnostics detect local `git` and `claude` binaries, versions, and health status.
  - Reserves `IsolationProfile` injection points (`v0.1a` baseline env/path scoping; `v0.1b` full directory isolation & Lockdown).
- **Agent Configuration**: Name, `bio`, `systemPrompt`, `driverKind`, model/provider override, default permission mode (`read-only | workspace-write | full`), isolated private workspace, and archive flag.

### 3.3 Workspace System & File Tooling
- **Primary Workspace Types**:
  1. **Agent Private Workspace (`agent_private`)**: Provisioned automatically at `~/.myagents/workspaces/agents/<agentId>/` with `notes/` and `artifacts/` directories.
  2. **Project Workspace (`project`)**: Registers a server directory or Git repo and detects Git status and current branch.
  - *(Note: `git_worktree` and `shared` schemas are provisioned upfront in SQLite for zero-migration expansion in `v0.1b`.)*
- **Workspace Dock Operations (shared path guard with Agent tools)**:
  - **File Tree**: Lazy directory listing, create file/folder, rename, delete, upload, and download.
  - **Code/Text Editor**: Read/write files with `expectedMtime` optimistic concurrency checks to avoid silent overwrites during agent edits.
  - **Git Diff**: Inspect modified files and unified diffs inside Git workspaces.
  - **Web Terminal**: Dedicated PTY WebSocket connected to `daemon`, reattaching cleanly after browser refresh or `core` restart.

### 3.4 Single Chat & Event Persistence (`single` strategy)
- Built on the unified `Room + WorkNode` engine running the `single` strategy:
  - Select 1 agent (`builtin` or `claude`) and a private or project workspace.
  - Streaming output: text deltas, Chain-of-Thought thinking blocks, collapsible tool cards, persisted in `node_events` for full page-refresh recovery.
  - Execution control: idempotency keys on message submission, live **Interrupt**, and failure **Retry**.
  - Hot-restart survival: restarting `core` preserves active `claude` CLI and PTY sessions inside `daemon` and reconciles output on reconnect.

### 3.5 Clean 3-Pane React Workspace UI
- **Left Sidebar**: Room list with live activity indicators and navigation for Chats, Inbox, Agents, Extensions, Jobs & Cron, Usage & Cost, Workspaces, and Settings.
- **Center Pane**: Streaming message timeline (Markdown + collapsible thinking/tool cards) and composer bar with Send/Interrupt controls.
- **Right Dock (collapsible)**: **Files** (tree + editor + upload), **Changes** (Git diff), **Tasks** (execution tree & shared memory), and **Terminal** (`xterm.js`).

---

## 4. `v0.1a` Acceptance Checklist

1. **Startup & Auth**: Single command starts `daemon` + `core`; login at `http://localhost:3210` with `admin / admin` and change password in Settings.
2. **Builtin Agent Loop**: Configure an OpenAI-compatible provider, create a `builtin` agent, chat across multiple turns in its private workspace, edit files via agent tools, and inspect/edit/upload files in the Workspace Dock.
3. **Claude Code CLI Loop**: Create a `claude` agent bound to a local Git repository, instruct it to inspect/modify code, watch streaming text and tool steps, review **Git Diff**, and verify via **Web Terminal**.
4. **Persistence & Controls**: Refresh browser to confirm message and tool step recovery; test mid-run **Interrupt** and failed-node **Retry**.
5. **Hot-Restart Resilience**: Keep an active Web Terminal and `claude` session open, restart `core`, and confirm session continuity upon reload.

---

## 5. Architecture Ready for `v0.1b` / `v0.1c`

The database schemas, domain contracts, and runtime hooks for these capabilities are specified in [02-ARCHITECTURE.md](./02-ARCHITECTURE.md), [03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md), [04-API-PROTOCOL.md](./04-API-PROTOCOL.md), and [05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md) for zero-refactor phased delivery:
- **5-Layer Agent Environment Isolation**: Clean env spawning, `CLAUDE_CONFIG_DIR` isolation, Lockdown read-only guardrails, path containment, and `config_hash` drift rebuild.
- **Open Channel (`open-channel`)**: Fixed member rosters, deterministic `@` + Lead routing, task tree controls, writer-preferring RW lock, dual-layer subagent blocking.
- **Roundtable (`roundtable`)**: Pregel Super-step barriers, blind turn isolation, anonymous peer review, Chair summary, and one-click execution handoff.
- **Unified Inbox**: Webhooks and `plugin-sdk` sources normalized into text+files with automatic routing rules and read-only Lockdown defaults.
