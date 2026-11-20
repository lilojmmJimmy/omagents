# Architecture & Design Review Report (MyAgents v0.1 / v0.2)

> **Review Scope**: Deep audit of [01-PRD-FEATURES.md](./01-PRD-FEATURES.md), [02-ARCHITECTURE.md](./02-ARCHITECTURE.md), [03-DOMAIN-DESIGN.md](./03-DOMAIN-DESIGN.md), [04-API-PROTOCOL.md](./04-API-PROTOCOL.md), [05-DATABASE-DESIGN.md](./05-DATABASE-DESIGN.md), plus real-world backend adaptation scope from `Antumi` (`Apache-2.0`).  
> **Overall Verdict**: The core abstraction ("In-process Builtin Agent + External CLI Agents + Single `Room + WorkNode + CollabStrategy` Kernel + Thin Daemon + Single Server Instance") is sound, clean, and worth keeping long term. **The `v0.1` baseline required closing concrete security, concurrency, state-machine, and session-identity gaps before coding—and all findings below have been incorporated into v2.0 of docs 01-05.**

---

## Root-Cause Summary of Findings
Four primary root causes surfaced across the v1 design docs:
1. **Unauthenticated server paired with terminal/filesystem APIs** created direct RCE exposure.
2. **Task scheduling lacked explicit concurrency, lock, state-machine, and idempotency bounds**, leaving deadlocks, data races, and dual queue truth sources.
3. **Session & visibility identity conflation** broke same-agent multi-seat participation, warm incremental delivery, and blind-round reveal ordering.
4. **Overbroad initial MVP scope**, which becomes ~60% smaller by adapting battle-tested `Antumi` (`Apache-2.0`) Node.js backend primitives cleanly.

Key resolutions locked in for v2.0:
- **Minimal Security Baseline**: Simple `admin / admin` credentials with salted `scryptSync` hashing + `HttpOnly` sessions + WS `Origin` validation + Webhook HMAC verification + Inbox Lockdown defaults.
- **Race-Free Scheduling**: Deep rework covering RW locks, `waiting_children` yield semantics, two-phase delivery, and startup reconciliation.
- **Phased MVP (`v0.1a -> v0.1b -> v0.1c`)**: Incremental delivery sharing one kernel.

---

## 1. Design Defects Catalog (P0 / P1 / P2)

### 1.1 P0: Must Resolve Before Coding

#### P0-1 Unauthenticated Server = Direct RCE & Prompt Injection Surface
- **Finding**: Leaving `AuthGuard` unimplemented on `0.0.0.0:3210` exposes Web PTY terminals, `files.write`, `workspaces.registerProject`, and `workspace_exec` to unauthenticated callers. Unsigned webhooks could trigger write-capable agents on untrusted payloads.
- **Fix**: Implement the minimal security baseline (`SimplePasswordAuthGuard`, `X-Webhook-Secret`/HMAC, and default `read-only` Lockdown for inbound auto-routed tickets).

#### P0-2 Path Guard Does Not Sandboxed External CLIs & Lacks Flag Mapping
- **Finding**: `resolveContainedPath` protects only platform file APIs; `workspace_exec`, PTY, and external CLIs execute OS commands directly. Moreover, the scheduler assumes `read-only` tasks are safe to run in parallel with `shared-rw` tasks.
- **Fix**: Explicitly document container/OS-sandbox trust boundaries, define complete `permissionMode x workspaceMode` CLI flag mappings (including `--disallowedTools`), and surface explicit risk labels on `full` mode.

#### P0-3 Scheduling Deadlock: Locks & Quotas Held During `waiting_children`
- **Finding**: Three normal cases deadlock if parent nodes hold locks/slots across child waits:
  1. Parent holds `ws_write:/repo` (`shared-rw`) and awaits a `shared-rw` child.
  2. Agent `maxConcurrency=1` parent stays in `waiting_children` while child routes back to the same agent.
  3. Agents A and B mutually call `collab_reply`.
- **Fix**: Only `starting` and `running` nodes hold resource locks, seat locks, and concurrency slots; `waiting_children`, `paused`, `awaiting_human`, and all `settled` states release them immediately.

#### P0-4 Non-Serialized Strategy Updates & Missing `strategy_state` Reduction
- **Finding**: Concurrent child completions can read stale snapshots and either stall or double-advance rounds. `EngineAction` also lacked an explicit delta update action for `rooms.strategy_state_json`.
- **Fix**: Enforce single-writer `Per-Room Actor` serial execution inside zero-`await` synchronous SQLite transactions paired with pure `reduceState(prev, delta)`.

#### P0-5 `agent_sessions` Keyed on `(room_id, agent_id)` Breaks Multi-Seat Participation
- **Finding**: Using `(room_id, agent_id)` prevents one agent from taking distinct pro/con seats or maintaining separate private visibility in the same room.
- **Fix**: Elevate `room_member_id` to first-class collaboration identity across `agent_sessions`, `work_nodes.assignee_member_id`, and `visible_to_json`.

---

### 1.2 P1: Critical Design Gaps

#### P1-1 Missing `core` Hot-Restart Reattachment Mechanics
- **Gaps**: Missing `AgentDriver.reattach` & `capabilities`; volatile in-memory MCP tokens causing HTTP 401 after `core` restart; un-tracked ring-buffer overflow leading to torn NDJSON frames; Windows child termination on parent terminal close.
- **Fix**: Adopt `ChatHost` + `LineFramer(last_consumed_offset)` replay with explicit `output_gap` detection, restart-resilient stdio `mcp-main` reading `~/.myagents/run/core.json`, and `detached + windowsHide` spawning.

#### P1-2 Missing Full vs. Incremental Context Distinction & Reveal Cursor Gaps
- **Gaps**: Resending full 48k char packets wastes tokens on warm CLIs; revealing blind messages (`seq < last_delivered_seq`) is missed by `seq > last_delivered_seq` queries; character budgets mis-estimate CJK vs ASCII token density.
- **Fix**: Separate Full vs. Incremental context assembly, introduce monotonic `visible_seq` assigned upon reveal, and budget by estimated tokens with fixed schema reservations.

#### P1-3 Incomplete `WorkNode` Transitions & Tool Conflict Semantics
- **Fix**: Add `failed` as a `settled` terminal signal for parent fan-in, complete cancellation edges (`awaiting_human`, `waiting_deps`, `waiting_lock`, `failed -> cancelled`), enforce `collab_publish` mutual exclusion while subtasks are pending, standardize `transfer` & `reassign` (`supersedes_node_id`), and make `CollabEngine` the sole authority on accepted children.

#### P1-4 `job_queue` + `work_nodes` Dual Truth Sources & Retry Multiplication
- **Fix**: Eliminate mirrored node rows from `job_queue` (keep `work_nodes` as the single scheduling source of truth), add `work_node_deps` for O(1) reverse DAG wakeups, and isolate HTTP 429/5xx retries exclusively inside the LLM client.

#### P1-5 Open-Channel Routing Regex & ID Ergonomics
- **Fix**: Fix word-boundary regex limitations, make Lead `idle` classification authoritative rather than overriding on incidental name mentions, check `driver.capabilities.supportsSteerWhileRunning` before mid-turn steering, expose `#m<seq>` short IDs to models, and drop unused `mode: 'parallel'`.

#### P1-6 Dots in Tool Names Reject OpenAI / CLI Name Validators
- **Fix**: Standardize all built-in tools on `snake_case` (`workspace_*`, `collab_*`) matching `^[a-zA-Z0-9_-]{1,64}$`.

#### P1-7 Roundtable Blindness, Interjection & Anonymization Edge Cases
- **Fix**: Preserve active round state on mid-discussion user messages, keep blind Step 1 outputs scoped to `[selfMemberId]` until barrier reveal (including Chair), mask seat names/paths as `Member A/B/C` when `anonymous` is enabled, and define full vs. partial barrier failure handling.

#### P1-8 Missing Hooks on `CollabStrategy`
- **Fix**: Add `onNodeSettled`, `onSuperstepBarrier`, `onControl`, `onMembersChanged`, `validateToolCall`, and `reduceState`.

#### P1-9 Worktree Lifecycle Sharing & Windows Path Length Limits
- **Fix**: Support `inheritWorkspaceFromNodeId` so reviewers inspect a coder's exact worktree, isolate repos with `RepoMutex`, guard setup scripts behind trust checks, and shorten worktree dirs via 8-char `shortId` prefixes to avoid Windows 260-char path errors.

#### P1-10 Host CLI Config Leakage & Live Session Config Drift
- **Fix**: Isolate `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, scrub interfering provider env vars, and track `agent_sessions.config_hash` to restart stale sessions cleanly when model/prompt/skills change.

#### P1-11 Missing Tables & Attachment Reference Counting Leaks
- **Fix**: Add `file_refs` + extensionless content-addressed `blobs` + `file_deletion_outbox`, plus `node_events`, `terminal_sessions`, `webhooks`, and `approval_requests`; enforce stop-before-delete room Sagas.

#### P1-12 WebSocket Replay Ordering, PTY Head-of-Line Blocking & File Overwrites
- **Fix**: Carry monotonic `eventSeq` for WS replay, split PTY frames onto `/ws/terminal/:id`, require `idempotencyKey` on `sendMessage`, add `expectedMtimeMs` optimistic file locking, and define daemon byte/character offset semantics.

---

### 1.3 P2: Engineering Refinements
1. Explicit effective permission minimum across agent, node, strategy, and source trust.
2. Token/runtime/rate-limit guardrails alongside dispatch counts.
3. Explicit single-Core deployment boundary for `v0.x`.
4. Memory-throttled streaming events; batch DB flushes per tool step/turn rather than per token.
5. Off-peak `VACUUM INTO` backups noting eventual consistency with blobs/workspaces.
6. Stage attachments outside user Git repos under `~/.myagents/attachments/<roomId>/`.
7. Split `-32010 unauthorized` from `-32011 forbidden`.

---

## 2. Minimal Security Baseline Summary
Implemented in ~150-200 lines cleanly behind security hooks:
- Salted `scryptSync` password storage (`admin / admin` default overrideable via env), 7-day persistent `auth_sessions`, `HttpOnly` cookie + `Bearer` token auth, non-localhost default password banner, and WS `Origin === Host` CSWSH protection.
- Inbound `X-Webhook-Secret` / HMAC verification paired with `read-only` Lockdown defaults (`allowWrite = false`).
- `0600` private permissions on Unix sockets and `~/.myagents/run/core.json`.

---

## 3. Race-Free Scheduler Architecture (6 Invariants)
1. **Single Truth & Explicit DAG**: `work_nodes` + `work_node_deps` + single-layer LLM transient retry.
2. **Per-Room Actor + Unlocked Async I/O**: Zero-`await` synchronous SQLite state updates, `Scheduler.tick()` synchronous CAS reservation (`starting` + `leaseToken`), async execution under `AbortController`, and `leaseToken` verification after every `await`.
3. **Strict Hold vs. Yield Lifecycle**: Locks/slots held only in `starting` / `running`; released on `waiting_children`, `paused`, `awaiting_human`, and `settled`. Writer-preferring RWLock + `RepoMutex`.
4. **Two-Phase Deterministic Child Delivery**: `work_deliveries` ensures zero duplicate wakeups and zero lost child results across crashes.
5. **Deadlock-Free `WorkNode` State Machine**: Complete settled semantics, tool mutual exclusion, non-mutating `reassign`, and external CLI first-byte/idle watchdogs.
6. **Ordered Startup Reconciliation**: Reattach daemon PTY & CLI sessions (`LineFramer` offset replay + explicit `output_gap` failure), mark orphaned `builtin` turns `failed(core_restarted)`, recover `pending` deliveries, then lift the `reconciling` gate.

---

## 4. Antumi (`Apache-2.0`) Reuse Matrix & Core Differentiation

| Layer | Reused / Adapted Modules | Approach | Notes |
| :--- | :--- | :--- | :--- |
| **Thin Daemon** | `packages/daemon/src/` (`session-host`, `pipe-session`, `pty-session`, `output-buffer`, `endpoint-claim`) | Direct adaptation | 8MB pipe / 512KB PTY ring buffers, smooth retire, stale socket cleanup |
| **Cross-Platform Launch** | `packages/protocol/src/node/` (`command-launch.ts`, `daemon-protocol.ts`, `paths.ts`, `private-file.ts`) | Direct reuse | Shell-free Windows `.cmd`/`.ps1` launching + `0600` private files |
| **External CLI Drivers** | `chat-host.ts`, `claude/claude-stream.ts`, `acp/`, `codex/` | Core + MyAgents `AgentDriver` wrapper | Hot-restart offset replay & first-frame watchdog |
| **MCP Bridge** | `mcp-main.ts` | Adapted stdio forwarder | Reads `~/.myagents/run/core.json` to survive `core` restarts |
| **Workspace / Git / Terminal** | `workspace`, `worktree-service`, `git-service`, `terminal-service` | Adapted with containment guards | RepoMutex, non-destructive branch preservation, PTY proxy |
| **Builtin Agent & Collab Kernel** | `BuiltinDriver`, `CollabEngine`, `Scheduler`, `CollabStrategy` | **Original MyAgents implementation** | ReAct loop + unified Reducer + Dual-Beat (`event-driven` / `superstep`) + `packages/web` React SPA |
| **Excluded Modules** | Electron main, desktop `WebContentsView`, mobile Noise gateway, pet library | Excluded | Keeps MyAgents strictly server-first & lightweight |

---

## 5. Phased Delivery Map (`v0.1a` -> `v0.1b` -> `v0.1c` -> `v0.2+`)
- **`v0.1a`**: Auth baseline, thin `daemon`, `BuiltinDriver` + `ClaudeCodeDriver`, workspaces + editor/diff/terminal, `single` strategy, React Web workbench.
- **`v0.1b`**: Complete 5-layer isolation, race-free scheduler (`leaseToken` + RWLock + `work_deliveries`), restart-resilient `mcp-main` (`collab_*`), worktree delegation, and `open-channel`.
- **`v0.1c`**: Unified Inbox (`InboxItem`, generic webhooks, HMAC, routing rules, `SourcePlugin` GitHub), Pregel Super-step `roundtable` + one-click `handoff`, `file_refs` + Outbox GC, `node_events` replay.
- **`v0.2+`**: Additional CLIs (`Codex`, `ACP/Gemini`), external connectors (`Email IMAP`, `GitHub`), Jobs & Cron, Usage & Cost analytics, Extensions management, and Blob GC UI.
