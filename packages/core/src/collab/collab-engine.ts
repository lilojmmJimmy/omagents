import { randomUUID } from 'node:crypto'
import {
  COLLAB_TOOLS,
  LOCK_HOLDING_STATUSES,
  SETTLED_NODE_STATUSES,
  type CollabStrategy,
  type CollabToolName,
  type DriverKind,
  type EngineAction,
  type EnvironmentIsolator,
  type FileRef,
  type NodeEvent,
  type RoomControlAction,
  type RoomDetail,
  type RoomMember,
  type RoomMessage,
  type RoomSnapshot,
  type RoomSummary,
  type SharedMemory,
  type StreamDeltaNotification,
  type WorkNode,
  type WorkNodeControlAction,
  type WorkspaceMode
} from '@myagents/protocol'
import { myagentsAgentHomePath, type SessionInfo } from '@myagents/protocol/node'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import { writeRoomMemberMcpConfig } from '../mcp/mcp-config'
import type { McpRegistryService } from '../mcp/mcp-registry'
import type { AgentService } from '../runtime/agent-service'
import { resolveClaudeSessionFilePath } from '../runtime/claude-driver'
import type { AgentDriver, SessionRecord, TurnStreamEvent } from '../runtime/driver'
import type { SkillRegistryService } from '../runtime/skill-registry'
import type { BlobService } from '../storage/blob-service'
import type { CoreDatabase } from '../storage/database'
import type { WorkspaceService } from '../workspace/workspace-service'
import { buildTurnContext } from './context-builder'
import { openChannelStrategy, RESUME_COMMAND_REGEX } from './open-channel-strategy'
import { roundtableStrategy } from './roundtable-strategy'
import { buildNodeClaims, ResourceLockManager, type ResourceClaim } from './rw-lock'
import { singleStrategy } from './single-strategy'

export interface CollabEvents {
  roomUpdated(room: RoomSummary): void
  roomDeleted(roomId: string): void
  messageCreated(msg: RoomMessage): void
  messagesRevealed?(ev: { roomId: string; messageIds: string[]; visibleSeq: number }): void
  streamDelta(delta: StreamDeltaNotification): void
  workNodeUpdated(node: WorkNode): void
  rootNodeSettled?(node: WorkNode): void
}

function parseVisibilityOnPublish(raw: string | null | undefined): {
  visibilityScope: RoomMessage['visibilityScope']
  visibleTo: string[]
} {
  try {
    const parsed = JSON.parse(raw || '{}') as { scope?: string; allowedMemberIds?: unknown }
    if (parsed.scope === 'private') {
      return {
        visibilityScope: 'private',
        visibleTo: Array.isArray(parsed.allowedMemberIds) ? parsed.allowedMemberIds.map(String) : []
      }
    }
  } catch {
    // ignore malformed visibility json
  }
  return { visibilityScope: 'public', visibleTo: [] }
}

interface RoomRow {
  id: string
  title: string
  purpose: string
  strategy_id: string
  strategy_config_json: string
  strategy_state_json: string
  state: RoomDetail['state']
  primary_workspace_id: string | null
  shared_memories_json: string
  summary_text: string | null
  summary_upto_seq: number
  last_seq: number
  pinned_at: number | null
  archived_at: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

interface MemberRow {
  id: string
  room_id: string
  agent_id: string
  agent_name?: string
  driver_kind?: string
  isolation_mode?: string
  default_workspace_id?: string
  native_session_id?: string | null
  display_name: string
  role_kind: RoomMember['roleKind']
  role_prompt: string
  position: number
  joined_at: number
  removed_at: number | null
}

interface MessageRow {
  id: string
  room_id: string
  seq: number
  visible_seq: number
  author_kind: RoomMessage['authorKind']
  author_id: string
  author_name: string
  kind: RoomMessage['kind']
  content: string
  attachments_json: string
  reply_to_msg_id: string | null
  work_node_id: string | null
  visibility_scope: RoomMessage['visibilityScope']
  visible_to_json: string
  meta_json: string
  created_at: number
}

interface WorkNodeRow {
  id: string
  room_id: string
  root_node_id: string
  parent_node_id: string | null
  supersedes_node_id: string | null
  transferred_to_node_id: string | null
  request_msg_id: string | null
  assignee_member_id: string
  assignee_agent_id: string
  kind: WorkNode['kind']
  status: WorkNode['status']
  blocking_reason: string | null
  superstep: number | null
  lease_token: string | null
  instruction: string
  expected_result: string | null
  workspace_mode: WorkNode['workspaceMode']
  workspace_id: string | null
  resources_json: string
  visibility_on_publish: string
  source_trust_level?: 'trusted' | 'untrusted'
  result_text: string | null
  result_json: string | null
  usage_json: string | null
  error_text: string | null
  attempt: number
  depth: number
  delivered_at: number | null
  created_at: number
  started_at: number | null
  ended_at: number | null
  updated_at: number
}

interface DeliveryRow {
  id: string
  room_id: string
  target_node_id: string
  child_node_ids_json: string
  payload_text: string
  status: 'pending' | 'sent'
  created_at: number
  sent_at: number | null
}

interface SessionRow {
  id: string
  room_id: string
  room_member_id: string
  agent_id: string
  driver_kind: DriverKind
  daemon_session_id: string | null
  native_session_id: string | null
  config_hash: string | null
  last_delivered_seq: number
  last_consumed_offset: number
  status: string
}

interface NodeEventRow {
  id: string
  node_id: string
  attempt: number
  seq: number
  kind: NodeEvent['kind']
  payload_json: string
  created_at: number
}

function mapMember(r: MemberRow, sessionFilePath: string | null): RoomMember {
  return {
    id: r.id,
    roomId: r.room_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    driverKind: r.driver_kind,
    displayName: r.display_name,
    roleKind: r.role_kind,
    rolePrompt: r.role_prompt,
    position: r.position,
    joinedAt: r.joined_at,
    removedAt: r.removed_at,
    nativeSessionId: r.native_session_id ?? null,
    sessionFilePath
  }
}

function mapMessage(r: MessageRow): RoomMessage {
  return {
    id: r.id,
    roomId: r.room_id,
    seq: r.seq,
    visibleSeq: r.visible_seq,
    authorKind: r.author_kind,
    authorId: r.author_id,
    authorName: r.author_name,
    kind: r.kind,
    content: r.content,
    attachments: JSON.parse(r.attachments_json || '[]') as FileRef[],
    replyToMsgId: r.reply_to_msg_id,
    workNodeId: r.work_node_id,
    visibilityScope: r.visibility_scope,
    visibleTo: JSON.parse(r.visible_to_json || '[]') as string[],
    meta: JSON.parse(r.meta_json || '{}') as Record<string, unknown>,
    createdAt: r.created_at
  }
}

function mapNode(r: WorkNodeRow): WorkNode {
  return {
    id: r.id,
    roomId: r.room_id,
    rootNodeId: r.root_node_id,
    parentNodeId: r.parent_node_id,
    supersedesNodeId: r.supersedes_node_id,
    transferredToNodeId: r.transferred_to_node_id,
    requestMsgId: r.request_msg_id,
    assigneeMemberId: r.assignee_member_id,
    assigneeAgentId: r.assignee_agent_id,
    kind: r.kind,
    status: r.status,
    blockingReason: r.blocking_reason ?? null,
    superstep: r.superstep,
    instruction: r.instruction,
    expectedResult: r.expected_result,
    workspaceMode: r.workspace_mode,
    workspaceId: r.workspace_id,
    resources: JSON.parse(r.resources_json || '[]') as string[],
    resultText: r.result_text,
    resultJson: r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
    usage: r.usage_json ? (JSON.parse(r.usage_json) as WorkNode['usage']) : null,
    errorText: r.error_text,
    attempt: r.attempt,
    depth: r.depth,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at
  }
}

export class CollabEngine {
  private readonly strategies = new Map<string, CollabStrategy<any, any>>()
  private readonly drivers = new Map<DriverKind, AgentDriver>()
  private readonly roomChains = new Map<string, Promise<unknown>>()
  private readonly locks = new ResourceLockManager()
  private readonly agentRunningCounts = new Map<string, number>()
  private readonly inFlight = new Map<string, { leaseToken: string; abort: AbortController; agentId: string }>()
  private tickScheduled = false
  private reconciling = true
  private eventSeqCounter = 0

  private readonly mcpRegistry?: McpRegistryService
  private readonly skillRegistry?: SkillRegistryService
  private readonly blobs?: BlobService

  constructor(
    private readonly database: CoreDatabase,
    private readonly agents: AgentService,
    private readonly workspaces: WorkspaceService,
    private readonly isolator: EnvironmentIsolator,
    private readonly daemon: DaemonClient,
    private readonly events: CollabEvents,
    extensions?: { mcpRegistry?: McpRegistryService; skillRegistry?: SkillRegistryService; blobs?: BlobService }
  ) {
    this.mcpRegistry = extensions?.mcpRegistry
    this.skillRegistry = extensions?.skillRegistry
    this.blobs = extensions?.blobs
    this.registerStrategy(singleStrategy)
    this.registerStrategy(openChannelStrategy)
    this.registerStrategy(roundtableStrategy)
  }

  get isReconciling(): boolean {
    return this.reconciling
  }

  registerStrategy(strategy: CollabStrategy<any, any>): void {
    this.strategies.set(strategy.id, strategy)
  }

  registerDriver(driver: AgentDriver): void {
    this.drivers.set(driver.kind, driver)
  }

  listStrategies() {
    return [...this.strategies.values()].map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      executionModel: s.executionModel,
      defaultWorkspaceMode: s.defaultWorkspaceMode
    }))
  }

  // Startup reconcile before opening write endpoints & scheduler
  async reconcile(liveDaemonSessions: SessionInfo[]): Promise<void> {
    const liveMap = new Map(liveDaemonSessions.map((s) => [s.sessionId, s]))
    const now = Date.now()

    this.database.transaction(() => {
      // 1. Reconcile external agent sessions against live daemon sessions
      const sessions = this.database.db.prepare('SELECT * FROM agent_sessions').all() as unknown as SessionRow[]
      for (const s of sessions) {
        if (!s.daemon_session_id) continue
        const live = liveMap.get(s.daemon_session_id)
        if (!live || live.exited) {
          this.database.db
            .prepare("UPDATE agent_sessions SET daemon_session_id = NULL, status = 'hibernated', updated_at = ? WHERE id = ?")
            .run(now, s.id)
        } else {
          this.database.db
            .prepare("UPDATE agent_sessions SET status = 'ready', updated_at = ? WHERE id = ?")
            .run(now, s.id)
        }
      }

      // 2. Any work_node stuck in starting/running across core restart is marked failed(core_restarted)
      //    so the user can explicitly Retry without risking duplicate side effects.
      const stuck = this.database.db
        .prepare("SELECT * FROM work_nodes WHERE status IN ('starting', 'running')")
        .all() as unknown as WorkNodeRow[]
      const touchedRooms = new Set<string>()
      for (const n of stuck) {
        this.database.db
          .prepare(
            "UPDATE work_nodes SET status = 'failed', lease_token = NULL, error_text = 'core_restarted', ended_at = ?, updated_at = ? WHERE id = ?"
          )
          .run(now, now, n.id)
        touchedRooms.add(n.room_id)
      }
      for (const roomId of touchedRooms) {
        this.database.db.prepare("UPDATE rooms SET state = 'active', updated_at = ? WHERE id = ? AND state = 'running'").run(now, roomId)
      }

      // 3. Scan pending work_deliveries and wake target parents atomically
      const pendingDeliveries = this.database.db
        .prepare("SELECT * FROM work_deliveries WHERE status = 'pending' ORDER BY created_at ASC")
        .all() as unknown as DeliveryRow[]
      for (const d of pendingDeliveries) {
        this.deliverWorkDeliveryTx(d.id, now)
      }
    })

    this.reconciling = false
    this.scheduleTick()
  }

  private serially<T>(roomId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.roomChains.get(roomId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.roomChains.set(roomId, next)
    next.finally(() => {
      if (this.roomChains.get(roomId) === next) this.roomChains.delete(roomId)
    })
    return next
  }

  private getMembers(roomId: string, primaryWorkspaceId?: string | null): RoomMember[] {
    const rows = this.database.db
      .prepare(
        `SELECT m.*, a.name AS agent_name, a.driver_kind AS driver_kind, a.isolation_mode AS isolation_mode,
                a.default_workspace_id AS default_workspace_id, s.native_session_id AS native_session_id
         FROM room_members m
         JOIN agents a ON a.id = m.agent_id
         LEFT JOIN agent_sessions s ON s.room_member_id = m.id
         WHERE m.room_id = ? AND m.removed_at IS NULL
         ORDER BY m.position ASC`
      )
      .all(roomId) as unknown as MemberRow[]
    return rows.map((r) => {
      let sessionFilePath: string | null = null
      // Only surface JSONL file path for file-backed external sessions (e.g. Claude Code CLI).
      // Built-in agent sessions are persisted in SQLite DB and intentionally omit a file path.
      if (r.driver_kind === 'claude' && r.native_session_id) {
        const wsId = primaryWorkspaceId || r.default_workspace_id
        if (wsId) {
          try {
            const ws = this.workspaces.get(wsId)
            const configHomeDir =
              r.isolation_mode === 'isolated-home' || r.isolation_mode === 'lockdown'
                ? myagentsAgentHomePath(`agent-${r.agent_id}`)
                : null
            sessionFilePath = resolveClaudeSessionFilePath(ws.rootPath, r.native_session_id, configHomeDir)
          } catch {
            sessionFilePath = null
          }
        }
      }
      return mapMember(r, sessionFilePath)
    })
  }

  private mapRoom(row: RoomRow): RoomDetail {
    const members = this.getMembers(row.id, row.primary_workspace_id)
    const activeCountRow = this.database.db
      .prepare("SELECT COUNT(*) AS c FROM work_nodes WHERE room_id = ? AND status IN ('queued','waiting_deps','waiting_lock','starting','running','waiting_children')")
      .get(row.id) as { c: number }
    const latestNodeRow = this.database.db
      .prepare(
        'SELECT id, root_node_id, request_msg_id, superstep FROM work_nodes WHERE room_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1'
      )
      .get(row.id) as
      | { id: string; root_node_id: string; request_msg_id: string | null; superstep: number | null }
      | undefined
    let hasFailedNode = false
    if (latestNodeRow) {
      const failedRow = this.database.db
        .prepare(
          `SELECT wn.id
           FROM work_nodes wn
           WHERE wn.room_id = ?
             AND wn.status = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM work_nodes rep WHERE rep.room_id = wn.room_id AND rep.supersedes_node_id = wn.id
             )
             AND (
               wn.root_node_id = ?
               OR (? IS NOT NULL AND wn.request_msg_id = ?)
               OR (? IS NOT NULL AND wn.superstep = ?)
             )
           LIMIT 1`
        )
        .get(
          row.id,
          latestNodeRow.root_node_id,
          latestNodeRow.request_msg_id,
          latestNodeRow.request_msg_id,
          latestNodeRow.superstep,
          latestNodeRow.superstep
        )
      hasFailedNode = Boolean(failedRow)
    }
    return {
      id: row.id,
      title: row.title,
      purpose: row.purpose,
      strategyId: row.strategy_id,
      strategyConfig: JSON.parse(row.strategy_config_json || '{}') as Record<string, unknown>,
      strategyState: JSON.parse(row.strategy_state_json || '{}') as Record<string, unknown>,
      state: row.state,
      primaryWorkspaceId: row.primary_workspace_id,
      sharedMemories: JSON.parse(row.shared_memories_json || '[]') as RoomDetail['sharedMemories'],
      summaryText: row.summary_text,
      summaryUptoSeq: row.summary_upto_seq,
      lastSeq: row.last_seq,
      pinnedAt: row.pinned_at,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members,
      activeNodeCount: activeCountRow?.c ?? 0,
      hasFailedNode
    }
  }

  listRooms(includeArchived = false): RoomSummary[] {
    const sql = includeArchived
      ? 'SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC'
      : 'SELECT * FROM rooms WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC'
    const rows = this.database.db.prepare(sql).all() as unknown as RoomRow[]
    return rows.map((r) => this.mapRoom(r))
  }

  getRoom(id: string): RoomDetail {
    const row = this.database.db.prepare('SELECT * FROM rooms WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as RoomRow | undefined
    if (!row) throw Errors.notFound(`Room not found: ${id}`)
    return this.mapRoom(row)
  }

  listMessages(roomId: string, beforeSeq?: number, limit = 80): { messages: RoomMessage[]; hasMore: boolean } {
    this.getRoom(roomId)
    const cap = Math.min(200, Math.max(1, limit))
    const rows = beforeSeq
      ? (this.database.db
          .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(roomId, beforeSeq, cap + 1) as unknown as MessageRow[])
      : (this.database.db
          .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?')
          .all(roomId, cap + 1) as unknown as MessageRow[])
    const hasMore = rows.length > cap
    const slice = rows.slice(0, cap).reverse()
    return { messages: slice.map(mapMessage), hasMore }
  }

  listWorkNodes(roomId: string): WorkNode[] {
    this.getRoom(roomId)
    const rows = this.database.db
      .prepare('SELECT * FROM work_nodes WHERE room_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(roomId) as unknown as WorkNodeRow[]
    return rows.map(mapNode)
  }

  listNodeEvents(nodeId: string, attempt?: number): NodeEvent[] {
    const rows = attempt
      ? (this.database.db
          .prepare('SELECT * FROM node_events WHERE node_id = ? AND attempt = ? ORDER BY seq ASC')
          .all(nodeId, attempt) as unknown as NodeEventRow[])
      : (this.database.db
          .prepare('SELECT * FROM node_events WHERE node_id = ? ORDER BY attempt ASC, seq ASC')
          .all(nodeId) as unknown as NodeEventRow[])
    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      attempt: r.attempt,
      seq: r.seq,
      kind: r.kind,
      payload: JSON.parse(r.payload_json || '{}') as Record<string, unknown>,
      createdAt: r.created_at
    }))
  }

  async createRoom(input: {
    title?: string
    purpose?: string
    strategyId: string
    strategyConfig?: Record<string, unknown>
    primaryWorkspaceId?: string | null
    members: Array<{ agentId: string; displayName?: string; roleKind?: RoomMember['roleKind']; rolePrompt?: string }>
    initialPrompt?: string
  }): Promise<RoomDetail> {
    if (this.reconciling) throw Errors.reconciling()
    const strategy = this.strategies.get(input.strategyId)
    if (!strategy) throw Errors.invalidParams(`Unknown strategy: ${input.strategyId}`)
    if (input.members.length === 0) throw Errors.invalidParams('At least one member agent is required')

    const resolvedAgents = input.members.map((m) => {
      const a = this.agents.get(m.agentId)
      if (a.archivedAt) throw Errors.conflict('agent_archived', `Agent ${a.name} is archived`)
      return { input: m, agent: a }
    })

    if (input.primaryWorkspaceId) {
      this.workspaces.get(input.primaryWorkspaceId)
    }

    const parsedConfig = strategy.configSchema.parse(input.strategyConfig ?? {})
    const initialState = strategy.initialState(parsedConfig)
    const id = randomUUID()
    const now = Date.now()
    const defaultTitle =
      input.title?.trim() ||
      (input.strategyId === 'single' ? `${resolvedAgents[0]!.agent.name}` : `Room (${resolvedAgents.map((r) => r.agent.name).join(', ')})`)

    this.database.transaction(() => {
      const primaryWorkspaceId = input.primaryWorkspaceId
        ? input.primaryWorkspaceId
        : input.strategyId === 'single'
          ? resolvedAgents[0]!.agent.defaultWorkspaceId
          : this.workspaces.createRoomSharedWorkspace(id, defaultTitle).id

      this.database.db
        .prepare(
          `INSERT INTO rooms (id, title, purpose, strategy_id, strategy_config_json, strategy_state_json, state, primary_workspace_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        )
        .run(
          id,
          defaultTitle,
          input.purpose ?? '',
          strategy.id,
          JSON.stringify(parsedConfig),
          JSON.stringify(initialState),
          primaryWorkspaceId,
          now,
          now
        )

      resolvedAgents.forEach(({ input: m, agent }, idx) => {
        const memberId = randomUUID()
        this.database.db
          .prepare(
            `INSERT INTO room_members (id, room_id, agent_id, display_name, role_kind, role_prompt, position, joined_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(memberId, id, agent.id, m.displayName?.trim() || agent.name, m.roleKind ?? 'member', m.rolePrompt ?? '', idx, now)

        this.database.db
          .prepare(
            `INSERT INTO agent_sessions (id, room_id, room_member_id, agent_id, driver_kind, status, last_active_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'cold', ?, ?, ?)`
          )
          .run(randomUUID(), id, memberId, agent.id, agent.driverKind, now, now, now)
      })
    })

    const created = this.getRoom(id)
    this.events.roomUpdated(created)

    if (input.initialPrompt?.trim()) {
      await this.sendMessage(id, {
        content: input.initialPrompt.trim(),
        idempotencyKey: `init-${id}`
      })
    }
    return this.getRoom(id)
  }

  async deleteRoom(roomId: string): Promise<void> {
    this.getRoom(roomId)
    const now = Date.now()

    // 1. Soft delete first to block new scheduling
    this.database.db.prepare('UPDATE rooms SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, roomId)

    // 2. Abort in-flight work nodes
    const nodes = this.database.db
      .prepare("SELECT id FROM work_nodes WHERE room_id = ? AND status NOT IN ('completed','failed','cancelled')")
      .all(roomId) as Array<{ id: string }>
    for (const n of nodes) {
      const flight = this.inFlight.get(n.id)
      flight?.abort.abort()
    }

    // 3. Dispose external CLI daemon sessions
    const sessions = this.database.db
      .prepare('SELECT * FROM agent_sessions WHERE room_id = ?')
      .all(roomId) as unknown as SessionRow[]
    for (const s of sessions) {
      if (s.daemon_session_id) {
        await this.daemon.call('release', { sessionId: s.daemon_session_id }).catch(() => {})
      }
    }

    // 4. Release blob refs before hard-deleting room & cascaded messages
    if (this.blobs) {
      const msgRows = this.database.db
        .prepare('SELECT id FROM room_messages WHERE room_id = ?')
        .all(roomId) as Array<{ id: string }>
      this.blobs.releaseOwnerRefs(
        'message',
        msgRows.map((m) => m.id)
      )
      this.blobs.releaseOwnerRefs('room', [roomId])
    }

    // 5. Hard delete rows
    this.database.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
    this.events.roomDeleted(roomId)
  }

  async sendMessage(
    roomId: string,
    input: {
      content: string
      authorName?: string
      authorKind?: RoomMessage['authorKind']
      authorId?: string
      messageKind?: RoomMessage['kind']
      sourceTrustLevel?: 'trusted' | 'untrusted'
      forceReadOnly?: boolean
      attachments?: FileRef[]
      replyToMsgId?: string
      idempotencyKey: string
    }
  ): Promise<RoomMessage> {
    return (await this.sendMessageDetailed(roomId, input)).message
  }

  async sendMessageDetailed(
    roomId: string,
    input: {
      content: string
      authorName?: string
      authorKind?: RoomMessage['authorKind']
      authorId?: string
      messageKind?: RoomMessage['kind']
      sourceTrustLevel?: 'trusted' | 'untrusted'
      forceReadOnly?: boolean
      attachments?: FileRef[]
      replyToMsgId?: string
      idempotencyKey: string
    }
  ): Promise<{ message: RoomMessage; spawnedRootNodeIds: string[] }> {
    if (this.reconciling) throw Errors.reconciling()
    const hasAttachments = Boolean(input.attachments && input.attachments.length > 0)
    const effectiveContent = input.content.trim()
      ? input.content
      : hasAttachments
        ? `[Attached ${input.attachments!.length} file(s)]`
        : ''
    if (!effectiveContent.trim()) throw Errors.invalidParams('Message content or attachment is required')
    if (!input.idempotencyKey?.trim()) throw Errors.invalidParams('idempotencyKey is required')

    return await this.serially(roomId, () => {
      // Idempotency check
      const dup = this.database.db
        .prepare('SELECT * FROM room_messages WHERE room_id = ? AND idempotency_key = ?')
        .get(roomId, input.idempotencyKey) as unknown as MessageRow | undefined
      if (dup) {
        const existingRoots = this.database.db
          .prepare('SELECT id FROM work_nodes WHERE request_msg_id = ? AND parent_node_id IS NULL ORDER BY created_at ASC')
          .all(dup.id) as Array<{ id: string }>
        return { message: mapMessage(dup), spawnedRootNodeIds: existingRoots.map((r) => r.id) }
      }

      const emittedMessages: RoomMessage[] = []
      const emittedNodes: WorkNode[] = []
      const emittedReveals: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }> = []
      const spawnedRootNodeIds: string[] = []

      const createdMsg = this.database.transaction(() => {
        const room = this.getRoom(roomId)
        const strategy = this.strategies.get(room.strategyId)
        if (!strategy) throw Errors.invalidParams(`Missing strategy: ${room.strategyId}`)

        const authorKind = input.authorKind ?? 'human'
        const msg = this.insertMessageTx(roomId, {
          authorKind,
          authorId: input.authorId ?? (authorKind === 'intake' ? 'intake' : 'human'),
          authorName: input.authorName || 'admin',
          kind: input.messageKind ?? 'chat',
          content: effectiveContent,
          attachments: input.attachments ?? [],
          replyToMsgId: input.replyToMsgId ?? null,
          workNodeId: null,
          visibilityScope: 'public',
          visibleTo: [],
          meta: {},
          idempotencyKey: input.idempotencyKey
        })
        if (this.blobs && msg.attachments.length > 0) {
          this.blobs.attachRefs(
            msg.attachments.map((a) => a.fileId),
            'message',
            msg.id
          )
        }
        emittedMessages.push(msg)

        // Update auto-title on first message if still default
        if (msg.seq === 1 && room.strategyId === 'single') {
          const shortTitle = effectiveContent.split(/\r?\n/)[0]?.trim().slice(0, 40)
          if (shortTitle) {
            this.database.db.prepare('UPDATE rooms SET title = ?, updated_at = ? WHERE id = ?').run(shortTitle, Date.now(), roomId)
          }
        }

        // Handle Chinese/English resume directive when a paused root node exists in open-channel
        if (room.strategyId === 'open-channel' && RESUME_COMMAND_REGEX.test(input.content.trim())) {
          const pausedRoot = this.database.db
            .prepare(
              "SELECT * FROM work_nodes WHERE room_id = ? AND parent_node_id IS NULL AND status = 'paused' ORDER BY updated_at DESC LIMIT 1"
            )
            .get(roomId) as unknown as WorkNodeRow | undefined
          if (pausedRoot) {
            const now = Date.now()
            this.database.db
              .prepare(
                "UPDATE work_nodes SET status = 'queued', attempt = attempt + 1, error_text = NULL, blocking_reason = NULL, lease_token = NULL, ended_at = NULL, updated_at = ? WHERE id = ?"
              )
              .run(now, pausedRoot.id)
            this.database.db.prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ?").run(now, roomId)
            emittedNodes.push(
              mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(pausedRoot.id) as unknown as WorkNodeRow)
            )
            spawnedRootNodeIds.push(pausedRoot.id)
            emittedMessages.push(
              this.insertMessageTx(roomId, {
                authorKind: 'system',
                authorId: 'system',
                authorName: 'System',
                kind: 'routing_notice',
                content: '已收到继续指令，恢复暂停的任务节点。',
                attachments: [],
                replyToMsgId: msg.id,
                workNodeId: null,
                visibilityScope: 'public',
                visibleTo: [],
                meta: {}
              })
            )
            return msg
          }
        }

        const snapshot = this.buildSnapshotTx(roomId)
        const actions = strategy.onHumanMessage(snapshot, msg)
        const res = this.applyActionsTx(roomId, strategy, actions, msg.id, false, {
          sourceTrustLevel: input.forceReadOnly ? 'untrusted' : (input.sourceTrustLevel ?? 'trusted'),
          forceReadOnly: Boolean(input.forceReadOnly)
        })
        emittedMessages.push(...res.messages)
        emittedNodes.push(...res.nodes)
        emittedReveals.push(...res.revealed)
        for (const n of res.nodes) {
          if (n.parentNodeId === null) spawnedRootNodeIds.push(n.id)
        }
        return msg
      })

      for (const m of emittedMessages) this.events.messageCreated(m)
      for (const r of emittedReveals) this.events.messagesRevealed?.(r)
      for (const n of emittedNodes) this.events.workNodeUpdated(n)
      this.events.roomUpdated(this.getRoom(roomId))
      this.scheduleTick()
      return { message: createdMsg, spawnedRootNodeIds }
    })
  }

  async handoffRoom(input: {
    sourceRoomId: string
    sourceMsgId?: string
    targetStrategyId: string
    title?: string
    members: Array<{ agentId: string; displayName?: string; roleKind?: RoomMember['roleKind']; rolePrompt?: string }>
    workspaceId?: string | null
    seedText?: string
  }): Promise<RoomDetail> {
    if (this.reconciling) throw Errors.reconciling()
    const source = this.getRoom(input.sourceRoomId)
    let seedContent = input.seedText?.trim() || ''
    if (!seedContent && input.sourceMsgId) {
      const msgRow = this.database.db
        .prepare('SELECT content FROM room_messages WHERE id = ? AND room_id = ?')
        .get(input.sourceMsgId, input.sourceRoomId) as { content: string } | undefined
      if (!msgRow) throw Errors.notFound(`Source message not found in room: ${input.sourceMsgId}`)
      seedContent = msgRow.content
    }
    if (!seedContent) {
      const sumRow = this.database.db
        .prepare(
          "SELECT content FROM room_messages WHERE room_id = ? AND kind IN ('summary', 'result', 'chat') AND author_kind = 'agent' ORDER BY seq DESC LIMIT 1"
        )
        .get(input.sourceRoomId) as { content: string } | undefined
      seedContent = sumRow?.content || source.title
    }

    const created = await this.createRoom({
      title: input.title?.trim() || `${source.title} · 执行`,
      purpose: `Handoff from ${source.id}`,
      strategyId: input.targetStrategyId,
      primaryWorkspaceId: input.workspaceId === undefined ? source.primaryWorkspaceId : input.workspaceId,
      members: input.members
    })

    if (source.sharedMemories.length > 0) {
      const copied = source.sharedMemories.map((m) => ({ ...m, id: randomUUID() }))
      this.database.db
        .prepare('UPDATE rooms SET shared_memories_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(copied), Date.now(), created.id)
      this.events.roomUpdated(this.getRoom(created.id))
    }

    const notice = await this.serially(input.sourceRoomId, () => {
      const msg = this.insertMessageTx(input.sourceRoomId, {
        authorKind: 'system',
        authorId: 'system',
        authorName: 'System',
        kind: 'routing_notice',
        content: `已将结论转交至新协作房间「${created.title}」(${created.strategyId}) 执行。`,
        attachments: [],
        replyToMsgId: input.sourceMsgId ?? null,
        workNodeId: null,
        visibilityScope: 'public',
        visibleTo: [],
        meta: { handoffRoomId: created.id }
      })
      return msg
    })
    this.events.messageCreated(notice)
    this.events.roomUpdated(this.getRoom(input.sourceRoomId))

    await this.sendMessage(created.id, {
      content: `[来自「${source.title}」的转交任务]\n\n${seedContent}`,
      idempotencyKey: `handoff-init-${created.id}`
    })
    return this.getRoom(created.id)
  }

  async updateRoom(
    roomId: string,
    patch: {
      title?: string
      strategyConfig?: Record<string, unknown>
      sharedMemories?: SharedMemory[]
    }
  ): Promise<RoomDetail> {
    if (this.reconciling) throw Errors.reconciling()
    return await this.serially(roomId, () => {
      const room = this.getRoom(roomId)
      const now = Date.now()
      const nextTitle = patch.title?.trim() || room.title
      const nextMemories = patch.sharedMemories ?? room.sharedMemories
      let nextConfig = room.strategyConfig
      if (patch.strategyConfig) {
        const strategy = this.strategies.get(room.strategyId)
        nextConfig = strategy ? strategy.configSchema.parse(patch.strategyConfig) : patch.strategyConfig
      }
      this.database.db
        .prepare('UPDATE rooms SET title = ?, strategy_config_json = ?, shared_memories_json = ?, updated_at = ? WHERE id = ?')
        .run(nextTitle, JSON.stringify(nextConfig), JSON.stringify(nextMemories), now, roomId)
      const updated = this.getRoom(roomId)
      this.events.roomUpdated(updated)
      return updated
    })
  }

  async controlRoom(roomId: string, action: RoomControlAction): Promise<RoomDetail> {
    if (this.reconciling) throw Errors.reconciling()
    this.getRoom(roomId)
    return await this.serially(roomId, () => {
      const emittedMessages: RoomMessage[] = []
      const emittedNodes: WorkNode[] = []
      const emittedReveals: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }> = []

      this.database.transaction(() => {
        const room = this.getRoom(roomId)
        const strategy = this.strategies.get(room.strategyId)
        const snapshot = this.buildSnapshotTx(roomId)
        const actions = strategy?.onControl
          ? strategy.onControl(snapshot, action)
          : action === 'pause'
            ? ([{ type: 'set_room_state', state: 'paused' }] satisfies EngineAction[])
            : action === 'resume'
              ? ([{ type: 'set_room_state', state: 'running' }] satisfies EngineAction[])
              : []
        const res = this.applyActionsTx(roomId, strategy ?? singleStrategy, actions, null, true)
        emittedMessages.push(...res.messages)
        emittedNodes.push(...res.nodes)
        emittedReveals.push(...res.revealed)
      })

      for (const m of emittedMessages) this.events.messageCreated(m)
      for (const r of emittedReveals) this.events.messagesRevealed?.(r)
      for (const n of emittedNodes) this.events.workNodeUpdated(n)
      const updated = this.getRoom(roomId)
      this.events.roomUpdated(updated)
      this.scheduleTick()
      return updated
    })
  }

  async controlWorkNode(
    nodeId: string,
    action: WorkNodeControlAction,
    note?: string,
    targetMemberId?: string
  ): Promise<WorkNode> {
    if (this.reconciling) throw Errors.reconciling()
    const existingRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(nodeId) as unknown as WorkNodeRow | undefined
    if (!existingRow) throw Errors.notFound(`WorkNode not found: ${nodeId}`)

    return await this.serially(existingRow.room_id, () => {
      const row = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(nodeId) as unknown as WorkNodeRow | undefined
      if (!row) throw Errors.notFound(`WorkNode not found: ${nodeId}`)
      const now = Date.now()
      const touchedNodes: WorkNode[] = []
      const emittedMessages: RoomMessage[] = []
      const emittedReveals: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }> = []

      if (action === 'stop') {
        if (SETTLED_NODE_STATUSES.has(row.status)) return mapNode(row)
        const flight = this.inFlight.get(nodeId)
        if (flight) {
          flight.abort.abort()
          this.releaseExecutionLease(nodeId, flight.agentId)
        }
        this.database.transaction(() => {
          this.database.db
            .prepare("UPDATE work_nodes SET status = 'paused', lease_token = NULL, blocking_reason = NULL, ended_at = NULL, updated_at = ? WHERE id = ?")
            .run(now, nodeId)
          this.database.db
            .prepare("UPDATE rooms SET state = 'active', updated_at = ? WHERE id = ? AND state = 'running'")
            .run(now, row.room_id)
        })
      } else if (action === 'cancel') {
        if (SETTLED_NODE_STATUSES.has(row.status)) return mapNode(row)
        this.database.transaction(() => {
          const cancelledIds = this.cancelNodeTreeTx(nodeId, 'cancelled_by_user', now)
          for (const cid of cancelledIds) {
            const cRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(cid) as unknown as WorkNodeRow | undefined
            if (cRow) touchedNodes.push(mapNode(cRow))
          }
          if (row.superstep !== null) {
            const bRes = this.checkSuperstepBarrierTx(row.room_id, row.superstep)
            emittedMessages.push(...bRes.messages)
            touchedNodes.push(...bRes.nodes)
            emittedReveals.push(...bRes.revealed)
          } else {
            this.database.db
              .prepare("UPDATE rooms SET state = 'active', updated_at = ? WHERE id = ? AND state = 'running'")
              .run(now, row.room_id)
          }
        })
      } else if (action === 'retry' || action === 'continue') {
        if (!['failed', 'paused', 'cancelled'].includes(row.status)) {
          throw Errors.conflict('invalid_state', `Cannot ${action} work node in status ${row.status}`)
        }
        const nextInstruction = note?.trim() ? `${row.instruction}\n\n[User follow-up]: ${note.trim()}` : row.instruction
        this.database.transaction(() => {
          this.database.db
            .prepare(
              `UPDATE work_nodes
               SET status = 'queued', attempt = attempt + 1, instruction = ?, error_text = NULL, blocking_reason = NULL, lease_token = NULL, ended_at = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(nextInstruction, now, nodeId)
          this.database.db.prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ?").run(now, row.room_id)
        })
      } else if (action === 'reassign') {
        if (!targetMemberId?.trim()) {
          throw Errors.invalidParams('targetMemberId is required for reassign')
        }
        const room = this.getRoom(row.room_id)
        const targetMember = room.members.find((m) => m.id === targetMemberId && m.removedAt === null)
        if (!targetMember) {
          throw Errors.notFound(`Target member not active in room: ${targetMemberId}`)
        }
        if (targetMember.id === row.assignee_member_id) {
          throw Errors.invalidParams('Target member is already assigned to this node')
        }

        const replacementId = randomUUID()
        this.database.transaction(() => {
          // 1. Cancel old node tree if unsettled (never mutate assignee in-place so session continuity stays clean)
          if (!SETTLED_NODE_STATUSES.has(row.status)) {
            const cancelledIds = this.cancelNodeTreeTx(nodeId, `reassigned_to:${targetMember.displayName}`, now)
            for (const cid of cancelledIds) {
              const cRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(cid) as unknown as WorkNodeRow | undefined
              if (cRow) touchedNodes.push(mapNode(cRow))
            }
          }

          // 2. Spawn replacement node with supersedes_node_id = oldNode.id
          const nextInstruction = note?.trim()
            ? `${row.instruction}\n\n[Reassigned note]: ${note.trim()}`
            : row.instruction
          const replacementRootId = row.parent_node_id ? row.root_node_id : replacementId
          this.database.db
            .prepare(
              `INSERT INTO work_nodes (
                 id, room_id, root_node_id, parent_node_id, supersedes_node_id, request_msg_id,
                 assignee_member_id, assignee_agent_id, kind, status, superstep, instruction, expected_result,
                 workspace_mode, workspace_id, resources_json, visibility_on_publish, depth, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              replacementId,
              row.room_id,
              replacementRootId,
              row.parent_node_id,
              row.id,
              row.request_msg_id,
              targetMember.id,
              targetMember.agentId,
              row.kind,
              row.superstep,
              nextInstruction,
              row.expected_result,
              row.workspace_mode,
              row.workspace_id,
              row.resources_json,
              row.visibility_on_publish,
              row.depth,
              now,
              now
            )
          this.database.db
            .prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ? AND state != 'paused'")
            .run(now, row.room_id)
          const spawned = mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(replacementId) as unknown as WorkNodeRow)
          touchedNodes.push(spawned)
          emittedMessages.push(
            this.insertMessageTx(row.room_id, {
              authorKind: 'system',
              authorId: 'system',
              authorName: 'System',
              kind: 'routing_notice',
              content: `任务节点已改派给 @${targetMember.displayName}（替代原节点 ${row.id.slice(0, 8)}）。`,
              attachments: [],
              replyToMsgId: row.request_msg_id,
              workNodeId: replacementId,
              visibilityScope: 'public',
              visibleTo: [],
              meta: {}
            })
          )
        })
      }

      const updated = mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(nodeId) as unknown as WorkNodeRow)
      for (const m of emittedMessages) this.events.messageCreated(m)
      for (const r of emittedReveals) this.events.messagesRevealed?.(r)
      this.events.workNodeUpdated(updated)
      for (const t of touchedNodes) {
        if (t.id !== updated.id) this.events.workNodeUpdated(t)
      }
      this.events.roomUpdated(this.getRoom(row.room_id))
      this.scheduleTick()
      return action === 'reassign' && touchedNodes.length > 0 ? touchedNodes[touchedNodes.length - 1]! : updated
    })
  }

  private cancelNodeTreeTx(rootNodeId: string, reason: string, now: number): string[] {
    const queue: string[] = [rootNodeId]
    const visited = new Set<string>()
    const cancelled: string[] = []

    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)

      const row = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(id) as unknown as WorkNodeRow | undefined
      if (!row) continue

      const children = this.database.db
        .prepare('SELECT id FROM work_nodes WHERE parent_node_id = ?')
        .all(id) as Array<{ id: string }>
      for (const ch of children) queue.push(ch.id)

      if (SETTLED_NODE_STATUSES.has(row.status)) continue

      const flight = this.inFlight.get(id)
      if (flight) {
        flight.abort.abort()
        this.releaseExecutionLease(id, flight.agentId)
      }
      this.database.db
        .prepare(
          "UPDATE work_nodes SET status = 'cancelled', lease_token = NULL, blocking_reason = NULL, error_text = COALESCE(error_text, ?), ended_at = ?, updated_at = ? WHERE id = ?"
        )
        .run(reason, now, now, id)
      cancelled.push(id)
    }
    return cancelled
  }

  private insertMessageTx(
    roomId: string,
    opts: {
      authorKind: RoomMessage['authorKind']
      authorId: string
      authorName: string
      kind: RoomMessage['kind']
      content: string
      attachments: FileRef[]
      replyToMsgId: string | null
      workNodeId: string | null
      visibilityScope: RoomMessage['visibilityScope']
      visibleTo: string[]
      meta: Record<string, unknown>
      idempotencyKey?: string
    }
  ): RoomMessage {
    const now = Date.now()
    const seqRow = this.database.db
      .prepare('UPDATE rooms SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq')
      .get(now, roomId) as { last_seq: number }
    const seq = seqRow.last_seq
    const visibleSeq = opts.visibilityScope === 'public' ? seq : 0
    const id = randomUUID()
    this.database.db
      .prepare(
        `INSERT INTO room_messages (
           id, room_id, seq, visible_seq, author_kind, author_id, author_name, kind, content,
           attachments_json, reply_to_msg_id, work_node_id, visibility_scope, visible_to_json, meta_json, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        roomId,
        seq,
        visibleSeq,
        opts.authorKind,
        opts.authorId,
        opts.authorName,
        opts.kind,
        opts.content,
        JSON.stringify(opts.attachments),
        opts.replyToMsgId,
        opts.workNodeId,
        opts.visibilityScope,
        JSON.stringify(opts.visibleTo),
        JSON.stringify(opts.meta),
        opts.idempotencyKey ?? null,
        now
      )
    return mapMessage(this.database.db.prepare('SELECT * FROM room_messages WHERE id = ?').get(id) as unknown as MessageRow)
  }

  private buildSnapshotTx(roomId: string): RoomSnapshot {
    const room = this.getRoom(roomId)
    const msgRows = this.database.db
      .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 40')
      .all(roomId) as unknown as MessageRow[]
    const activeRows = this.database.db
      .prepare("SELECT * FROM work_nodes WHERE room_id = ? AND status NOT IN ('completed','failed','cancelled')")
      .all(roomId) as unknown as WorkNodeRow[]
    return {
      room,
      config: room.strategyConfig,
      state: room.strategyState,
      members: room.members,
      recentMessages: msgRows.reverse().map(mapMessage),
      activeNodes: activeRows.map(mapNode)
    }
  }

  private wouldCreateCycleTx(nodeId: string, dependsOnId: string): boolean {
    if (nodeId === dependsOnId) return true
    const visited = new Set<string>()
    const stack = [dependsOnId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === nodeId) return true
      if (visited.has(cur)) continue
      visited.add(cur)
      const deps = this.database.db
        .prepare('SELECT depends_on_id FROM work_node_deps WHERE node_id = ?')
        .all(cur) as Array<{ depends_on_id: string }>
      for (const d of deps) stack.push(d.depends_on_id)
    }
    return false
  }

  private deliverWorkDeliveryTx(deliveryId: string, now: number): WorkNode | null {
    const row = this.database.db
      .prepare('SELECT * FROM work_deliveries WHERE id = ?')
      .get(deliveryId) as unknown as DeliveryRow | undefined
    if (!row || row.status !== 'pending') return null

    this.database.db
      .prepare("UPDATE work_deliveries SET status = 'sent', sent_at = ? WHERE id = ?")
      .run(now, row.id)

    const target = this.database.db
      .prepare('SELECT * FROM work_nodes WHERE id = ?')
      .get(row.target_node_id) as unknown as WorkNodeRow | undefined
    if (!target) return null

    if (target.status === 'waiting_children') {
      this.database.db
        .prepare(
          `UPDATE work_nodes
           SET status = 'queued', attempt = attempt + 1, blocking_reason = NULL, delivered_at = ?, lease_token = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, target.id)
      this.database.db
        .prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ? AND state != 'paused'")
        .run(now, target.room_id)
      return mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(target.id) as unknown as WorkNodeRow)
    }
    return null
  }

  private applyActionsTx(
    roomId: string,
    strategy: CollabStrategy<any, any>,
    actions: EngineAction[],
    requestMsgId: string | null,
    allowUnpause = false,
    spawnOpts?: { sourceTrustLevel?: 'trusted' | 'untrusted'; forceReadOnly?: boolean }
  ): {
    messages: RoomMessage[]
    nodes: WorkNode[]
    revealed: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }>
  } {
    const messages: RoomMessage[] = []
    const nodes: WorkNode[] = []
    const revealed: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }> = []
    const now = Date.now()
    const room = this.getRoom(roomId)

    for (const action of actions) {
      if (action.type === 'spawn_node') {
        const member = room.members.find((m) => m.id === action.assigneeMemberId)
        if (!member) continue
        const nodeId = randomUUID()
        const parentRow = action.parentNodeId
          ? (this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(action.parentNodeId) as unknown as WorkNodeRow | undefined)
          : undefined
        const rootId = parentRow?.root_node_id ?? nodeId
        const depth = parentRow ? parentRow.depth + 1 : 0
        const rawMode = action.workspaceMode ?? strategy.defaultWorkspaceMode
        const workspaceMode: WorkspaceMode = spawnOpts?.forceReadOnly ? 'read-only' : rawMode
        const sourceTrustLevel = spawnOpts?.forceReadOnly ? 'untrusted' : (spawnOpts?.sourceTrustLevel ?? 'trusted')

        let workspaceId = room.primaryWorkspaceId
        if (action.inheritWorkspaceFromNodeId) {
          const srcNode = this.database.db
            .prepare('SELECT workspace_id FROM work_nodes WHERE id = ? AND room_id = ?')
            .get(action.inheritWorkspaceFromNodeId, roomId) as { workspace_id: string | null } | undefined
          if (srcNode?.workspace_id) workspaceId = srcNode.workspace_id
        }

        const depIds = [...new Set(action.dependsOn ?? [])]
        let hasPendingDeps = false
        for (const depId of depIds) {
          const depRow = this.database.db
            .prepare('SELECT id, status FROM work_nodes WHERE id = ? AND room_id = ?')
            .get(depId, roomId) as { id: string; status: string } | undefined
          if (!depRow) throw Errors.notFound(`Dependency workNode not found in room: ${depId}`)
          if (this.wouldCreateCycleTx(nodeId, depId)) {
            throw Errors.conflict('dependency_cycle', `Cyclic dependency detected involving ${depId}`)
          }
          if (depRow.status !== 'completed') hasPendingDeps = true
        }

        const initialStatus: WorkNode['status'] = hasPendingDeps ? 'waiting_deps' : 'queued'
        const blockingReason = hasPendingDeps ? 'waiting_deps' : null

        this.database.db
          .prepare(
            `INSERT INTO work_nodes (
               id, room_id, root_node_id, parent_node_id, request_msg_id, assignee_member_id, assignee_agent_id,
               kind, status, blocking_reason, superstep, instruction, expected_result, workspace_mode, workspace_id,
               resources_json, visibility_on_publish, source_trust_level, depth, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            nodeId,
            roomId,
            rootId,
            action.parentNodeId ?? null,
            requestMsgId,
            member.id,
            member.agentId,
            action.kind,
            initialStatus,
            blockingReason,
            action.superstep ?? null,
            action.instruction,
            action.expectedResult ?? null,
            workspaceMode,
            workspaceId,
            JSON.stringify(action.resources ?? []),
            JSON.stringify(action.visibilityOnPublish ?? { scope: 'public' }),
            sourceTrustLevel,
            depth,
            now,
            now
          )
        for (const depId of depIds) {
          this.database.db
            .prepare('INSERT OR IGNORE INTO work_node_deps (node_id, depends_on_id) VALUES (?, ?)')
            .run(nodeId, depId)
        }
        nodes.push(mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(nodeId) as unknown as WorkNodeRow))
      } else if (action.type === 'cancel_nodes') {
        for (const nid of action.nodeIds) {
          const cancelledIds = this.cancelNodeTreeTx(nid, action.reason, now)
          for (const cid of cancelledIds) {
            const cRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(cid) as unknown as WorkNodeRow | undefined
            if (cRow) nodes.push(mapNode(cRow))
          }
        }
      } else if (action.type === 'post_system') {
        const m = this.insertMessageTx(roomId, {
          authorKind: 'system',
          authorId: 'system',
          authorName: 'System',
          kind: action.kind ?? 'system_notice',
          content: action.text,
          attachments: [],
          replyToMsgId: null,
          workNodeId: null,
          visibilityScope: 'public',
          visibleTo: [],
          meta: {}
        })
        messages.push(m)
      } else if (action.type === 'update_strategy_state') {
        const curRow = this.database.db.prepare('SELECT strategy_state_json FROM rooms WHERE id = ?').get(roomId) as { strategy_state_json: string }
        const prev = JSON.parse(curRow.strategy_state_json || '{}') as Record<string, unknown>
        const next = strategy.reduceState(prev, action.delta)
        this.database.db
          .prepare('UPDATE rooms SET strategy_state_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(next), now, roomId)
      } else if (action.type === 'set_room_state') {
        if (allowUnpause) {
          this.database.db.prepare('UPDATE rooms SET state = ?, updated_at = ? WHERE id = ?').run(action.state, now, roomId)
        } else {
          this.database.db
            .prepare("UPDATE rooms SET state = ?, updated_at = ? WHERE id = ? AND state != 'paused'")
            .run(action.state, now, roomId)
        }
      } else if (action.type === 'reveal_messages' && action.messageIds.length > 0) {
        const seqRow = this.database.db
          .prepare('UPDATE rooms SET last_seq = last_seq + 1, updated_at = ? WHERE id = ? RETURNING last_seq')
          .get(now, roomId) as { last_seq: number }
        for (const msgId of action.messageIds) {
          this.database.db
            .prepare("UPDATE room_messages SET visibility_scope = 'public', visible_seq = ? WHERE id = ? AND room_id = ?")
            .run(seqRow.last_seq, msgId, roomId)
        }
        revealed.push({ roomId, messageIds: [...action.messageIds], visibleSeq: seqRow.last_seq })
      }
    }
    return { messages, nodes, revealed }
  }

  private checkSuperstepBarrierTx(
    roomId: string,
    superstep: number | null
  ): {
    messages: RoomMessage[]
    nodes: WorkNode[]
    revealed: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }>
  } {
    if (superstep === null) return { messages: [], nodes: [], revealed: [] }
    const room = this.getRoom(roomId)
    const strategy = this.strategies.get(room.strategyId)
    if (!strategy || strategy.executionModel !== 'superstep' || !strategy.onSuperstepBarrier) {
      return { messages: [], nodes: [], revealed: [] }
    }
    const stepRows = this.database.db
      .prepare('SELECT * FROM work_nodes WHERE room_id = ? AND superstep = ? ORDER BY created_at ASC')
      .all(roomId, superstep) as unknown as WorkNodeRow[]
    if (stepRows.length === 0) return { messages: [], nodes: [], revealed: [] }
    if (!stepRows.every((r) => SETTLED_NODE_STATUSES.has(r.status))) {
      return { messages: [], nodes: [], revealed: [] }
    }
    const snapshot = this.buildSnapshotTx(roomId)
    const actions = strategy.onSuperstepBarrier(snapshot, superstep, stepRows.map(mapNode))
    if (actions.length === 0) return { messages: [], nodes: [], revealed: [] }
    return this.applyActionsTx(roomId, strategy, actions, stepRows[0]?.request_msg_id ?? null)
  }

  private scheduleTick(): void {
    if (this.tickScheduled || this.reconciling) return
    this.tickScheduled = true
    setImmediate(() => {
      this.tickScheduled = false
      this.runSchedulerTick()
    })
  }

  private runSchedulerTick(): void {
    if (this.reconciling) return

    const candidates = this.database.db
      .prepare(
        `SELECT w.*
         FROM work_nodes w
         JOIN rooms r ON r.id = w.room_id
         WHERE w.status IN ('queued', 'waiting_lock')
           AND r.deleted_at IS NULL
           AND r.state != 'paused'
         ORDER BY w.created_at ASC
         LIMIT 50`
      )
      .all() as unknown as WorkNodeRow[]

    const waitingWriters: ResourceClaim[][] = []
    const toLaunch: Array<{ node: WorkNodeRow; leaseToken: string; abort: AbortController }> = []

    for (const row of candidates) {
      const agent = this.agents.get(row.assignee_agent_id)
      const runningForAgent = this.agentRunningCounts.get(agent.id) ?? 0
      const ws = row.workspace_id ? this.workspaces.get(row.workspace_id) : null
      const claims = buildNodeClaims({
        memberId: row.assignee_member_id,
        workspacePath: ws?.rootPath ?? null,
        workspaceMode: row.workspace_mode,
        isWorktreeDir: Boolean(ws && ws.kind === 'git_worktree'),
        extraResources: JSON.parse(row.resources_json || '[]') as string[]
      })

      const hasCapacity = runningForAgent < agent.maxRunningTurns
      const canLock = this.locks.canAcquire(claims, waitingWriters)

      if (!hasCapacity || !canLock) {
        const reason = !hasCapacity ? 'agent_concurrency_limit' : 'resource_or_member_lock'
        if (row.status === 'queued' || row.blocking_reason !== reason) {
          this.database.db
            .prepare("UPDATE work_nodes SET status = 'waiting_lock', blocking_reason = ?, updated_at = ? WHERE id = ?")
            .run(reason, Date.now(), row.id)
          const updatedWaiting = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow | undefined
          if (updatedWaiting) this.events.workNodeUpdated(mapNode(updatedWaiting))
        }
        if (claims.some((c) => c.mode === 'write' && c.path)) {
          waitingWriters.push(claims)
        }
        continue
      }

      // Synchronous atomic CAS claim -> status = 'starting' + leaseToken
      const leaseToken = randomUUID()
      const now = Date.now()
      const res = this.database.db
        .prepare("UPDATE work_nodes SET status = 'starting', blocking_reason = NULL, lease_token = ?, started_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'waiting_lock')")
        .run(leaseToken, now, now, row.id)
      if (res.changes !== 1) continue

      const abort = new AbortController()
      this.locks.acquire(row.id, claims)
      this.agentRunningCounts.set(agent.id, runningForAgent + 1)
      this.inFlight.set(row.id, { leaseToken, abort, agentId: agent.id })
      toLaunch.push({ node: { ...row, status: 'starting', blocking_reason: null, lease_token: leaseToken }, leaseToken, abort })
    }

    // Launch all claimed nodes asynchronously outside any lock
    for (const item of toLaunch) {
      this.events.workNodeUpdated(mapNode(item.node))
      void this.executeNodeAsync(item.node, item.leaseToken, item.abort)
    }
  }

  private releaseExecutionLease(nodeId: string, agentId: string): void {
    if (this.inFlight.delete(nodeId)) {
      this.locks.release(nodeId)
      const prev = this.agentRunningCounts.get(agentId) ?? 1
      this.agentRunningCounts.set(agentId, Math.max(0, prev - 1))
    }
  }

  private checkLeaseValid(nodeId: string, leaseToken: string, allowedStatuses: string[]): boolean {
    const row = this.database.db
      .prepare('SELECT status, lease_token FROM work_nodes WHERE id = ?')
      .get(nodeId) as { status: string; lease_token: string | null } | undefined
    return Boolean(row && row.lease_token === leaseToken && allowedStatuses.includes(row.status))
  }

  private getVisibleMessagesForMember(roomId: string, memberId: string, limit = 80): RoomMessage[] {
    const rows = this.database.db
      .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?')
      .all(roomId, limit) as unknown as MessageRow[]
    return rows
      .reverse()
      .map(mapMessage)
      .filter((m) => m.visibilityScope === 'public' || m.visibleTo.includes(memberId))
  }

  private async executeNodeAsync(row: WorkNodeRow, leaseToken: string, abort: AbortController): Promise<void> {
    const agent = this.agents.get(row.assignee_agent_id)
    const driver = this.drivers.get(agent.driverKind)
    if (!driver) {
      await this.settleNode(row, leaseToken, 'failed', { errorText: `Driver not registered: ${agent.driverKind}` })
      return
    }

    const room = this.getRoom(row.room_id)
    const strategy = this.strategies.get(room.strategyId)
    const member = room.members.find((m) => m.id === row.assignee_member_id) ?? room.members[0]!
    let workspace = this.workspaces.get(row.workspace_id || agent.defaultWorkspaceId)

    try {
      // Provision isolated Git worktree for starting node if requested on a project repo
      if (row.workspace_mode === 'worktree' && workspace.kind === 'project' && workspace.isGit) {
        const wt = await this.workspaces.createWorktree({
          projectWorkspaceId: workspace.id,
          branchSlug: agent.name,
          ownerType: 'work_node',
          ownerId: row.id
        })
        if (!this.checkLeaseValid(row.id, leaseToken, ['starting'])) {
          await this.workspaces.cleanWorktree(wt.id, true).catch(() => {})
          this.releaseExecutionLease(row.id, agent.id)
          this.scheduleTick()
          return
        }
        workspace = wt
        this.database.db
          .prepare('UPDATE work_nodes SET workspace_id = ?, updated_at = ? WHERE id = ?')
          .run(wt.id, Date.now(), row.id)
        row.workspace_id = wt.id
        // Update in-memory lock to protect the newly created worktree directory
        this.locks.acquire(
          row.id,
          buildNodeClaims({
            memberId: row.assignee_member_id,
            workspacePath: wt.rootPath,
            workspaceMode: 'worktree',
            isWorktreeDir: true,
            extraResources: JSON.parse(row.resources_json || '[]') as string[]
          })
        )
        const updatedRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow | undefined
        if (updatedRow) this.events.workNodeUpdated(mapNode(updatedRow))
      }

      const allowedCollabTools = strategy?.allowedTools ?? []
      const isLockdown = agent.isolationMode === 'lockdown' || row.source_trust_level === 'untrusted'
      const mcpAllowedTools = isLockdown
        ? allowedCollabTools.filter((t) => t === 'collab_history' || t === 'collab_publish')
        : allowedCollabTools
      const skillsData = this.skillRegistry?.loadPromptSection(agent.skillIds) ?? { promptBlock: '', skillsHash: '' }
      const externalMcpServers =
        !isLockdown && this.mcpRegistry ? await this.mcpRegistry.resolveForAgent(agent.mcpServerIds) : []

      let mcpConfigPath: string | undefined
      let mcpConfigHash: string | undefined
      if ((mcpAllowedTools.length > 0 || externalMcpServers.length > 0) && agent.driverKind !== 'builtin') {
        const mcpInfo = writeRoomMemberMcpConfig({
          roomId: row.room_id,
          memberId: row.assignee_member_id,
          allowedTools: mcpAllowedTools,
          externalServers: externalMcpServers
        })
        mcpConfigPath = mcpInfo.configPath
        mcpConfigHash = mcpInfo.configHash
      }

      const { profile, configHash } = await this.isolator.buildLaunchPlan({
        agent,
        workspace,
        workspaceMode: row.workspace_mode,
        strategyPolicy: strategy?.defaultWorkspaceMode ?? 'shared-rw',
        sourceTrustLevel: row.source_trust_level === 'untrusted' ? 'untrusted' : 'trusted',
        isMultiAgentRoom: room.strategyId !== 'single',
        readableFiles: [],
        readonlyRefPaths: workspace.readonlyRefs,
        mcpConfigPath,
        mcpConfigHash,
        skillsHash: skillsData.skillsHash || undefined,
        externalMcpNames: externalMcpServers.map((s) => s.name)
      })

      if (!this.checkLeaseValid(row.id, leaseToken, ['starting'])) {
        this.releaseExecutionLease(row.id, agent.id)
        this.scheduleTick()
        return
      }

      // Transition starting -> running
      const now = Date.now()
      this.database.db
        .prepare("UPDATE work_nodes SET status = 'running', blocking_reason = NULL, driver_snapshot_json = ?, updated_at = ? WHERE id = ? AND lease_token = ?")
        .run(JSON.stringify({ driverKind: agent.driverKind, model: agent.driverConfig.model ?? null }), now, row.id, leaseToken)
      this.events.workNodeUpdated(mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow))

      const sessionRow = this.database.db
        .prepare('SELECT * FROM agent_sessions WHERE room_member_id = ?')
        .get(row.assignee_member_id) as unknown as SessionRow
      const session: SessionRecord = {
        id: sessionRow.id,
        roomId: sessionRow.room_id,
        roomMemberId: sessionRow.room_member_id,
        agentId: sessionRow.agent_id,
        driverKind: sessionRow.driver_kind,
        daemonSessionId: sessionRow.daemon_session_id,
        nativeSessionId: sessionRow.native_session_id,
        configHash: sessionRow.config_hash,
        lastDeliveredSeq: sessionRow.last_delivered_seq,
        lastConsumedOffset: sessionRow.last_consumed_offset
      }

      this.database.db.prepare("UPDATE agent_sessions SET status = 'busy', last_active_at = ?, updated_at = ? WHERE id = ?").run(now, now, session.id)

      const visibleMessages = this.getVisibleMessagesForMember(row.room_id, row.assignee_member_id, 60)
      const deliveryRows = this.database.db
        .prepare("SELECT * FROM work_deliveries WHERE target_node_id = ? AND status = 'sent' ORDER BY created_at ASC")
        .all(row.id) as unknown as DeliveryRow[]
      const pendingDeliveryText = deliveryRows.map((d) => d.payload_text).join('\n\n---\n\n')
      const isIncremental =
        driver.capabilities.supportsNativeResume &&
        Boolean(session.nativeSessionId && session.configHash === configHash && session.lastDeliveredSeq > 0) &&
        (agent.driverKind !== 'claude' || Boolean(session.daemonSessionId))

      const latestNodeObj = mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow)
      const turnContext = buildTurnContext({
        room,
        member,
        node: latestNodeObj,
        visibleMessages,
        pendingDeliveryText: pendingDeliveryText || null,
        isIncremental,
        lastDeliveredSeq: session.lastDeliveredSeq,
        allowedCollabTools
      })
      const attachmentsPrompt = this.buildAttachmentsPromptBlock(visibleMessages, latestNodeObj.requestMsgId)
      if (attachmentsPrompt) {
        turnContext.instructionPrompt = `${turnContext.instructionPrompt}\n\n${attachmentsPrompt}`
      }

      let nodeEventSeq = 0
      let thinkingBuf = ''
      const persistNodeEvent = (kind: NodeEvent['kind'], payload: Record<string, unknown>) => {
        nodeEventSeq += 1
        try {
          this.database.db
            .prepare(
              'INSERT INTO node_events (id, node_id, attempt, seq, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(randomUUID(), row.id, row.attempt, nodeEventSeq, kind, JSON.stringify(payload), Date.now())
        } catch {
          // ignore if room deleted mid-turn
        }
      }
      const flushThinking = () => {
        const text = thinkingBuf.trim()
        thinkingBuf = ''
        if (text) {
          persistNodeEvent('thinking', { text: text.slice(0, 64_000) })
        }
      }

      const emit = (ev: TurnStreamEvent) => {
        if (!this.checkLeaseValid(row.id, leaseToken, ['running'])) return
        this.eventSeqCounter += 1
        this.events.streamDelta({
          roomId: row.room_id,
          workNodeId: row.id,
          attempt: row.attempt,
          eventSeq: this.eventSeqCounter,
          memberId: row.assignee_member_id,
          kind: ev.kind,
          delta: ev.delta,
          toolCall: ev.toolCall,
          usage: ev.usage
        })
        if (ev.kind === 'thinking' && ev.delta) {
          thinkingBuf += ev.delta
          return
        }
        // Persist non-token step events (thinking segments + tool_start / tool_result / error / notice)
        if (ev.kind === 'tool_start' || ev.kind === 'tool_result' || ev.kind === 'error' || ev.kind === 'notice') {
          flushThinking()
          persistNodeEvent(ev.kind, (ev.toolCall ?? { delta: ev.delta }) as Record<string, unknown>)
        }
      }

      let output
      try {
        output = await driver.runTurn({
          session,
          agent,
          roomId: row.room_id,
          workNodeId: row.id,
          attempt: row.attempt,
          workspace,
          workspaceMode: row.workspace_mode,
          isolation: profile,
          configHash,
          instruction: turnContext.instructionPrompt,
          systemContextPrompt: turnContext.systemContextPrompt,
          skillsPrompt: skillsData.promptBlock || undefined,
          mcpConfigPath,
          externalMcpServers,
          allowedCollabTools,
          callCollabTool: (toolName, args, toolCallId) =>
            this.handleCollabToolCall({
              roomId: row.room_id,
              memberId: row.assignee_member_id,
              workNodeId: row.id,
              toolName,
              args,
              toolCallId
            }),
          historyMessages: turnContext.contextHistoryMessages,
          abortSignal: abort.signal,
          emit,
          onSessionUpdate: (patch) => {
            const ts = Date.now()
            const prevNativeId = session.nativeSessionId
            if (patch.daemonSessionId !== undefined) session.daemonSessionId = patch.daemonSessionId
            if (patch.nativeSessionId !== undefined) session.nativeSessionId = patch.nativeSessionId
            if (patch.configHash !== undefined) session.configHash = patch.configHash
            if (patch.lastConsumedOffset !== undefined) session.lastConsumedOffset = patch.lastConsumedOffset
            this.database.db
              .prepare(
                `UPDATE agent_sessions
                 SET daemon_session_id = ?, native_session_id = ?, config_hash = ?, last_consumed_offset = ?, last_active_at = ?, updated_at = ?
                 WHERE id = ?`
              )
              .run(
                session.daemonSessionId,
                session.nativeSessionId,
                session.configHash,
                session.lastConsumedOffset,
                ts,
                ts,
                session.id
              )
            if (patch.nativeSessionId && patch.nativeSessionId !== prevNativeId) {
              try {
                this.events.roomUpdated(this.getRoom(row.room_id))
              } catch {
                // ignore if room deleted
              }
            }
          }
        })
      } finally {
        flushThinking()
      }

      // Always mark session ready if alive and not crashed
      this.database.db
        .prepare("UPDATE agent_sessions SET status = 'ready', last_active_at = ?, updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), session.id)

      // Check post-turn state under room lock: handle transfer, waiting_children, or normal settlement
      if (!this.checkLeaseValid(row.id, leaseToken, ['running'])) {
        this.releaseExecutionLease(row.id, agent.id)
        this.scheduleTick()
        return
      }

      const postDecision = await this.serially(row.room_id, () => {
        if (!this.checkLeaseValid(row.id, leaseToken, ['running'])) {
          this.releaseExecutionLease(row.id, agent.id)
          return 'skip' as const
        }

        const freshRow = this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow
        if (freshRow.transferred_to_node_id) {
          this.releaseExecutionLease(row.id, agent.id)
          return 'skip' as const
        }

        const childRows = this.database.db
          .prepare('SELECT * FROM work_nodes WHERE parent_node_id = ? ORDER BY created_at ASC')
          .all(row.id) as unknown as WorkNodeRow[]
        const existingDeliveries = this.database.db
          .prepare('SELECT child_node_ids_json FROM work_deliveries WHERE target_node_id = ?')
          .all(row.id) as Array<{ child_node_ids_json: string }>
        const deliveredChildIds = new Set<string>()
        for (const d of existingDeliveries) {
          for (const cid of JSON.parse(d.child_node_ids_json || '[]') as string[]) {
            deliveredChildIds.add(cid)
          }
        }
        const undeliveredChildren = childRows.filter((c) => !deliveredChildIds.has(c.id))

        if (undeliveredChildren.length > 0) {
          this.releaseExecutionLease(row.id, agent.id)
          const hasUnsettled = undeliveredChildren.some((c) => !SETTLED_NODE_STATUSES.has(c.status))
          const nowTs = Date.now()
          if (hasUnsettled) {
            this.database.db
              .prepare(
                `UPDATE work_nodes
                 SET status = 'waiting_children', blocking_reason = 'waiting_children', lease_token = NULL,
                     result_text = ?, usage_json = ?, updated_at = ?
                 WHERE id = ?`
              )
              .run(output.finalText ?? null, output.usage ? JSON.stringify(output.usage) : null, nowTs, row.id)
            const latestRoom = this.database.db.prepare('SELECT last_seq FROM rooms WHERE id = ?').get(row.room_id) as { last_seq: number }
            this.database.db
              .prepare('UPDATE agent_sessions SET last_delivered_seq = ?, updated_at = ? WHERE room_member_id = ?')
              .run(latestRoom.last_seq, nowTs, row.assignee_member_id)
            const waitingNode = mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow)
            this.events.workNodeUpdated(waitingNode)
            this.events.roomUpdated(this.getRoom(row.room_id))
            return 'waiting' as const
          }

          // All undelivered children already settled before parent finished its turn -> create & deliver batch now!
          const woken = this.database.transaction(() => {
            this.database.db
              .prepare("UPDATE work_nodes SET status = 'waiting_children', lease_token = NULL, updated_at = ? WHERE id = ?")
              .run(nowTs, row.id)
            const deliveryId = this.createWorkDeliveryTx(row.room_id, row.id, undeliveredChildren, nowTs)
            return this.deliverWorkDeliveryTx(deliveryId, nowTs)
          })
          if (woken) this.events.workNodeUpdated(woken)
          this.events.roomUpdated(this.getRoom(row.room_id))
          return 'woken' as const
        }

        return 'settle' as const
      })

      if (postDecision !== 'settle') {
        this.scheduleTick()
        return
      }

      await this.settleNode(row, leaseToken, 'completed', {
        resultText: output.finalText,
        usage: output.usage
      })
    } catch (err) {
      if (abort.signal.aborted || !this.checkLeaseValid(row.id, leaseToken, ['starting', 'running'])) {
        this.releaseExecutionLease(row.id, row.assignee_agent_id)
        this.scheduleTick()
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      await this.settleNode(row, leaseToken, 'failed', { errorText: message })
    }
  }

  private createWorkDeliveryTx(
    roomId: string,
    targetNodeId: string,
    children: WorkNodeRow[],
    now: number
  ): string {
    const room = this.getRoom(roomId)
    const memberMap = new Map(room.members.map((m) => [m.id, m]))
    const sections = children.map((c, idx) => {
      const assignee = memberMap.get(c.assignee_member_id)?.displayName ?? c.assignee_member_id
      const outcome = c.status === 'completed' ? (c.result_text || '(completed without text)') : `(${c.status}: ${c.error_text || 'no details'})`
      return [
        `${idx + 1}. childNodeId=${c.id} | kind=${c.kind} | assignee=@${assignee} | status=${c.status}${c.workspace_id ? ` | workspaceId=${c.workspace_id}` : ''}`,
        `Result:\n${outcome.slice(0, 8000)}`
      ].join('\n')
    })
    const payloadText = sections.join('\n\n')
    const id = randomUUID()
    this.database.db
      .prepare(
        `INSERT INTO work_deliveries (id, room_id, target_node_id, child_node_ids_json, payload_text, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, roomId, targetNodeId, JSON.stringify(children.map((c) => c.id)), payloadText, now)
    return id
  }

  private hasPublishedToolMessageTx(nodeId: string, attempt: number): boolean {
    const rows = this.database.db
      .prepare("SELECT meta_json FROM room_messages WHERE work_node_id = ? AND author_kind = 'agent'")
      .all(nodeId) as Array<{ meta_json: string }>
    return rows.some((r) => {
      try {
        const meta = JSON.parse(r.meta_json || '{}') as { publishedByTool?: boolean; attempt?: number }
        return meta.publishedByTool === true && meta.attempt === attempt
      } catch {
        return false
      }
    })
  }

  private async settleNode(
    row: WorkNodeRow,
    leaseToken: string,
    status: 'completed' | 'failed',
    payload: { resultText?: string; errorText?: string; usage?: WorkNode['usage'] }
  ): Promise<void> {
    this.releaseExecutionLease(row.id, row.assignee_agent_id)

    await this.serially(row.room_id, () => {
      if (!this.checkLeaseValid(row.id, leaseToken, ['starting', 'running'])) return

      const emittedMessages: RoomMessage[] = []
      const emittedNodes: WorkNode[] = []
      const emittedReveals: Array<{ roomId: string; messageIds: string[]; visibleSeq: number }> = []
      const now = Date.now()

      const settledNode = this.database.transaction(() => {
        this.database.db
          .prepare(
            `UPDATE work_nodes
             SET status = ?, lease_token = NULL, blocking_reason = NULL, result_text = ?, error_text = ?, usage_json = ?, ended_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            status,
            payload.resultText ?? null,
            payload.errorText ?? null,
            payload.usage ? JSON.stringify(payload.usage) : null,
            now,
            now,
            row.id
          )

        const room = this.getRoom(row.room_id)
        const member = room.members.find((m) => m.id === row.assignee_member_id)
        const alreadyPublished = this.hasPublishedToolMessageTx(row.id, row.attempt)
        const vis = parseVisibilityOnPublish(row.visibility_on_publish)

        if (status === 'completed' && payload.resultText && !alreadyPublished) {
          const msg = this.insertMessageTx(row.room_id, {
            authorKind: 'agent',
            authorId: row.assignee_member_id,
            authorName: member?.displayName || 'Agent',
            kind: row.kind === 'summary' ? 'summary' : 'chat',
            content: payload.resultText,
            attachments: [],
            replyToMsgId: row.request_msg_id,
            workNodeId: row.id,
            visibilityScope: vis.visibilityScope,
            visibleTo: vis.visibleTo,
            meta: { usage: payload.usage, attempt: row.attempt }
          })
          emittedMessages.push(msg)
        } else if (status === 'failed' && payload.errorText) {
          const msg = this.insertMessageTx(row.room_id, {
            authorKind: 'system',
            authorId: 'system',
            authorName: 'System',
            kind: 'system_notice',
            content: `执行失败：${payload.errorText}`,
            attachments: [],
            replyToMsgId: row.request_msg_id,
            workNodeId: row.id,
            visibilityScope: 'public',
            visibleTo: [],
            meta: { error: payload.errorText, attempt: row.attempt }
          })
          emittedMessages.push(msg)
        }

        // 1. Resolve downstream waiting_deps DAG nodes
        const downstreamRows = this.database.db
          .prepare('SELECT node_id FROM work_node_deps WHERE depends_on_id = ?')
          .all(row.id) as Array<{ node_id: string }>
        for (const d of downstreamRows) {
          const depTarget = this.database.db
            .prepare('SELECT * FROM work_nodes WHERE id = ?')
            .get(d.node_id) as unknown as WorkNodeRow | undefined
          if (!depTarget || depTarget.status !== 'waiting_deps') continue

          if (status === 'failed') {
            this.database.db
              .prepare(
                "UPDATE work_nodes SET status = 'cancelled', blocking_reason = NULL, error_text = ?, ended_at = ?, updated_at = ? WHERE id = ?"
              )
              .run(`upstream_failed:${row.id}`, now, now, depTarget.id)
            emittedNodes.push(
              mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(depTarget.id) as unknown as WorkNodeRow)
            )
          } else {
            const uncompleted = this.database.db
              .prepare(
                `SELECT COUNT(*) AS c
                 FROM work_node_deps wd
                 JOIN work_nodes wn ON wn.id = wd.depends_on_id
                 WHERE wd.node_id = ? AND wn.status != 'completed'`
              )
              .get(depTarget.id) as { c: number }
            if ((uncompleted?.c ?? 0) === 0) {
              this.database.db
                .prepare("UPDATE work_nodes SET status = 'queued', blocking_reason = NULL, updated_at = ? WHERE id = ?")
                .run(now, depTarget.id)
              emittedNodes.push(
                mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(depTarget.id) as unknown as WorkNodeRow)
              )
            }
          }
        }

        // 2. Two-phase parent wakeup or late-child system notice
        if (row.parent_node_id) {
          const parentRow = this.database.db
            .prepare('SELECT * FROM work_nodes WHERE id = ?')
            .get(row.parent_node_id) as unknown as WorkNodeRow | undefined
          if (parentRow && parentRow.status === 'waiting_children') {
            const siblings = this.database.db
              .prepare('SELECT * FROM work_nodes WHERE parent_node_id = ? ORDER BY created_at ASC')
              .all(parentRow.id) as unknown as WorkNodeRow[]
            const allSettled = siblings.every((s) => SETTLED_NODE_STATUSES.has(s.status))
            if (allSettled) {
              const existingDeliveries = this.database.db
                .prepare('SELECT child_node_ids_json FROM work_deliveries WHERE target_node_id = ?')
                .all(parentRow.id) as Array<{ child_node_ids_json: string }>
              const alreadySentIds = new Set<string>()
              for (const ed of existingDeliveries) {
                for (const cid of JSON.parse(ed.child_node_ids_json || '[]') as string[]) alreadySentIds.add(cid)
              }
              const batchChildren = siblings.filter((s) => !alreadySentIds.has(s.id))
              if (batchChildren.length > 0) {
                const deliveryId = this.createWorkDeliveryTx(row.room_id, parentRow.id, batchChildren, now)
                const wokenParent = this.deliverWorkDeliveryTx(deliveryId, now)
                if (wokenParent) emittedNodes.push(wokenParent)
              }
            }
          } else if (parentRow && parentRow.status === 'completed' && status === 'completed') {
            emittedMessages.push(
              this.insertMessageTx(row.room_id, {
                authorKind: 'system',
                authorId: 'system',
                authorName: 'System',
                kind: 'system_notice',
                content: `子节点 @${member?.displayName || 'Agent'}（${row.id.slice(0, 8)}）在父节点终结后重试完成：${(payload.resultText || '').slice(0, 400)}`,
                attachments: [],
                replyToMsgId: row.request_msg_id,
                workNodeId: row.id,
                visibilityScope: 'public',
                visibleTo: [],
                meta: {}
              })
            )
          }
        }

        // Sync member's last_delivered_seq BEFORE any Super-step barrier reveal so newly revealed peer msgs stay > last_delivered_seq
        const latestRoom = this.database.db.prepare('SELECT last_seq FROM rooms WHERE id = ?').get(row.room_id) as { last_seq: number }
        this.database.db
          .prepare('UPDATE agent_sessions SET last_delivered_seq = ?, updated_at = ? WHERE room_member_id = ?')
          .run(latestRoom.last_seq, now, row.assignee_member_id)

        const updatedNode = mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(row.id) as unknown as WorkNodeRow)
        const strategy = this.strategies.get(room.strategyId)
        if (strategy) {
          const snapshot = this.buildSnapshotTx(row.room_id)
          const actions = strategy.onNodeSettled(snapshot, updatedNode)
          const res = this.applyActionsTx(row.room_id, strategy, actions, row.request_msg_id)
          emittedMessages.push(...res.messages)
          emittedNodes.push(...res.nodes)
          emittedReveals.push(...res.revealed)

          if (row.superstep !== null) {
            const bRes = this.checkSuperstepBarrierTx(row.room_id, row.superstep)
            emittedMessages.push(...bRes.messages)
            emittedNodes.push(...bRes.nodes)
            emittedReveals.push(...bRes.revealed)
          }
        }

        return updatedNode
      })

      for (const m of emittedMessages) this.events.messageCreated(m)
      for (const r of emittedReveals) this.events.messagesRevealed?.(r)
      this.events.workNodeUpdated(settledNode)
      for (const n of emittedNodes) this.events.workNodeUpdated(n)
      this.events.roomUpdated(this.getRoom(row.room_id))
      if (settledNode.parentNodeId === null) {
        this.events.rootNodeSettled?.(settledNode)
      }
      this.scheduleTick()
    })
  }

  async handleCollabToolCall(req: {
    roomId: string
    memberId: string
    workNodeId?: string
    toolName: string
    args: Record<string, unknown>
    toolCallId: string
  }): Promise<{ ok: boolean; output: string; isError?: boolean }> {
    if (this.reconciling) {
      return { ok: false, isError: true, output: 'Error: Core is reconciling after restart; retry momentarily.' }
    }
    if (!COLLAB_TOOLS.includes(req.toolName as CollabToolName)) {
      return { ok: false, isError: true, output: `Unknown collab tool: ${req.toolName}` }
    }
    const toolName = req.toolName as CollabToolName

    return await this.serially(req.roomId, () => {
      const room = this.getRoom(req.roomId)
      const strategy = this.strategies.get(room.strategyId)
      if (!strategy || !strategy.allowedTools.includes(toolName)) {
        return { ok: false, isError: true, output: `Tool ${toolName} is not enabled for strategy ${room.strategyId}` }
      }
      const callerMember = room.members.find((m) => m.id === req.memberId && m.removedAt === null)
      if (!callerMember) {
        return { ok: false, isError: true, output: `Member not found or removed: ${req.memberId}` }
      }

      const callerRow = req.workNodeId
        ? (this.database.db
            .prepare("SELECT * FROM work_nodes WHERE id = ? AND room_id = ? AND assignee_member_id = ? AND status = 'running'")
            .get(req.workNodeId, req.roomId, req.memberId) as unknown as WorkNodeRow | undefined)
        : (this.database.db
            .prepare("SELECT * FROM work_nodes WHERE room_id = ? AND assignee_member_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1")
            .get(req.roomId, req.memberId) as unknown as WorkNodeRow | undefined)
      if (!callerRow) {
        return { ok: false, isError: true, output: `No active running workNode found for member @${callerMember.displayName}` }
      }

      const callerNode = mapNode(callerRow)
      if (strategy.validateToolCall) {
        const snapshot = this.buildSnapshotTx(req.roomId)
        const check = strategy.validateToolCall(snapshot, callerNode, toolName, req.args)
        if (!check.ok) {
          return { ok: false, isError: true, output: `Blocked: ${check.reason}` }
        }
      }

      const maxDispatches = Number(room.strategyConfig?.maxDispatchesPerRoot ?? 8)
      const maxReplies = Number(room.strategyConfig?.maxRepliesPerRoot ?? 2)
      const maxDepth = Number(room.strategyConfig?.maxDepth ?? 3)
      const now = Date.now()
      const emittedMessages: RoomMessage[] = []
      const emittedNodes: WorkNode[] = []
      let roomDirty = false

      const replyError = (msg: string) => ({ ok: false, isError: true, output: msg })

      try {
        if (toolName === 'collab_history') {
          const beforeSeq = typeof req.args.beforeSeq === 'number' ? req.args.beforeSeq : undefined
          const limit = typeof req.args.limit === 'number' ? Math.min(50, Math.max(1, req.args.limit)) : 20
          const allVisible = this.getVisibleMessagesForMember(req.roomId, callerMember.id, 200)
          const filtered = beforeSeq ? allVisible.filter((m) => m.seq < beforeSeq) : allVisible
          const slice = filtered.slice(-limit)
          if (slice.length === 0) return { ok: true, output: '(no matching messages)' }
          const formatted = slice.map((m) => `#m${m.seq} [${m.authorName}]: ${m.content}`).join('\n')
          return { ok: true, output: formatted }
        }

        if (toolName === 'collab_remember') {
          const text = String(req.args.text ?? '').trim()
          const action = req.args.action === 'remove' ? 'remove' : 'add'
          if (!text) return replyError('text is required for collab_remember')
          let nextMemories = [...room.sharedMemories]
          if (action === 'add') {
            if (!nextMemories.some((m) => m.text === text)) {
              nextMemories.push({ id: randomUUID(), text, authorId: callerMember.id, updatedAt: now })
            }
          } else {
            nextMemories = nextMemories.filter((m) => m.id !== text && m.text !== text)
          }
          this.database.db
            .prepare('UPDATE rooms SET shared_memories_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(nextMemories), now, req.roomId)
          this.events.roomUpdated(this.getRoom(req.roomId))
          return { ok: true, output: action === 'add' ? `Remembered: "${text}"` : `Removed memory matching "${text}"` }
        }

        if (toolName === 'collab_publish') {
          const text = String(req.args.text ?? '').trim()
          if (!text) return replyError('text is required for collab_publish')
          const unsettled = this.database.db
            .prepare(
              "SELECT id FROM work_nodes WHERE parent_node_id = ? AND status NOT IN ('completed','failed','cancelled')"
            )
            .all(callerRow.id) as Array<{ id: string }>
          if (unsettled.length > 0) {
            return replyError(`Cannot call collab_publish while ${unsettled.length} subtask(s) are still running/queued. Wait for them to finish first.`)
          }

          this.database.transaction(() => {
            const verdict = typeof req.args.verdict === 'string' ? req.args.verdict : undefined
            const metadata = req.args.metadata && typeof req.args.metadata === 'object' ? req.args.metadata : undefined
            const vis = parseVisibilityOnPublish(callerRow.visibility_on_publish)
            this.database.db
              .prepare('UPDATE work_nodes SET result_json = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify({ verdict, metadata }), now, callerRow.id)
            const msg = this.insertMessageTx(req.roomId, {
              authorKind: 'agent',
              authorId: callerMember.id,
              authorName: callerMember.displayName,
              kind: callerRow.kind === 'summary' ? 'summary' : 'result',
              content: text,
              attachments: [],
              replyToMsgId: callerRow.request_msg_id,
              workNodeId: callerRow.id,
              visibilityScope: vis.visibilityScope,
              visibleTo: vis.visibleTo,
              meta: { publishedByTool: true, attempt: callerRow.attempt, verdict, metadata }
            })
            emittedMessages.push(msg)
          })
          for (const m of emittedMessages) this.events.messageCreated(m)
          this.events.roomUpdated(this.getRoom(req.roomId))
          return {
            ok: true,
            output:
              emittedMessages[0]?.visibilityScope === 'private'
                ? `Recorded private round response (#m${emittedMessages[0]?.seq ?? '?'}), pending barrier reveal.`
                : `Published public message (#m${emittedMessages[0]?.seq ?? '?'}).`
          }
        }

        if (toolName === 'collab_dispatch') {
          const mode = req.args.mode === 'transfer' ? 'transfer' : 'subtask'
          const rawRecipient = String(req.args.recipientMember ?? '').trim().replace(/^@/, '')
          const instruction = String(req.args.instruction ?? '').trim()
          const expectedResult = String(req.args.expectedResult ?? '').trim()
          if (!rawRecipient || !instruction) {
            return replyError('recipientMember and instruction are required')
          }

          const targetMember = room.members.find(
            (m) => m.removedAt === null && (m.id === rawRecipient || m.displayName.toLowerCase() === rawRecipient.toLowerCase())
          )
          if (!targetMember) {
            const rosterNames = room.members.filter((m) => m.removedAt === null).map((m) => `@${m.displayName}`).join(', ')
            return replyError(`Recipient "${rawRecipient}" is not in the fixed room roster (${rosterNames}). Ad-hoc subagents are forbidden.`)
          }
          if (targetMember.id === callerMember.id) {
            return replyError('Cannot dispatch a subtask or transfer to yourself.')
          }

          const toolIdemKey = `tool:${callerRow.id}:${callerRow.attempt}:${req.toolCallId}`
          const existingIdem = this.database.db
            .prepare('SELECT * FROM work_nodes WHERE room_id = ? AND idempotency_key = ?')
            .get(req.roomId, toolIdemKey) as unknown as WorkNodeRow | undefined
          if (existingIdem) {
            return { ok: true, output: `Already dispatched workNodeId=${existingIdem.id} to @${targetMember.displayName}.` }
          }

          const dispatchCount = this.database.db
            .prepare('SELECT COUNT(*) AS c FROM work_nodes WHERE root_node_id = ? AND parent_node_id IS NOT NULL')
            .get(callerRow.root_node_id) as { c: number }
          if ((dispatchCount?.c ?? 0) >= maxDispatches) {
            return replyError(`Guardrail exceeded: maxDispatchesPerRoot (${maxDispatches}) reached. Summarize your work now.`)
          }
          if (callerRow.depth + 1 > maxDepth) {
            return replyError(`Guardrail exceeded: max node depth (${maxDepth}) reached.`)
          }

          const workspaceMode =
            req.args.workspaceMode === 'read-only' || req.args.workspaceMode === 'shared-rw' || req.args.workspaceMode === 'worktree'
              ? (req.args.workspaceMode as WorkspaceMode)
              : ((room.strategyConfig?.defaultWorkspaceMode as WorkspaceMode) ?? 'shared-rw')
          const inheritFromId =
            typeof req.args.inheritWorkspaceFromNodeId === 'string' && req.args.inheritWorkspaceFromNodeId.trim()
              ? req.args.inheritWorkspaceFromNodeId.trim()
              : undefined
          const dependsOn = Array.isArray(req.args.dependsOn) ? req.args.dependsOn.map(String).filter(Boolean) : []
          const resources = Array.isArray(req.args.resources) ? req.args.resources.map(String).filter(Boolean) : []

          let childId = ''
          this.database.transaction(() => {
            childId = randomUUID()
            let workspaceId = room.primaryWorkspaceId
            if (inheritFromId) {
              const src = this.database.db
                .prepare('SELECT workspace_id FROM work_nodes WHERE id = ? AND room_id = ?')
                .get(inheritFromId, req.roomId) as { workspace_id: string | null } | undefined
              if (!src) throw Errors.notFound(`inheritWorkspaceFromNodeId not found in room: ${inheritFromId}`)
              if (src.workspace_id) workspaceId = src.workspace_id
            }

            let hasPendingDeps = false
            for (const depId of dependsOn) {
              const depRow = this.database.db
                .prepare('SELECT id, status FROM work_nodes WHERE id = ? AND room_id = ?')
                .get(depId, req.roomId) as { id: string; status: string } | undefined
              if (!depRow) throw Errors.notFound(`Dependency workNode not found: ${depId}`)
              if (depRow.status === 'failed' || depRow.status === 'cancelled') {
                throw Errors.conflict('dependency_failed', `Upstream dependency ${depId} is already ${depRow.status}`)
              }
              if (this.wouldCreateCycleTx(childId, depId)) {
                throw Errors.conflict('dependency_cycle', `Cyclic dependency with ${depId}`)
              }
              if (depRow.status !== 'completed') hasPendingDeps = true
            }

            const initialStatus: WorkNode['status'] = hasPendingDeps ? 'waiting_deps' : 'queued'
            const blockingReason = hasPendingDeps ? 'waiting_deps' : null

            this.database.db
              .prepare(
                `INSERT INTO work_nodes (
                   id, room_id, root_node_id, parent_node_id, request_msg_id, assignee_member_id, assignee_agent_id,
                   kind, status, blocking_reason, superstep, instruction, expected_result, workspace_mode, workspace_id,
                   resources_json, visibility_on_publish, depth, idempotency_key, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"scope":"public"}', ?, ?, ?, ?)`
              )
              .run(
                childId,
                req.roomId,
                callerRow.root_node_id,
                mode === 'transfer' ? callerRow.parent_node_id : callerRow.id,
                callerRow.request_msg_id,
                targetMember.id,
                targetMember.agentId,
                mode === 'transfer' ? 'transfer' : 'subtask',
                initialStatus,
                blockingReason,
                callerRow.superstep,
                instruction,
                expectedResult || null,
                workspaceMode,
                workspaceId,
                JSON.stringify(resources),
                mode === 'transfer' ? callerRow.depth : callerRow.depth + 1,
                toolIdemKey,
                now,
                now
              )

            for (const depId of dependsOn) {
              this.database.db
                .prepare('INSERT OR IGNORE INTO work_node_deps (node_id, depends_on_id) VALUES (?, ?)')
                .run(childId, depId)
            }

            emittedNodes.push(
              mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(childId) as unknown as WorkNodeRow)
            )

            if (mode === 'transfer') {
              this.releaseExecutionLease(callerRow.id, callerRow.assignee_agent_id)
              this.database.db
                .prepare(
                  `UPDATE work_nodes
                   SET status = 'completed', transferred_to_node_id = ?, lease_token = NULL, blocking_reason = NULL,
                       result_text = ?, ended_at = ?, updated_at = ?
                   WHERE id = ?`
                )
                .run(childId, `Transferred to @${targetMember.displayName}`, now, now, callerRow.id)
              emittedNodes.push(
                mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(callerRow.id) as unknown as WorkNodeRow)
              )
              emittedMessages.push(
                this.insertMessageTx(req.roomId, {
                  authorKind: 'system',
                  authorId: 'system',
                  authorName: 'System',
                  kind: 'routing_notice',
                  content: `@${callerMember.displayName} 已将当前任务移交至 @${targetMember.displayName}。`,
                  attachments: [],
                  replyToMsgId: callerRow.request_msg_id,
                  workNodeId: childId,
                  visibilityScope: 'public',
                  visibleTo: [],
                  meta: {}
                })
              )
            }

            this.database.db.prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ? AND state != 'paused'").run(now, req.roomId)
            roomDirty = true
          })

          for (const m of emittedMessages) this.events.messageCreated(m)
          for (const n of emittedNodes) this.events.workNodeUpdated(n)
          if (roomDirty) this.events.roomUpdated(this.getRoom(req.roomId))
          this.scheduleTick()
          return {
            ok: true,
            output:
              mode === 'transfer'
                ? `Transferred task to @${targetMember.displayName} (new workNodeId=${childId}). End your turn now.`
                : `Dispatched subtask workNodeId=${childId} to @${targetMember.displayName} (mode=${workspaceMode}). Wait for deliverables after finishing your turn.`
          }
        }

        // toolName === 'collab_reply'
        const rawRef = String(req.args.messageId ?? '').trim()
        const text = String(req.args.text ?? '').trim()
        if (!rawRef || !text) return replyError('messageId and text are required for collab_reply')

        const seqMatch = /^#?m?(\d+)$/i.exec(rawRef)
        const targetMsgRow = seqMatch?.[1]
          ? (this.database.db
              .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq = ?')
              .get(req.roomId, Number(seqMatch[1])) as unknown as MessageRow | undefined)
          : (this.database.db
              .prepare('SELECT * FROM room_messages WHERE room_id = ? AND id = ?')
              .get(req.roomId, rawRef) as unknown as MessageRow | undefined)
        if (!targetMsgRow) return replyError(`Referenced message not found in room: ${rawRef}`)
        if (targetMsgRow.author_kind !== 'agent') {
          return replyError('collab_reply can only address a message authored by a teammate agent.')
        }
        const targetMember = room.members.find((m) => m.id === targetMsgRow.author_id && m.removedAt === null)
        if (!targetMember) return replyError(`Author member of ${rawRef} is no longer active in room.`)
        if (targetMember.id === callerMember.id) return replyError('Cannot collab_reply to your own message.')

        const toolIdemKey = `reply:${callerRow.id}:${callerRow.attempt}:${req.toolCallId}`
        const existingReply = this.database.db
          .prepare('SELECT * FROM work_nodes WHERE room_id = ? AND idempotency_key = ?')
          .get(req.roomId, toolIdemKey) as unknown as WorkNodeRow | undefined
        if (existingReply) {
          return { ok: true, output: `Already created member_reply workNodeId=${existingReply.id} to @${targetMember.displayName}.` }
        }

        const replyCount = this.database.db
          .prepare("SELECT COUNT(*) AS c FROM work_nodes WHERE root_node_id = ? AND kind = 'member_reply'")
          .get(callerRow.root_node_id) as { c: number }
        if ((replyCount?.c ?? 0) >= maxReplies) {
          return replyError(`Guardrail exceeded: maxRepliesPerRoot (${maxReplies}) reached.`)
        }
        if (callerRow.depth + 1 > maxDepth) {
          return replyError(`Guardrail exceeded: max node depth (${maxDepth}) reached.`)
        }

        let replyNodeId = ''
        this.database.transaction(() => {
          replyNodeId = randomUUID()
          this.database.db
            .prepare(
              `INSERT INTO work_nodes (
                 id, room_id, root_node_id, parent_node_id, request_msg_id, assignee_member_id, assignee_agent_id,
                 kind, status, instruction, expected_result, workspace_mode, workspace_id, resources_json,
                 visibility_on_publish, depth, idempotency_key, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member_reply', 'queued', ?, 'Direct clarification reply', 'read-only', ?, '[]', '{"scope":"public"}', ?, ?, ?, ?)`
            )
            .run(
              replyNodeId,
              req.roomId,
              callerRow.root_node_id,
              callerRow.id,
              targetMsgRow.id,
              targetMember.id,
              targetMember.agentId,
              `[@${callerMember.displayName} follow-up on #m${targetMsgRow.seq}]: ${text}`,
              room.primaryWorkspaceId,
              callerRow.depth + 1,
              toolIdemKey,
              now,
              now
            )
          emittedNodes.push(
            mapNode(this.database.db.prepare('SELECT * FROM work_nodes WHERE id = ?').get(replyNodeId) as unknown as WorkNodeRow)
          )
          this.database.db.prepare("UPDATE rooms SET state = 'running', updated_at = ? WHERE id = ? AND state != 'paused'").run(now, req.roomId)
        })

        for (const n of emittedNodes) this.events.workNodeUpdated(n)
        this.events.roomUpdated(this.getRoom(req.roomId))
        this.scheduleTick()
        return {
          ok: true,
          output: `Created member_reply workNodeId=${replyNodeId} for @${targetMember.displayName} (read-only reply turn).`
        }
      } catch (err) {
        return replyError(err instanceof Error ? err.message : String(err))
      }
    })
  }

  private buildAttachmentsPromptBlock(visibleMessages: RoomMessage[], priorityMsgId: string | null): string {
    if (!this.blobs) return ''
    const ordered: RoomMessage[] = []
    if (priorityMsgId) {
      const target = visibleMessages.find((m) => m.id === priorityMsgId)
      if (target) ordered.push(target)
    }
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!
      if (m.id !== priorityMsgId) ordered.push(m)
    }

    const picked: FileRef[] = []
    const seen = new Set<string>()
    for (const m of ordered) {
      for (const att of m.attachments ?? []) {
        if (seen.has(att.fileId)) continue
        seen.add(att.fileId)
        picked.push(att)
        if (picked.length >= 6) break
      }
      if (picked.length >= 6) break
    }
    if (picked.length === 0) return ''

    const sections: string[] = ['[Attached Files]']
    let remainingChars = 12_000
    for (const att of picked) {
      let preview: string | null = null
      try {
        preview = this.blobs.readTextPreview(att.fileId, Math.min(4_000, remainingChars))
      } catch {
        preview = null
      }
      if (preview !== null && remainingChars > 200) {
        remainingChars -= preview.length
        sections.push(
          `- ${att.filename} (fileId=${att.fileId}, mime=${att.mime}, size=${att.sizeBytes}B):\n\`\`\`\n${preview}\n\`\`\``
        )
      } else {
        sections.push(
          `- ${att.filename} (fileId=${att.fileId}, mime=${att.mime}, size=${att.sizeBytes}B; binary or non-inline content)`
        )
      }
    }
    return sections.join('\n')
  }

  // Used for graceful shutdown (does NOT kill daemon external sessions!)
  abortInProcessRuns(): void {
    for (const [, flight] of this.inFlight) {
      flight.abort.abort()
    }
    this.inFlight.clear()
    this.locks.clear()
    this.agentRunningCounts.clear()
  }
}
