# OmAgents (MyAgents)

A server-side multi-agent orchestration middleware and React web workbench built with TypeScript, Node.js 22+ native `node:sqlite`, Fastify, and a detached process-hosting daemon.

> **Current Baseline**: `v0.2b` (`v0.1a`–`v0.2b` core features delivered). See [docs/PROJECT-STATUS-AND-ROADMAP.md](./docs/PROJECT-STATUS-AND-ROADMAP.md) for detailed status and the remaining deferred `P3` backlog.

## Key Capabilities

- **Multi-Driver Agent Runtime & 5-Layer Isolation**:
  - Built-in streaming ReAct driver (`BuiltinDriver` for OpenAI-compatible endpoints) alongside managed CLI drivers (`ClaudeCodeDriver`, `CodexCliDriver`, `AcpCliDriver`).
  - Three isolation modes (`standard`, `isolated-home`, `lockdown`), sanitized environment spawning (`spawnPipeClean`), native session resume (`Claude` / `Codex`), SHA-256 `configHash` drift detection, and dual-layer subagent blocking.
- **Fixed-Roster Multi-Agent Collaboration (`open-channel`)**:
  - Deterministic `@member`, `@everyone`, and `@Lead` routing, DAG task dependencies (`work_node_deps`), two-phase `work_deliveries`, parallel Git worktree sandboxing (`RepoMutex` + write-preferring RW locks), and a restart-resilient stdio MCP bridge (`collab_*` tools).
- **Pregel Super-Step Roundtable (`roundtable`)**:
  - Private round-1 blind isolation with atomic super-step barrier reveals, optional anonymous identity masking, mid-discussion human interjection, partial-failure pause/recovery, Chair synthesis, and one-click room handoff preserving shared memories.
- **External MCP Servers & Skill Registry (`v0.2a`)**:
  - Managed external MCP servers (`stdio` and Streamable HTTP JSON/SSE) with secret masking and live probing, plus local and Git-pinned `SKILL.md` skills injected cleanly across `BuiltinDriver`, `ClaudeCodeDriver`, and `CodexCliDriver` (external MCP disabled in `lockdown`).
- **Background Jobs & Cron Scheduler (`v0.2a`)**:
  - 5-field cron scheduler with startup crash recovery, idempotency keys, exponential backoff retries, pull sync (`sync_source`), scheduled routines (`routine_tick`), and consistent SQLite `VACUUM INTO` backups (`backup_snapshot`) with retention pruning.
- **Unified Inbox, Email (IMAP/SMTP) & GitHub Channels (`v0.1c` / `v0.2b`)**:
  - Ingests generic HMAC/Bearer webhooks, GitHub (HMAC webhooks + REST API PAT polling + issue/PR comment replies), and provider-agnostic Email (IMAP polling with attachments + threaded SMTP replies).
  - Priority routing rules with optional target workspace binding, default `lockdown` untrusted-source protection, and automatic or manual outbound replies on resolution.
- **Chat & Inbox Attachment Blob Store (`v0.2b`)**:
  - SHA-256 content-addressed storage under `~/.myagents/blobs/` with transactional `file_refs`, XSS-safe HTTP upload/download (`X-Content-Type-Options: nosniff`), agent `[Attached Files]` context injection, and an explicit manual double-confirmed cleanup UI in Settings (no automatic scheduled deletion).
- **Global Usage & Cost Analytics (`v0.2b`)**:
  - Aggregated token volume, estimated USD spend, latency/TTFT metrics, trend charts, and breakdowns by model, agent, room, and recent runs across `24h` / `7d` / `30d` / `all` windows.
- **Workspace Workbench**:
  - Private and mounted Git project workspaces, traversal/symlink containment (`path-guard.ts`), optimistic file locking, Git diff inspector, and persistent Web PTY terminals surviving `core` restarts.

## Architecture & Tech Stack

- **Runtime**: Node.js `>= 22.13` (`node:sqlite` WAL mode in `core` — zero C++ native addons in `core`)
- **Backend (`core` & `daemon`)**: TypeScript 5.8 (ESM), Fastify, `ws`, Zod, `node-pty` (isolated in `daemon`), pure-JS `imapflow` / `mailparser` / `nodemailer`
- **Frontend (`web`)**: React 19, Vite 6, Tailwind CSS v4, Zustand, `@xterm/xterm`
- **Cross-Platform**: Windows (`win32`, Named Pipes, `.cmd`/`.ps1` shim resolution) and POSIX (Linux / macOS, Unix domain sockets)

```text
packages/
  protocol/     # Browser-safe Zod contracts & @myagents/protocol/node utilities
  plugin-sdk/   # SourcePlugin & StrategyPlugin extension interfaces
  daemon/       # Thin detached PTY / pipe session host surviving core restarts
  core/         # HTTP/WS server, CollabEngine, drivers, MCP, jobs, inbox, blobs, analytics
  web/          # React 19 single-page workbench (compiled into packages/web/dist)
scripts/        # Dev/start launchers and smoke verification scripts
docs/           # Architecture specs (01-05), roadmap, and milestone test reports
```

## Quick Start

### Prerequisites

- **Node.js `>= 22.13`**
- **pnpm** (`>= 10`) and **git**
- Optional external CLIs: `claude`, `codex`, `gemini` (auto-detected on the Settings page)

### Install & Build

```bash
pnpm install
pnpm run build
```

### Run Production Mode (Single Port)

```bash
pnpm start
```

Open `http://127.0.0.1:3210` in your browser (default bootstrap credentials: `admin` / `admin`; rotate in Settings or via environment variables before exposing beyond localhost).

Copy `.env.example` or pass environment variables directly when binding non-loopback interfaces:

```bash
MYAGENTS_HOST=0.0.0.0 MYAGENTS_PORT=3210 MYAGENTS_ADMIN_PASS=your-strong-password pnpm start
```

### Run Development Mode (Hot Reload)

```bash
pnpm dev
```

Starts `daemon`, `core` (`:3210`), and Vite dev server (`:5173`, proxied to `:3210`).

### Verification Commands

```bash
pnpm run check
pnpm run typecheck
pnpm run build
pnpm test
node scripts/smoke.mjs
```

## Documentation

- [AGENTS.md](./AGENTS.md) — Repository engineering standards and conventions
- [docs/PROJECT-STATUS-AND-ROADMAP.md](./docs/PROJECT-STATUS-AND-ROADMAP.md) — Delivered capabilities, verification baseline, and deferred `P3` backlog
- [docs/README.md](./docs/README.md) — Index of system design specs (`01`–`05`) and milestone reports (`v0.1a`–`v0.1c`)
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — Third-party attributions

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
