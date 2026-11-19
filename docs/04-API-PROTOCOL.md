# 04. 接口与协议设计文档（API & Protocol Spec）

> **文档状态**：v2.0 定稿（已统一 MCP 工具下划线命名、补齐 `admin/admin` 登录与终端独立 WS、补齐 `CollabStrategy` 完整钩子与 `EngineAction`、补齐 `EnvironmentIsolator` 与 `AgentDriver.reattach/capabilities`、修正错误码与乐观锁）

---

## 1. 协议总览与版本协商

系统包含 **6 条清晰边界协议**（所有 Schema 在 `packages/protocol` 中以 Zod 唯一定义）：
1. **HTTP Auth / REST / Webhooks**：`http://<host>:3210/api/*`、`/webhooks/*`
2. **Web ↔ Core 控制面 WS**：`ws://<host>:3210/rpc`（JSON-RPC 2.0，需鉴权 + 同源 `Origin` 校验）
3. **Web ↔ Core 终端独立 WS**：`ws://<host>:3210/ws/terminal/:terminalId`（二进制/纯文本 PTY 帧，隔离高频大流量避免阻塞 `/rpc`）
4. **Core ↔ Daemon 进程宿主**：NDJSON over Unix Socket (`0600`) / Windows Named Pipe
5. **Agent ↔ Core 内置 MCP 工具**：独立抗重启 stdio 子进程 `mcp-main`（读 `core.json` 转发）+ `BuiltinDriver` 内存直调
6. **核心内部扩展 SPI**：`AgentDriver`、`EnvironmentIsolator`、`CollabStrategy`、`SourcePlugin`、`BlobStore`、`BackupAdapter` 与 4 个安全 Hook

- `PROTOCOL_VERSION = 1`、`DAEMON_PROTOCOL_VERSION = 1`
- 握手 `system.hello` 返回 `{ protocolVersion, serverVersion, features: string[], reconciling: boolean, defaultPasswordWarning: boolean }`。

---

## 2. HTTP REST、极简登录与 Webhook 接口

| 方法与路径 | 鉴权 | 用途 | 关键请求/响应说明 |
| :--- | :---: | :--- | :--- |
| `GET /health` | 否 | 健康检查 | `{ ok: true, daemonConnected, reconciling, uptimeMs, version }` |
| `POST /api/auth/login` | 否 | 极简登录 | `{ username, password }`（默认 `admin/admin`）→ 下发 `HttpOnly; SameSite=Lax` Cookie `myagents_sid`，同时返回 `{ ok, username, token }` |
| `POST /api/auth/logout` | 是 | 退出登录 | 清除 `auth_sessions` 行与 Cookie |
| `GET /api/auth/me` | 否 | 检查登录态 | `{ authenticated, username?, defaultPasswordWarning? }` |
| `POST /api/auth/change-password` | 是 | 修改密码 | `{ oldPassword, newPassword }` → 更新 `scryptSync` 哈希并踢出其他会话 |
| `POST /api/files/upload` | 是 | 通用附件上传 | `multipart/form-data`，按流计算 sha256 存 `BlobStore`（无扩展名去重），返回 `FileAsset` |
| `GET /api/files/:fileId` | 是 | 附件下载/预览 | 流式返回并带 `ETag` / `Content-Type` |
| `POST /api/workspaces/:workspaceId/upload` | 是 | 工作区直接上传文件 | `multipart/form-data`（带目标相对路径 `dir`），直接落盘到指定工作区目录 |
| `GET /api/workspaces/:workspaceId/download` | 是 | 工作区文件下载 | `?path=<relPath>`，经 `resolveContainedPath` 校验后流式下载 |
| `POST /webhooks/generic/:hookId` | Secret | 通用文本+文件入箱（v0.1c） | 校验 `X-Webhook-Secret`，支持 JSON/multipart 转为 `InboundEnvelope` 入箱 |
| `POST /webhooks/:pluginId/:instanceId` | 签名 | 来源插件 Webhook（v0.1c） | 交由对应 `SourcePlugin.parseWebhook()` 验签并解析 |
| `GET /*` | 否 | Web SPA 静态托管 | 生产模式托管 `packages/web/dist` |

---

## 3. Web ↔ Core：WebSocket JSON-RPC 2.0（`/rpc`）

### 3.1 握手校验与错误码
- WS 升级握手强制校验：有效 Cookie / Bearer Token + `Origin` 与 `Host` 同源（防 CSWSH 跨站劫持）。
- 错误码拆分明确：

| 错误码 | `reason` | 含义 |
| :--- | :--- | :--- |
| `-32602` | `invalid_params` | Zod 参数校验失败 |
| `-32001` | `not_found` | 资源不存在 |
| `-32002` | `conflict` | 名称冲突、状态不允许、文件 `mtime_conflict` 乐观锁冲突、Worktree 非空 |
| `-32003` | `guardrail_exceeded` | 超出委派/回复/深度/预算护栏 |
| `-32004` | `capacity_or_lock_busy` | 并发满、席位忙或资源锁占用 |
| `-32005` | `path_out_of_bounds` | 文件路径越界或符号链接逃逸 |
| `-32006` | `driver_error` | LLM API 异常或外部 CLI 失败 |
| `-32007` | `reconciling` | `core` 正在启动对账，暂拒写操作 |
| `-32010` | `unauthorized` | 未登录或会话已过期 |
| `-32011` | `forbidden` | 已登录但无权限操作该资源 |

### 3.2 核心 RPC 方法清单

> 标注 `[v0.1a]` 为第一版立即实现，标注 `[v0.1b]` / `[v0.1c]` 为后续阶段实现但协议预先定型。

#### A. 系统与模型服务商 `[v0.1a]`
- `system.hello({ clientVersion })` → `{ protocolVersion, features, daemonConnected, reconciling, defaultPasswordWarning }`
- `system.envCheck({ refresh? })` → `{ git, clis: [{ kind: 'claude', installed, version, path, ready, problem? }] }`
- `providers.list()` / `providers.save({ id?, name, kind, baseUrl, apiKeyRef?, defaultModel, models, extra? })` / `providers.delete({ id })` / `providers.probe({ id })`

#### B. Agent 管理 `[v0.1a]`
- `agents.descriptors()` → `AgentDescriptor[]`（含 `capabilities: { supportsResume, supportsSteer, supportsReadOnly, supportsMcp, supportsSubagentBlock }`）
- `agents.list({ includeArchived? })` / `agents.get({ id })`
- `agents.create({ name, bio, systemPrompt, driverKind, driverConfig, permissionMode?, isolationMode?, skillIds?, mcpServerIds?, maxRunningTurns? })` → `Agent`（自动初始化私有工作区）
- `agents.update({ id, patch })` / `agents.archive({ id, archived })`

#### C. 工作区、文件、Git 与终端 `[v0.1a]`
- `workspaces.list({ kind? })` / `workspaces.registerProject({ name?, rootPath, readonlyRefPaths? })`
- `workspaces.createWorktree({ projectWorkspaceId, baseRef?, branchSlug? })` / `workspaces.cleanWorktree({ workspaceId, force? })` `[v0.1a/b]`
- `files.tree({ workspaceId, dir?, depth? })` → `FileEntry[]`
- `files.read({ workspaceId, path })` → `{ content, encoding, size, mtimeMs, binary }`
- `files.write({ workspaceId, path, content, expectedMtimeMs? })` → `{ ok: true, mtimeMs }`（`expectedMtimeMs` 不匹配返回 `-32002 mtime_conflict`）
- `files.mkdir / files.rename / files.remove` / `files.search({ workspaceId, query, limit? })`
- `git.status({ workspaceId })` / `git.diff({ workspaceId, path?, baseCommit? })`
- `terminal.list({ workspaceId? })` / `terminal.open({ workspaceId, cols, rows })` → `{ terminalId, wsPath }` / `terminal.close({ terminalId })`
  - *(终端的实时键盘输入 `write`、窗口 `resize` 与输出流走独立的 `WS /ws/terminal/:terminalId`，不走 `/rpc`。)*

#### D. 协作空间与工作节点
- `rooms.strategies()` → `StrategyDescriptor[]` `[v0.1a]`
- `rooms.list({ strategyId?, includeArchived? })` / `rooms.get({ id })` `[v0.1a]`
- `rooms.create({ title?, strategyId, strategyConfig?, primaryWorkspaceId?, members, initialPrompt?, attachmentIds? })` `[v0.1a: single]` `[v0.1b: open-channel]` `[v0.1c: roundtable]`
- `rooms.update({ id, title?, strategyConfig?, members?, sharedMemories? })` / `rooms.archive({ id, archived })` / `rooms.delete({ id })`（走先停进程再清理的 Saga 流程） `[v0.1a]`
- `rooms.subscribe({ roomId, sinceSeq?, sinceEventSeq? })` / `rooms.unsubscribe({ roomId })` `[v0.1a]`
- `rooms.messages({ roomId, beforeSeq?, limit? })` → `{ messages: RoomMessage[], hasMore }` `[v0.1a]`
- `rooms.sendMessage({ roomId, content, attachmentIds?, replyToMsgId?, idempotencyKey })` → `{ message }`（`idempotencyKey` 必填） `[v0.1a]`
- `rooms.control({ roomId, action: 'pause' | 'resume' | 'stop' | 'next_round' | 'summarize_now' })` `[v0.1b/c]`
- `rooms.handoff({ sourceRoomId, sourceMsgId?, targetStrategyId, members, workspaceId?, seedText })` `[v0.1c]`
- `workNodes.list({ roomId, rootNodeId? })` / `workNodes.events({ nodeId, attempt?, afterSeq? })` `[v0.1a]`
- `workNodes.control({ nodeId, action: 'stop' | 'continue' | 'cancel' | 'retry' | 'reassign', targetMemberId?, note? })` `[v0.1a: stop/cancel/retry]` `[v0.1b: continue/reassign]`
- `workNodes.respondApproval({ nodeId, requestId, decision: 'allow' | 'deny', note? })` `[v0.2+ 预留]`

#### E. 统一收件箱、路由规则、能力管理 `[v0.1a 基础能力 / v0.1c 收件箱]`
- `mcpServers.list / save / delete / probe` `[v0.1a/b]`
- `skills.list / install / remove` `[v0.1a/b]`
- `webhooks.list / create / delete`、`inbox.list / get / createManual / assign / setStatus / replyExternal`、`routingRules.list / save / delete`、`plugins.list / configure / syncNow` `[v0.1c]`

### 3.3 服务端实时推送事件（Notifications）
每条流式事件带单调递增的 `eventSeq`，支持客户端断线重连通过 `rooms.subscribe({ sinceEventSeq })` 无损补齐：
- `room.updated` / `room.deleted`
- `room.messageCreated` / `room.messagesRevealed`（携带 `{ roomId, messageIds, visibleSeq }`）
- `room.streamDelta`：`{ roomId, workNodeId, attempt, eventSeq, memberId, kind: 'text' | 'thinking' | 'tool_start' | 'tool_result', delta?, toolCall? }`
- `workNode.updated`：`WorkNode`（含 `status`, `blockingReason?`, `usage?`）
- `inbox.updated` `[v0.1c]` / `approval.requested` `[v0.2+]`

---

## 4. Core ↔ Daemon：NDJSON 进程宿主协议

复用 Antumi 的 `daemon-protocol` 设计（UTF-8 行分隔 JSON；`offset` 按流式 UTF-8 解码后的**字符数**计量，防止多字节字符被截断乱码）：

```ts
export const DAEMON_PROTOCOL_VERSION = 1

export type DaemonRequest =
  | { id: string; method: 'info'; params: {} }
  | { id: string; method: 'spawnPipe';      params: LaunchParams }
  | { id: string; method: 'spawnPipeClean'; params: LaunchParams } // 仅保留 CLEAN_ENV_KEYS 白名单
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
  args: string[]            // 严禁拼接 shell 字符串，Windows 先经 planLaunch 解析 .cmd
  cwd: string
  env: Record<string, string>
}

export interface AttachResult {
  sessionId: string
  io: 'pipe' | 'pty'
  exited: boolean
  exitCode: number | null
  buffer: string
  bufferStart: number       // 若 bufferStart > lastConsumedOffset 说明发生缓冲溢出缺口
  endOffset: number
  stderr?: string           // pipe 模式保留最近 64KiB stderr
}
```

---

## 5. 内置工具与 MCP 规范（全链路下划线命名）

为兼容所有 OpenAI Function Calling 及 CLI 工具名规范（`^[a-zA-Z0-9_-]{1,64}$`），**严禁在工具名中使用点号 `.`**，统一采用下划线命名：

### 5.1 工作区工具（`workspace_*`，`[v0.1a]` 内置 `BuiltinDriver` 标配）
| 工具名 | 参数 | 权限要求 | 说明 |
| :--- | :--- | :---: | :--- |
| `workspace_list` | `{ dir?, maxDepth? }` | `read-only` | 列出目录文件（自动跳过 `.git`、`node_modules`） |
| `workspace_read` | `{ path, startLine?, endLine? }` | `read-only` | 带行号读取文本文件（上限 40KiB） |
| `workspace_grep` | `{ pattern, dir?, glob? }` | `read-only` | 正则搜索工作区内容 |
| `workspace_git_diff` | `{ path? }` | `read-only` | 查看当前工作区 Git 改动 |
| `workspace_write` | `{ path, content }` | `workspace-write` | 写入或新建文件（经 `resolveContainedPath` 校验） |
| `workspace_patch` | `{ path, oldText, newText }` | `workspace-write` | 局部精确替换（避免大文件整篇重写） |
| `workspace_exec` | `{ command, args?, timeoutMs? }` | `workspace-write` | 经 `daemon` 无 shell 执行命令并限时截断输出 |

### 5.2 协作原语工具（`collab_*`，`[v0.1b]` 经抗重启 `mcp-main` 暴露给 Claude 及内置 Agent）
| 工具名 | 参数（面向 LLM 友好：支持传成员名与短消息 ID） | 行为与约束 |
| :--- | :--- | :--- |
| `collab_dispatch` | `{ mode: 'subtask' \| 'transfer', recipientMember: string, instruction: string, expectedResult: string, workspaceMode?: 'read-only' \| 'shared-rw' \| 'worktree', inheritWorkspaceFromNodeId?: string, resources?: string[], dependsOn?: string[] }` | 仅允许派发给当前 Room 在编席位（按 `displayName` 或 `memberId` 解析）；校验护栏与环检测；`inheritWorkspaceFromNodeId` 支持 Reviewer 复用 Coder 的同一个 Worktree |
| `collab_reply` | `{ messageId: string, text: string }` | 针对指定消息短追问（支持 `#m12` 短 ID），对方仅获 1 轮受限回复权（禁再派活） |
| `collab_publish` | `{ text: string, verdict?: 'hold' \| 'changed' \| 'approve' \| 'revise' \| 'done', metadata?: Record<string, unknown> }` | 正式交卷并附结构化结论；若当前回合存在未结束子任务则拒绝调用 |
| `collab_history` | `{ beforeSeq?: number, limit?: number, attachmentId?: string }` | 分页读历史可见消息或附件，不触发任何 Agent |
| `collab_remember` | `{ text: string, action?: 'add' \| 'remove' }` | 写入/删除 Room 级共享记忆 |

---

## 6. 核心内部扩展接口（SPI）

### 6.1 `AgentDriver` 与 `EnvironmentIsolator`
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
  configHomeDir?: string             // e.g. CLAUDE_CONFIG_DIR（v0.1b 激活）
  blockSubagents: boolean            // 多 Agent 房间强制 true
  writableDirs: string[]
  readonlyDirs: string[]             // 不传 --add-dir，仅授权 Read + 禁 Edit
  readableFiles: string[]            // 附件精确单文件授权
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

### 6.2 `CollabStrategy`（完整钩子 + Reducer + 双节拍）
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
  // 纯函数状态归约器（借鉴 LangGraph Reducer），绝不直接覆盖外部状态
  reduceState(prev: TState, delta: Record<string, unknown>): TState

  onHumanMessage(ctx: RoomSnapshot<TConfig, TState>, msg: RoomMessage): EngineAction[]
  onNodeSettled(ctx: RoomSnapshot<TConfig, TState>, node: WorkNode): EngineAction[]
  onSuperstepBarrier?(ctx: RoomSnapshot<TConfig, TState>, superstep: number, settledNodes: WorkNode[]): EngineAction[]
  onControl?(ctx: RoomSnapshot<TConfig, TState>, action: RoomControlAction): EngineAction[]
  onMembersChanged?(ctx: RoomSnapshot<TConfig, TState>): EngineAction[]
  validateToolCall?(ctx: RoomSnapshot<TConfig, TState>, node: WorkNode, tool: CollabToolName, args: unknown): { ok: true } | { ok: false; reason: string }
}
```

### 6.3 存储、备份与 4 个安全 Hook 接口
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
