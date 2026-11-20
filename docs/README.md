# MyAgents Design Documentation Overview (v2.0 Baseline)

MyAgents is a server-side multi-agent orchestration middleware and React web workspace platform built with TypeScript, Node.js 22+ `node:sqlite`, Fastify, and a detached process-hosting daemon.

## Documentation Map

| Document | Description |
| :--- | :--- |
| [PROJECT-STATUS-AND-ROADMAP.md](./PROJECT-STATUS-AND-ROADMAP.md) | **Project Milestones & Roadmap**: Summary of delivered capabilities, current quality baseline, `v0.1c` closeout, and `v0.2+` task backlog |
| [01-PRD-FEATURES.md](./01-PRD-FEATURES.md) | **Product Requirements & Feature Spec (v2.0)**: Dual-track agents (builtin + external CLIs), workspaces, file handling, and phased delivery (`v0.1a` single-agent baseline -> `v0.1b` sandbox isolation & open channels -> `v0.1c` roundtable & unified inbox) |
| [02-ARCHITECTURE.md](./02-ARCHITECTURE.md) | **System Architecture (v2.0)**: Layering, Antumi Apache-2.0 adaptation boundaries, **5-layer agent isolation architecture**, thin `daemon` hot-restart reattachment, restart-resilient MCP bridge, Reducer + dual-beat engine, and minimal auth security baseline |
| [03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md) | **Domain Model & State Machine Design (v2.0)**: `room_member_id` first-class identity with per-seat serialization, subagent restrictions, deadlock-free `WorkNode` state machine, writer-preferring RW lock, two-phase `work_deliveries`, `visible_seq` incremental delivery, and Reducer + Super-step strategy model |
| [04-API-PROTOCOL.md](./04-API-PROTOCOL.md) | **API & Protocol Spec (v2.0)**: Auth REST endpoints, WebSocket `/rpc` JSON-RPC 2.0, dedicated terminal WS, Core-to-Daemon NDJSON (`spawnPipeClean`), underscore-namespaced `workspace_* / collab_*` tools, and SPIs (`AgentDriver` / `EnvironmentIsolator` / `CollabStrategy` / 4 security hooks) |
| [05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md) | **Database & Storage Design (v2.0)**: Node 22 native `node:sqlite` WAL schema (22 tables across phases), ER diagram, `work_nodes` source of truth, `work_node_deps`, `work_deliveries`, `node_events`, `terminal_sessions`, `file_refs` reference counting, and Outbox GC |
| [DESIGN-REVIEW.md](./DESIGN-REVIEW.md) | Historical architecture review notes (findings incorporated into documents 01-05 v2.0) |
| [V0.1A-TEST-REPORT.md](./V0.1A-TEST-REPORT.md) | **`v0.1a` Delivery & Acceptance Report**: Build/typecheck, unit & E2E tests, live Claude Code CLI integration, browser Web UI acceptance, bug fixes, and startup guide |
| [V0.1B-TEST-REPORT.md](./V0.1B-TEST-REPORT.md) | **`v0.1b` Delivery & Acceptance Report**: 5-layer sandbox isolation, race-free `open-channel` multi-agent groups, Git worktree parallel isolation, restart-resilient MCP bridge, Web task tree, and live CLI/browser E2E acceptance |
| [V0.1C-TEST-REPORT.md](./V0.1C-TEST-REPORT.md) | **`v0.1c` Delivery & Acceptance Report**: Pregel Super-step `roundtable` discussion & handoff, Unified Inbox / Webhooks / `SourcePlugin` / auto-routing Lockdown isolation, `Codex` & `ACP` drivers, and live E2E verification |
