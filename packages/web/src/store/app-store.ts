import type {
  Agent,
  BackgroundJob,
  InboxItem,
  McpServer,
  MessagesRevealedNotification,
  ModelProvider,
  NodeEvent,
  PluginDescriptor,
  PluginInstance,
  RoomDetail,
  RoomMember,
  RoomMessage,
  RoomSummary,
  RoutingRule,
  ScheduledJob,
  Skill,
  StreamDeltaNotification,
  TurnUsage,
  WebhookConfig,
  WorkNode,
  WorkNodeControlAction,
  Workspace
} from '@myagents/protocol'
import { create } from 'zustand'
import { apiAuthMe, apiLogout, rpc } from '../api/rpc-client'

export type NavPage = 'chat' | 'inbox' | 'agents' | 'extensions' | 'jobs' | 'analytics' | 'workspaces' | 'settings'
export type DockTab = 'files' | 'changes' | 'tasks' | 'terminal'

export interface LiveToolStep {
  id: string
  name: string
  input?: unknown
  output?: string
  isError?: boolean
  done: boolean
}

export interface LiveTurnBuffer {
  workNodeId: string
  memberId: string
  text: string
  thinking: string
  tools: LiveToolStep[]
  startedAt: number
  firstTokenAt: number | null
  outputChars: number
  usage: TurnUsage | null
}

export interface EnvCheckInfo {
  checkedAt: number
  git: {
    kind: string
    installed: boolean
    version: string | null
    path: string | null
    ready: boolean
    problem?: string
  }
  clis: Array<{
    kind: string
    installed: boolean
    version: string | null
    path: string | null
    ready: boolean
    problem?: string
  }>
}

interface AppState {
  authChecked: boolean
  authenticated: boolean
  username: string | null
  defaultPasswordWarning: boolean
  wsConnected: boolean

  navPage: NavPage
  dockOpen: boolean
  dockTab: DockTab

  providers: ModelProvider[]
  agents: Agent[]
  workspaces: Workspace[]
  rooms: RoomSummary[]
  envCheck: EnvCheckInfo | null
  inboxItems: InboxItem[]
  webhooks: WebhookConfig[]
  routingRules: RoutingRule[]
  pluginDescriptors: PluginDescriptor[]
  pluginInstances: PluginInstance[]
  mcpServers: McpServer[]
  skills: Skill[]
  jobs: BackgroundJob[]
  schedules: ScheduledJob[]

  selectedRoomId: string | null
  currentRoom: RoomDetail | null
  messagesByRoom: Record<string, RoomMessage[]>
  workNodesByRoom: Record<string, WorkNode[]>
  nodeEventsByNode: Record<string, NodeEvent[]>
  liveTurnsByRoom: Record<string, Record<string, LiveTurnBuffer>>

  setNavPage(page: NavPage): void
  setDockOpen(open: boolean): void
  setDockTab(tab: DockTab): void

  bootstrapAuth(): Promise<void>
  onLoginSuccess(username: string, warning?: boolean): Promise<void>
  logout(): Promise<void>

  refreshAll(): Promise<void>
  refreshInbox(): Promise<void>
  refreshExtensions(): Promise<void>
  refreshJobs(): Promise<void>
  selectRoom(roomId: string | null): Promise<void>
  loadNodeEvents(nodeId: string): Promise<void>
  sendMessage(roomId: string, content: string, replyToMsgId?: string, attachmentFileIds?: string[]): Promise<void>
  controlNode(
    nodeId: string,
    action: WorkNodeControlAction,
    opts?: { targetMemberId?: string; note?: string }
  ): Promise<void>
  controlRoom(roomId: string, action: 'pause' | 'resume' | 'stop' | 'next_round' | 'summarize_now'): Promise<void>
  handoffRoom(input: {
    sourceRoomId: string
    sourceMsgId?: string
    targetStrategyId?: string
    title?: string
    members: Array<{ agentId: string; displayName?: string; roleKind?: RoomMember['roleKind'] }>
    workspaceId?: string | null
    seedText?: string
  }): Promise<RoomDetail>
  deleteRoom(roomId: string): Promise<void>
}

let rpcListenersBound = false

export const useAppStore = create<AppState>((set, get) => ({
  authChecked: false,
  authenticated: false,
  username: null,
  defaultPasswordWarning: false,
  wsConnected: false,

  navPage: 'chat',
  dockOpen: true,
  dockTab: 'files',

  providers: [],
  agents: [],
  workspaces: [],
  rooms: [],
  envCheck: null,
  inboxItems: [],
  webhooks: [],
  routingRules: [],
  pluginDescriptors: [],
  pluginInstances: [],
  mcpServers: [],
  skills: [],
  jobs: [],
  schedules: [],

  selectedRoomId: null,
  currentRoom: null,
  messagesByRoom: {},
  workNodesByRoom: {},
  nodeEventsByNode: {},
  liveTurnsByRoom: {},

  setNavPage: (navPage) => set({ navPage }),
  setDockOpen: (dockOpen) => set({ dockOpen }),
  setDockTab: (dockTab) => set({ dockTab, dockOpen: true }),

  bootstrapAuth: async () => {
    try {
      const me = await apiAuthMe()
      if (me.authenticated) {
        set({
          authChecked: true,
          authenticated: true,
          username: me.username ?? 'admin',
          defaultPasswordWarning: Boolean(me.defaultPasswordWarning)
        })
        await connectAndBind(set, get)
        await get().refreshAll()
      } else {
        set({ authChecked: true, authenticated: false })
      }
    } catch {
      set({ authChecked: true, authenticated: false })
    }
  },

  onLoginSuccess: async (username, warning) => {
    set({ authenticated: true, username, defaultPasswordWarning: Boolean(warning) })
    await connectAndBind(set, get)
    await get().refreshAll()
  },

  logout: async () => {
    rpc.disconnect()
    await apiLogout()
    set({
      authenticated: false,
      username: null,
      wsConnected: false,
      rooms: [],
      inboxItems: [],
      selectedRoomId: null,
      currentRoom: null
    })
  },

  refreshAll: async () => {
    const [providers, agents, workspaces, rooms, envCheck] = await Promise.all([
      rpc.call<ModelProvider[]>('providers.list'),
      rpc.call<Agent[]>('agents.list'),
      rpc.call<Workspace[]>('workspaces.list'),
      rpc.call<RoomSummary[]>('rooms.list'),
      rpc.call<EnvCheckInfo>('system.envCheck')
    ])
    set({ providers, agents, workspaces, rooms, envCheck })
    void get()
      .refreshInbox()
      .catch(() => {})
    void get()
      .refreshExtensions()
      .catch(() => {})
    void get()
      .refreshJobs()
      .catch(() => {})
    const curId = get().selectedRoomId
    if (curId && rooms.some((r) => r.id === curId)) {
      await get().selectRoom(curId)
    } else if (!curId && rooms.length > 0) {
      await get().selectRoom(rooms[0]!.id)
    }
  },

  refreshInbox: async () => {
    const [inboxItems, webhooks, routingRules, plugins] = await Promise.all([
      rpc.call<InboxItem[]>('inbox.list'),
      rpc.call<WebhookConfig[]>('webhooks.list'),
      rpc.call<RoutingRule[]>('routingRules.list'),
      rpc.call<{ descriptors: PluginDescriptor[]; instances: PluginInstance[] }>('plugins.list')
    ])
    set({
      inboxItems,
      webhooks,
      routingRules,
      pluginDescriptors: plugins.descriptors,
      pluginInstances: plugins.instances
    })
  },

  refreshExtensions: async () => {
    const [mcpServers, skills] = await Promise.all([
      rpc.call<McpServer[]>('mcpServers.list'),
      rpc.call<Skill[]>('skills.list')
    ])
    set({ mcpServers, skills })
  },

  refreshJobs: async () => {
    const [jobs, schedules] = await Promise.all([
      rpc.call<BackgroundJob[]>('jobs.list', { limit: 100 }),
      rpc.call<ScheduledJob[]>('schedules.list')
    ])
    set({ jobs, schedules })
  },

  selectRoom: async (roomId) => {
    if (!roomId) {
      set({ selectedRoomId: null, currentRoom: null })
      return
    }
    set({ selectedRoomId: roomId, navPage: 'chat' })
    const [room, msgRes, nodes] = await Promise.all([
      rpc.call<RoomDetail>('rooms.get', { id: roomId }),
      rpc.call<{ messages: RoomMessage[]; hasMore: boolean }>('rooms.messages', { roomId }),
      rpc.call<WorkNode[]>('workNodes.list', { roomId })
    ])
    set((s) => ({
      currentRoom: room,
      messagesByRoom: { ...s.messagesByRoom, [roomId]: msgRes.messages },
      workNodesByRoom: { ...s.workNodesByRoom, [roomId]: nodes }
    }))
    for (const n of nodes.slice(0, 15)) {
      void get().loadNodeEvents(n.id)
    }
  },

  loadNodeEvents: async (nodeId) => {
    try {
      const events = await rpc.call<NodeEvent[]>('workNodes.events', { nodeId })
      set((s) => ({ nodeEventsByNode: { ...s.nodeEventsByNode, [nodeId]: events } }))
    } catch {
      // ignore
    }
  },

  sendMessage: async (roomId, content, replyToMsgId, attachmentFileIds) => {
    const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await rpc.call('rooms.sendMessage', {
      roomId,
      content,
      replyToMsgId,
      attachmentFileIds: attachmentFileIds && attachmentFileIds.length > 0 ? attachmentFileIds : undefined,
      idempotencyKey
    })
  },

  controlNode: async (nodeId, action, opts) => {
    await rpc.call('workNodes.control', {
      nodeId,
      action,
      targetMemberId: opts?.targetMemberId,
      note: opts?.note
    })
  },

  controlRoom: async (roomId, action) => {
    await rpc.call('rooms.control', { roomId, action })
  },

  handoffRoom: async (input) => {
    const created = await rpc.call<RoomDetail>('rooms.handoff', input)
    await get().refreshAll()
    await get().selectRoom(created.id)
    return created
  },

  deleteRoom: async (roomId) => {
    await rpc.call('rooms.delete', { id: roomId })
    set((s) => {
      const rooms = s.rooms.filter((r) => r.id !== roomId)
      const nextSelected = s.selectedRoomId === roomId ? (rooms[0]?.id ?? null) : s.selectedRoomId
      return { rooms, selectedRoomId: nextSelected, currentRoom: nextSelected ? s.currentRoom : null }
    })
    const next = get().selectedRoomId
    if (next) await get().selectRoom(next)
  }
}))

async function connectAndBind(set: any, get: () => AppState) {
  if (!rpcListenersBound) {
    rpcListenersBound = true
    rpc.onStatusChange((connected) => {
      set({ wsConnected: connected })
      if (connected && get().authenticated) {
        void get()
          .refreshAll()
          .catch(() => {})
      }
    })
    rpc.onNotification((notif) => {
      const { method, params } = notif
      if (method === 'room.updated') {
        const updated = params as RoomSummary
        set((s: AppState) => {
          const exists = s.rooms.some((r) => r.id === updated.id)
          const rooms = exists ? s.rooms.map((r) => (r.id === updated.id ? updated : r)) : [updated, ...s.rooms]
          const currentRoom = s.currentRoom?.id === updated.id ? { ...s.currentRoom, ...updated } : s.currentRoom
          return { rooms, currentRoom }
        })
      } else if (method === 'room.deleted') {
        const { roomId } = params as { roomId: string }
        set((s: AppState) => ({
          rooms: s.rooms.filter((r) => r.id !== roomId),
          selectedRoomId: s.selectedRoomId === roomId ? null : s.selectedRoomId,
          currentRoom: s.currentRoom?.id === roomId ? null : s.currentRoom
        }))
      } else if (method === 'room.messageCreated') {
        const msg = params as RoomMessage
        set((s: AppState) => {
          const list = s.messagesByRoom[msg.roomId] ?? []
          if (list.some((m) => m.id === msg.id)) return s
          const nextRoomLive = { ...(s.liveTurnsByRoom[msg.roomId] ?? {}) }
          if (msg.workNodeId) delete nextRoomLive[msg.workNodeId]
          return {
            messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: [...list, msg] },
            liveTurnsByRoom: { ...s.liveTurnsByRoom, [msg.roomId]: nextRoomLive }
          }
        })
        if (msg.workNodeId) void get().loadNodeEvents(msg.workNodeId)
      } else if (method === 'room.messagesRevealed') {
        const ev = params as MessagesRevealedNotification
        const revealedSet = new Set(ev.messageIds)
        set((s: AppState) => {
          const list = s.messagesByRoom[ev.roomId]
          if (!list) return s
          return {
            messagesByRoom: {
              ...s.messagesByRoom,
              [ev.roomId]: list.map((m) =>
                revealedSet.has(m.id) ? { ...m, visibilityScope: 'public', visibleSeq: ev.visibleSeq } : m
              )
            }
          }
        })
      } else if (method === 'inbox.updated') {
        void get()
          .refreshInbox()
          .catch(() => {})
      } else if (method === 'jobs.updated') {
        void get()
          .refreshJobs()
          .catch(() => {})
      } else if (method === 'workNode.updated') {
        const node = params as WorkNode
        set((s: AppState) => {
          const list = s.workNodesByRoom[node.roomId] ?? []
          const exists = list.some((n) => n.id === node.id)
          const next = exists ? list.map((n) => (n.id === node.id ? node : n)) : [node, ...list]
          const nextLive = { ...(s.liveTurnsByRoom[node.roomId] ?? {}) }
          if (['completed', 'failed', 'cancelled', 'paused'].includes(node.status)) {
            delete nextLive[node.id]
          }
          return {
            workNodesByRoom: { ...s.workNodesByRoom, [node.roomId]: next },
            liveTurnsByRoom: { ...s.liveTurnsByRoom, [node.roomId]: nextLive }
          }
        })
        if (['completed', 'failed', 'cancelled'].includes(node.status)) {
          void get().loadNodeEvents(node.id)
        }
      } else if (method === 'room.streamDelta') {
        const d = params as StreamDeltaNotification
        set((s: AppState) => {
          const roomLive = { ...(s.liveTurnsByRoom[d.roomId] ?? {}) }
          const matchedNode = (s.workNodesByRoom[d.roomId] ?? []).find((n) => n.id === d.workNodeId)
          const now = Date.now()
          const cur: LiveTurnBuffer = roomLive[d.workNodeId] ?? {
            workNodeId: d.workNodeId,
            memberId: d.memberId,
            text: '',
            thinking: '',
            tools: [],
            startedAt: matchedNode?.startedAt ?? now,
            firstTokenAt: null,
            outputChars: 0,
            usage: null
          }
          const next: LiveTurnBuffer = { ...cur, tools: [...cur.tools] }
          if (d.kind === 'text' && d.delta) {
            next.text += d.delta
            next.outputChars += d.delta.length
            next.firstTokenAt ??= now
          } else if (d.kind === 'thinking' && d.delta) {
            next.thinking += d.delta
            next.outputChars += d.delta.length
            next.firstTokenAt ??= now
          } else if (d.kind === 'usage' && d.usage) {
            next.usage = { ...(next.usage ?? {}), ...d.usage }
          } else if (d.kind === 'tool_start' && d.toolCall) {
            next.tools.push({ id: d.toolCall.id, name: d.toolCall.name, input: d.toolCall.input, done: false })
          } else if (d.kind === 'tool_result' && d.toolCall) {
            const idx = next.tools.findIndex((t) => t.id === d.toolCall!.id)
            if (idx >= 0) {
              next.tools[idx] = {
                ...next.tools[idx]!,
                output: d.toolCall.output,
                isError: d.toolCall.isError,
                done: true
              }
            }
          }
          roomLive[d.workNodeId] = next
          return { liveTurnsByRoom: { ...s.liveTurnsByRoom, [d.roomId]: roomLive } }
        })
      }
    })
  }
  await rpc.connect()
}
