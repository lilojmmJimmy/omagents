# 04. API & Protocol Specification

> **Status**: v2.0 Final (standardizes underscore MCP tool names, auth REST & dedicated terminal WS, full `CollabStrategy` + `EngineAction`, `EnvironmentIsolator` & `AgentDriver.reattach/capabilities`, error codes, and optimistic locking)

---

## 1. Protocol Overview & Version Negotiation

MyAgents defines **6 explicit boundary protocols** (all schemas defined in `packages/protocol` using Zod):
1. **HTTP Auth / REST / Webhooks**: `http://<host>:3210/api/*`, `/webhooks/*`
2. **Web <-> Core Control-Plane WS**: `ws://<host>:3210/rpc` (JSON-RPC 2.0, authenticated + same-origin `Origin` verified)
3. **Web <-> Core Terminal WS**: `ws://<host>:3210/ws/terminal/:terminalId` (binary/UTF-8 PTY frames isolated from `/rpc`)
4. **Core <-> Daemon Process Host**: NDJSON over Unix Socket (`0600`) / Windows Named Pipe
5. **Agent <-> Core Builtin MCP Tools**: Restart-resilient stdio child process `mcp-main` (reading `core.json`) + in-process `BuiltinDriver` calls
6. **Core Internal SPIs**: `AgentDriver`, `EnvironmentIsolator`, `CollabStrategy`, `SourcePlugin`, `BlobStore`, `BackupAdapter`, plus 4 security hooks

- `PROTOCOL_VERSION = 1`, `DAEMON_PROTOCOL_VERSION = 1`
- Handshake `system.hello` returns `{ protocolVersion, serverVersion, features: string[], reconciling: boolean, defaultPasswordWarning: boolean }`.

---

## 2. HTTP REST, Authentication & Webhook Endpoints

| Method & Path | Auth | Purpose | Request / Response Notes |
| :--- | :---: | :--- | :--- |
| `GET /health` | No | Health check | `{ ok: true, daemonConnected, reconciling, uptimeMs, version }` |
| `POST /api/auth/login` | No | Sign in | `{ username, password }` (default `admin/admin`) -> sets `HttpOnly; SameSite=Lax` cookie `myagents_sid`, returns `{ ok, username, token }` |
| `POST /api/auth/logout` | Yes | Sign out | Clears `auth_sessions` row and cookie |
| `GET /api/auth/me` | No | Auth probe | `{ authenticated, username?, defaultPasswordWarning? }` |
| `POST /api/auth/change-password` | Yes | Update password | `{ oldPassword, newPassword }` -> updates `scryptSync` hash and revokes other sessions |
| `POST /api/files/upload` | Yes | Attachment upload | `multipart/form-data`, computes SHA-256 stream into `BlobStore`, returns `FileAsset` |
| `GET /api/files/:fileId` | Yes | Attachment download | Streams content with `ETag` / `Content-Type` |
| `POST /api/workspaces/:workspaceId/upload` | Yes | Workspace file upload | `multipart/form-data` with target relative `dir`, writes inside workspace |
| `GET /api/workspaces/:workspaceId/download` | Yes | Workspace file download | `?path=<relPath>`, guarded by `resolveContainedPath` |
| `POST /webhooks/generic/:hookId` | Secret | Generic webhook ingest (`v0.1c`) | Verifies `X-Webhook-Secret`, parses JSON/multipart into `InboundEnvelope` |
| `POST /webhooks/:pluginId/:instanceId` | Signature | SourcePlugin webhook (`v0.1c`) | Delegates signature verification & normalization to `SourcePlugin.parseWebhook()` |
| `GET /*` | No | Static Web SPA | Serves `packages/web/dist` in production mode |

---

## 3. Web <-> Core: WebSocket JSON-RPC 2.0 (`/rpc`)

### 3.1 Handshake & Error Codes
- WS upgrade validates cookie or Bearer token and matches `Origin` against `Host` (CSWSH mitigation).
- Standardized JSON-RPC error codes:

| Code | `reason` | Meaning |
| :--- | :--- | :--- |
| `-32602` | `invalid_params` | Zod parameter validation failed |
| `-32001` | `not_found` | Requested resource not found |
| `-32002` | `conflict` | Duplicate name, invalid state, `mtime_conflict`, or dirty worktree |
| `-32003` | `guardrail_exceeded` | Exceeded dispatch/reply/depth/step budget guardrail |
| `-32004` | `capacity_or_lock_busy` | Concurrency cap, seat lock, or workspace lock busy |
| `-32005` | `path_out_of_bounds` | Path traversal or symlink escape blocked |
| `-32006` | `driver_error` | LLM API error or external CLI launch/runtime failure |
| `-32007` | `reconciling` | `core` startup reconciliation in progress |
| `-32010` | `unauthorized` | Missing or expired authentication |
| `-32011` | `forbidden` | Authenticated user lacks permission for action |

### 3.2 Core RPC Methods

> Tags `[v0.1a]`, `[v0.1b]`, `[v0.1c]` indicate delivery phase; the wire schema is unified upfront.

#### A. System & Model Providers `[v0.1a]`
- `system.hello({ clientVersion })` -> `{ protocolVersion, features, daemonConnected, reconciling, defaultPasswordWarning }`
- `system.envCheck({ refresh? })` -> `{ git, clis: [{ kind, installed, version, path, ready, problem? }] }`
- `providers.list()` / `providers.save({ id?, name, kind, baseUrl, apiKeyRef?, defaultModel, models, extra? })` / `providers.delete({ id })` / `providers.probe({ id })`

#### B. Agent Management `[v0.1a]`
- `agents.descriptors()` -> `AgentDescriptor[]` (with `capabilities: { supportsResume, supportsSteer, supportsReadOnly, supportsMcp, supportsSubagentBlock }`)
- `agents.list({ includeArchived? })` / `agents.get({ id })`
- `agents.create({ name, bio, systemPrompt, driverKind, driverConfig, permissionMode?, isolationMode?, skillIds?, mcpServerIds?, maxRunningTurns? })` -> `Agent` (creates private workspace)
- `agents.update({ id, patch })` / `agents.archive({ id, archived })`

#### C. Workspaces, Files, Git & Terminals `[v0.1a]`
- `workspaces.list({ kind? })` / `workspaces.registerProject({ name?, rootPath, readonlyRefPaths? })`
- `workspaces.createWorktree({ projectWorkspaceId, baseRef?, branchSlug? })` / `workspaces.cleanWorktree({ workspaceId, force? })` `[v0.1a/b]`
- `files.tree({ workspaceId, dir?, depth? })` -> `FileEntry[]`
- `files.read({ workspaceId, path })` -> `{ content, encoding, size, mtimeMs, binary }`
- `files.write({ workspaceId, path, content, expectedMtimeMs? })` -> `{ ok: true, mtimeMs }` (`-32002 mtime_conflict` on mismatch)
- `files.mkdir / files.rename / files.remove` / `files.search({ workspaceId, query, limit? })`
- `git.status({ workspaceId })` / `git.diff({ workspaceId, path?, baseCommit? })`
- `terminal.list({ workspaceId? })` / `terminal.open({ workspaceId, cols, rows })` -> `{ terminalId, wsPath }` / `terminal.close({ terminalId })`
  - *(Real-time PTY input, resize, and output flow over `WS /ws/terminal/:terminalId` rather than `/rpc`.)*

#### D. Collaboration Rooms & WorkNodes
- `rooms.strategies()` -> `StrategyDescriptor[]` `[v0.1a]`
- `rooms.list({ strategyId?, includeArchived? })` / `rooms.get({ id })` `[v0.1a]`
- `rooms.create({ title?, strategyId, strategyConfig?, primaryWorkspaceId?, members, initialPrompt?, attachmentIds? })` `[v0.1a: single]` `[v0.1b: open-channel]` `[v0.1c: roundtable]`
- `rooms.update({ id, title?, strategyConfig?, members?, sharedMemories? })` / `rooms.archive({ id, archived })` / `rooms.delete({ id })` (stop-before-delete Saga) `[v0.1a]`
- `rooms.subscribe({ roomId, sinceSeq?, sinceEventSeq? })` / `rooms.unsubscribe({ roomId })` `[v0.1a]`
- `rooms.messages({ roomId, beforeSeq?, limit? })` -> `{ messages: RoomMessage[], hasMore }` `[v0.1a]`
- `rooms.sendMessage({ roomId, content, attachmentIds?, replyToMsgId?, idempotencyKey })` -> `{ message }` (`idempotencyKey` required) `[v0.1a]`
- `rooms.control({ roomId, action: 'pause' | 'resume' | 'stop' | 'next_round' | 'summarize_now' })` `[v0.1b/c]`
- `rooms.handoff({ sourceRoomId, sourceMsgId?, targetStrategyId, members, workspaceId?, seedText })` `[v0.1c]`
- `workNodes.list({ roomId, rootNodeId? })` / `workNodes.events({ nodeId, attempt?, afterSeq? })` `[v0.1a]`
- `workNodes.control({ nodeId, action: 'stop' | 'continue' | 'cancel' | 'retry' | 'reassign', targetMemberId?, note? })` `[v0.1a: stop/cancel/retry]` `[v0.1b: continue/reassign]`
- `workNodes.respondApproval({ nodeId, requestId, decision: 'allow' | 'deny', note? })` `[v0.2+ reserved]`

#### E. Unified Inbox, Routing Rules & Capabilities `[v0.1a core / v0.1c inbox]`
- `mcpServers.list / save / delete / probe` `[v0.1a/b]`
- `skills.list / install / remove` `[v0.1a/b]`
- `webhooks.list / create / delete`, `inbox.list / get / createManual / assign / setStatus / replyExternal`, `routingRules.list / save / delete`, `plugins.list / configure / syncNow` `[v0.1c]`

### 3.3 Server Push Notifications
Streaming notifications carry monotonically increasing `eventSeq` so reconnecting clients can catch up losslessly via `rooms.subscribe({ sinceEventSeq })`:
- `room.updated` / `room.deleted`
- `room.messageCreated` / `room.messagesRevealed` (`{ roomId, messageIds, visibleSeq }`)
- `room.streamDelta`: `{ roomId, workNodeId, attempt, eventSeq, memberId, kind: 'text' | 'thinking' | 'tool_start' | 'tool_result', delta?, toolCall? }`
- `workNode.updated`: `WorkNode` (`status`, `blockingReason?`, `usage?`)
- `inbox.updated` `[v0.1c]` / `approval.requested` `[v0.2+]`

---

## 4. Core <-> Daemon: NDJSON Process Host Protocol

Adapted from Antumi `daemon-protocol` (line-delimited UTF-8 JSON; `offset` measured in decoded **characters** to avoid splitting multibyte UTF-8 sequences):

```ts
export const DAEMON_PROTOCOL_VERSION = 1

export type DaemonRequest =
  | { id: string; method: 'info'; params: {} }
  | { id: string; method: 'spawnPipe';      params: LaunchParams }
  | { id: string; method: 'spawnPipeClean'; params: LaunchParams } // Retains CLEAN_ENV_KEYS allowlist only
  | { id: string; method: 'spawnPty';       params: LaunchParams & { cols: number; rows: number } }
  | { id: string; method: 'write';          params: { sessionId: string; data: string } }
  | { id: string; method: 'resize';         params: { sessionId: string; cols: number; rows: number } }
  | { id: string; method: 'kill';           params: { sessionId: string; force?: boolean } }
  | { id: string; method: 'attach';         params: { sessionId: string; fromOffset?: number } }
  | { id: string; method: 'list';           params: {} }
  | { id: string; method: 'release';        params: { sessionId: string } }

export interface LaunchParams {
  sessionId: string
  command: string
  args: string[]            // Never shell-concatenated; Windows shims resolved via planLaunch
  cwd: string
  env: Record<string, string>
}

export interface AttachResult {
  sessionId: string
  io: 'pipe' | 'pty'
  exited: boolean
  exitCode: number | null
  buffer: string
  bufferStart: number       // bufferStart > lastConsumedOffset signals ring buffer overflow gap
  endOffset: number
  stderr?: string           // Retained tail (up to 64KiB) in pipe mode
}
```

---

## 5. Builtin & MCP Tools (Underscore Naming Standard)

To satisfy OpenAI function calling and CLI naming limits (`^[a-zA-Z0-9_-]{1,64}$`), **dots `.` are forbidden in tool names**; all built-in tools use `snake_case`:

### 5.1 Workspace Tools (`workspace_*`, `[v0.1a]` `BuiltinDriver`)
| Tool | Arguments | Min Permission | Purpose |
| :--- | :--- | :---: | :--- |
| `workspace_list` | `{ dir?, maxDepth? }` | `read-only` | List directory entries (skips `.git`, `node_modules`) |
| `workspace_read` | `{ path, startLine?, endLine? }` | `read-only` | Read line-numbered text slice (capped at 40KiB) |
| `workspace_grep` | `{ pattern, dir?, glob? }` | `read-only` | Regex search within contained workspace paths |
| `workspace_git_diff` | `{ path? }` | `read-only` | Inspect workspace Git changes |
| `workspace_write` | `{ path, content }` | `workspace-write` | Create or overwrite file (`resolveContainedPath` checked) |
| `workspace_patch` | `{ path, oldText, newText }` | `workspace-write` | Exact substring replacement |
| `workspace_exec` | `{ command, args?, timeoutMs? }` | `workspace-write` | Shell-free execution via `daemon` with timeout & truncation |

### 5.2 Collaboration Primitives (`collab_*`, `[v0.1b]` via restart-resilient `mcp-main` + `BuiltinDriver`)
| Tool | Arguments (accepts display names & `#m<seq>` short IDs) | Behavior & Constraints |
| :--- | :--- | :--- |
| `collab_dispatch` | `{ mode: 'subtask' \| 'transfer', recipientMember: string, instruction: string, expectedResult: string, workspaceMode?: 'read-only' \| 'shared-rw' \| 'worktree', inheritWorkspaceFromNodeId?: string, resources?: string[], dependsOn?: string[] }` | Targets only active roster seats in the current room (`displayName` or `memberId`); enforces cycle detection & guardrails; `inheritWorkspaceFromNodeId` lets Reviewers share Coder's worktree |
| `collab_reply` | `{ messageId: string, text: string }` | Short clarification query (`#m12`); callee receives a single constrained reply turn |
| `collab_publish` | `{ text: string, verdict?: 'hold' \| 'changed' \| 'approve' \| 'revise' \| 'done', metadata?: Record<string, unknown> }` | Publishes final answer + structured verdict; rejected while child subtasks remain unsettled |
| `collab_history` | `{ beforeSeq?: number, limit?: number, attachmentId?: string }` | Paginated read over visible room history without spawning agents |
| `collab_remember` | `{ text: string, action?: 'add' \| 'remove' }` | Adds/removes persistent room-level shared memory |

---

## 6. Core Service Provider Interfaces (SPI)

### 6.1 `AgentDriver` & `EnvironmentIsolator`
```ts
export interface DriverCapabilities {
  supportsNativeResume: boolean
  supportsSteerWhileRunning: boolean
  supportsReadOnlyEnforcement: boolean
  supportsDynamicMcp: boolean
  supportsSubagentBlock: boolean
}

export interface IsolationProfile {
  level: 'standard' | 'fenced-ro' | 'lockdown'
  cleanEnv: boolean
  configHomeDir?: string             // e.g. CLAUDE_CONFIG_DIR (activated in v0.1b)
  blockSubagents: boolean            // Always true in multi-agent rooms
  writableDirs: string[]
  readonlyDirs: string[]             // Authorized for Read only, never --add-dir
  readableFiles: string[]            // Staged attachment file allowlist
  disallowedTools: string[]
  allowedTools: string[]
}

export interface EnvironmentIsolator {
  buildLaunchPlan(ctx: {
    agent: Agent
    workspace: Workspace
    workspaceMode: 'read-only' | 'shared-rw' | 'worktree'
    strategyPolicy: 'read-only' | 'shared-rw' | 'worktree'
    sourceTrustLevel: 'trusted' | 'untrusted'
    isMultiAgentRoom: boolean
    readableFiles: string[]
    readonlyRefPaths: string[]
  }): Promise<{ profile: IsolationProfile; configHash: string }>
}

export interface AgentDriver {
  readonly kind: DriverKind
  readonly capabilities: DriverCapabilities
  runTurn(input: TurnInput): Promise<TurnOutput>
  reattach?(session: AgentSession, replay: AttachResult, emit: (e: TurnStreamEvent) => void): Promise<TurnOutput | null>
  steer?(sessionId: string, text: string): Promise<boolean>
  disposeSession?(sessionId: string): Promise<void>
}
```

### 6.2 `CollabStrategy` (Lifecycle Hooks + Reducer + Dual Execution Model)
```ts
export type EngineAction =
  | { type: 'spawn_node'; assigneeMemberId: string; kind: WorkNodeKind; instruction: string; expectedResult?: string; parentNodeId?: string; dependsOn?: string[]; workspaceMode?: WorkspaceMode; inheritWorkspaceFromNodeId?: string; resources?: string[]; visibilityOnPublish?: MessageVisibility; superstep?: number }
  | { type: 'reveal_messages'; messageIds: string[] }
  | { type: 'post_system'; text: string; kind?: 'routing_notice' | 'system_notice' }
  | { type: 'update_strategy_state'; delta: Record<string, unknown> }
  | { type: 'set_room_state'; state: 'active' | 'running' | 'pausing' | 'paused' | 'done' }
  | { type: 'cancel_nodes'; nodeIds: string[]; reason: string }

export interface CollabStrategy<TConfig = Record<string, unknown>, TState = Record<string, unknown>> {
  readonly id: string
  readonly label: string
  readonly executionModel: 'event-driven' | 'superstep'
  readonly configSchema: z.ZodType<TConfig>
  readonly allowedTools: readonly CollabToolName[]
  readonly defaultWorkspaceMode: 'read-only' | 'shared-rw' | 'worktree'

  initialState(config: TConfig): TState
  reduceState(prev: TState, delta: Record<string, unknown>): TState

  onHumanMessage(ctx: RoomSnapshot<TConfig, TState>, msg: RoomMessage): EngineAction[]
  onNodeSettled(ctx: RoomSnapshot<TConfig, TState>, node: WorkNode): EngineAction[]
  onSuperstepBarrier?(ctx: RoomSnapshot<TConfig, TState>, superstep: number, settledNodes: WorkNode[]): EngineAction[]
  onControl?(ctx: RoomSnapshot<TConfig, TState>, action: RoomControlAction): EngineAction[]
  onMembersChanged?(ctx: RoomSnapshot<TConfig, TState>): EngineAction[]
  validateToolCall?(ctx: RoomSnapshot<TConfig, TState>, node: WorkNode, tool: CollabToolName, args: unknown): { ok: true } | { ok: false; reason: string }
}
```

### 6.3 Storage, Backup & 4 Security Hooks
```ts
export interface BlobStore {
  put(stream: NodeJS.ReadableStream, meta: { filename: string; mime: string }): Promise<FileAsset>
  getStream(storageKey: string): Promise<NodeJS.ReadableStream>
  delete(storageKey: string): Promise<void>
}

export interface BackupAdapter {
  readonly id: string
  pushSnapshot(manifest: BackupManifest, archivePath: string): Promise<{ remoteRef: string }>
  listSnapshots(): Promise<BackupManifest[]>
  restore(remoteRef: string, targetDir: string): Promise<void>
}

export interface AuthGuard {
  authorize(ctx: RequestContext, action: string, resource?: { type: string; id?: string }): Promise<{ allowed: boolean; actor: Actor; code?: 'unauthorized' | 'forbidden'; reason?: string }>
}
export interface SecretProvider {
  resolve(ref: string): Promise<string | null>
  store?(key: string, plaintext: string): Promise<string>
}
export interface Redactor {
  registerSecret(value: string): void
  scrub(text: string): string
}
export interface ApprovalGate {
  checkToolCall(req: { roomId: string; workNodeId: string; agentId: string; toolName: string; args: unknown }): Promise<{ decision: 'allow' | 'deny' | 'ask'; reason?: string }>
}
```
