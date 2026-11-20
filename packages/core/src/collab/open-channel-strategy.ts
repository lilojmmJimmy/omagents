import {
  COLLAB_TOOLS,
  WorkspaceMode,
  type CollabStrategy,
  type EngineAction,
  type RoomControlAction,
  type RoomMember,
  type RoomMessage,
  type RoomSnapshot,
  type WorkNode
} from '@myagents/protocol'
import { z } from 'zod'

export const OpenChannelConfigSchema = z
  .object({
    defaultWorkspaceMode: WorkspaceMode.default('shared-rw'),
    maxDispatchesPerRoot: z.number().int().min(1).max(30).default(8),
    maxRepliesPerRoot: z.number().int().min(0).max(10).default(2),
    maxDepth: z.number().int().min(1).max(5).default(3)
  })
  .passthrough()

export type OpenChannelConfig = z.infer<typeof OpenChannelConfigSchema>
export type OpenChannelState = {
  turnCount: number
  lastDispatchedMemberIds: string[]
}

export const RESUME_COMMAND_REGEX = /^(?:continue|resume)(?:$|[\s.!?,])$/i

/**
 * Deterministic leading @mention parser (case-insensitive, longest displayName first).
 * Supports @everyone and multiple leading @member1 @member2 mentions.
 */
export function parseLeadingMentions(
  content: string,
  members: RoomMember[]
): { everyone: boolean; matchedMembers: RoomMember[] } {
  const active = members.filter((m) => m.removedAt === null)
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('@')) {
    return { everyone: false, matchedMembers: [] }
  }

  if (/^@everyone(?:$|[\s,:;.!?])/i.test(trimmed)) {
    return { everyone: true, matchedMembers: active }
  }

  // Sort longest displayName first so e.g. "@Claude Lead" matches before "@Claude".
  const sorted = [...active].sort((a, b) => b.displayName.length - a.displayName.length)
  const matched: RoomMember[] = []
  const seenIds = new Set<string>()
  let cursor = trimmed

  while (cursor.startsWith('@')) {
    const afterAt = cursor.slice(1)
    const lowerAfter = afterAt.toLowerCase()
    const hit = sorted.find((m) => {
      const nameLower = m.displayName.toLowerCase()
      if (!nameLower || !lowerAfter.startsWith(nameLower)) return false
      const nextChar = afterAt.slice(m.displayName.length, m.displayName.length + 1)
      if (!nextChar) return true
      return /[A-Za-z0-9_]$/.test(m.displayName) ? !/[A-Za-z0-9_]/.test(nextChar) : true
    })
    if (!hit) break
    if (!seenIds.has(hit.id)) {
      seenIds.add(hit.id)
      matched.push(hit)
    }
    cursor = afterAt.slice(hit.displayName.length).replace(/^[\s,:;]+/, '')
  }

  return { everyone: false, matchedMembers: matched }
}

export const openChannelStrategy: CollabStrategy<OpenChannelConfig, OpenChannelState> = {
  id: 'open-channel',
  label: 'Open Channel',
  description: 'Fixed-roster multi-agent collaboration group supporting @member/@everyone deterministic routing, task delegation/transfer, Git worktree isolation, and manual intervention.',
  executionModel: 'event-driven',
  configSchema: OpenChannelConfigSchema,
  allowedTools: COLLAB_TOOLS,
  defaultWorkspaceMode: 'shared-rw',

  initialState() {
    return { turnCount: 0, lastDispatchedMemberIds: [] }
  },

  reduceState(prev, delta) {
    const inc = typeof delta.incrementTurn === 'number' ? delta.incrementTurn : 0
    const nextDispatched = Array.isArray(delta.lastDispatchedMemberIds)
      ? delta.lastDispatchedMemberIds.map(String)
      : (prev.lastDispatchedMemberIds ?? [])
    return {
      turnCount: (prev.turnCount ?? 0) + inc,
      lastDispatchedMemberIds: nextDispatched
    }
  },

  onHumanMessage(ctx: RoomSnapshot<OpenChannelConfig, OpenChannelState>, msg: RoomMessage): EngineAction[] {
    const active = ctx.members.filter((m) => m.removedAt === null)
    if (active.length === 0) {
      return [{ type: 'post_system', text: 'No active member available in this collaboration room.', kind: 'system_notice' }]
    }

    const wsMode = ctx.config.defaultWorkspaceMode ?? 'shared-rw'
    const mentions = parseLeadingMentions(msg.content, active)

    // 1 & 2. Leading @everyone or @member1 @member2
    if (mentions.matchedMembers.length > 0) {
      const actions: EngineAction[] = mentions.matchedMembers.map((member) => ({
        type: 'spawn_node',
        assigneeMemberId: member.id,
        kind: 'turn',
        instruction: msg.content,
        workspaceMode: wsMode,
        visibilityOnPublish: { scope: 'public' }
      }))
      actions.push({
        type: 'update_strategy_state',
        delta: { lastDispatchedMemberIds: mentions.matchedMembers.map((m) => m.id) }
      })
      actions.push({ type: 'set_room_state', state: 'running' })
      return actions
    }

    // 3. Explicit reply to a member message
    if (msg.replyToMsgId) {
      const targetMsg = ctx.recentMessages.find((m) => m.id === msg.replyToMsgId)
      if (targetMsg && targetMsg.authorKind === 'agent') {
        const replyMember = active.find((m) => m.id === targetMsg.authorId)
        if (replyMember) {
          return [
            {
              type: 'spawn_node',
              assigneeMemberId: replyMember.id,
              kind: 'turn',
              instruction: msg.content,
              workspaceMode: wsMode,
              visibilityOnPublish: { scope: 'public' }
            },
            { type: 'set_room_state', state: 'running' }
          ]
        }
      }
    }

    // 4. Explicit resume command -> resume paused root if called standalone
    if (RESUME_COMMAND_REGEX.test(msg.content.trim())) {
      const pausedRoot = ctx.activeNodes.find((n) => n.parentNodeId === null && n.status === 'paused')
      if (pausedRoot) {
        const pausedMember = active.find((m) => m.id === pausedRoot.assigneeMemberId)
        if (pausedMember) {
          return [
            {
              type: 'spawn_node',
              assigneeMemberId: pausedMember.id,
              kind: 'turn',
              instruction: `[Resuming previous paused task: ${pausedRoot.instruction}]\n\n${msg.content}`,
              workspaceMode: pausedRoot.workspaceMode ?? wsMode,
              visibilityOnPublish: { scope: 'public' }
            },
            { type: 'set_room_state', state: 'running' }
          ]
        }
      }
    }

    // 5 & 6. Single active member or deterministic Lead fallback (first position fallback if no explicit lead)
    const target =
      active.length === 1
        ? active[0]!
        : (active.find((m) => m.roleKind === 'lead') ?? active[0]!)

    return [
      {
        type: 'spawn_node',
        assigneeMemberId: target.id,
        kind: 'turn',
        instruction: msg.content,
        workspaceMode: wsMode,
        visibilityOnPublish: { scope: 'public' }
      },
      {
        type: 'update_strategy_state',
        delta: { lastDispatchedMemberIds: [target.id] }
      },
      { type: 'set_room_state', state: 'running' }
    ]
  },

  validateToolCall(_ctx, node, tool) {
    if (node.kind === 'member_reply' && (tool === 'collab_dispatch' || tool === 'collab_reply')) {
      return {
        ok: false,
        reason: 'Reply turns (member_reply) are single-turn responses and cannot invoke collab_dispatch or collab_reply.'
      }
    }
    return { ok: true }
  },

  onNodeSettled(ctx: RoomSnapshot<OpenChannelConfig, OpenChannelState>, node: WorkNode): EngineAction[] {
    const stillActive = ctx.activeNodes.some(
      (n) => n.id !== node.id && ['queued', 'waiting_deps', 'waiting_lock', 'starting', 'running', 'waiting_children'].includes(n.status)
    )
    const actions: EngineAction[] = []
    if (node.status === 'completed') {
      actions.push({ type: 'update_strategy_state', delta: { incrementTurn: 1 } })
    }
    if (!stillActive) {
      actions.push({ type: 'set_room_state', state: 'active' })
    }
    return actions
  },

  onControl(ctx: RoomSnapshot<OpenChannelConfig, OpenChannelState>, action: RoomControlAction): EngineAction[] {
    if (action === 'pause') {
      return [
        { type: 'set_room_state', state: 'paused' },
        { type: 'post_system', text: 'Collaboration room paused by user.', kind: 'routing_notice' }
      ]
    }
    if (action === 'resume') {
      const hasRunning = ctx.activeNodes.some((n) => ['queued', 'starting', 'running', 'waiting_children'].includes(n.status))
      return [
        { type: 'set_room_state', state: hasRunning ? 'running' : 'active' },
        { type: 'post_system', text: 'Collaboration room resumed.', kind: 'routing_notice' }
      ]
    }
    if (action === 'stop') {
      const cancelIds = ctx.activeNodes
        .filter((n) => !['completed', 'failed', 'cancelled'].includes(n.status))
        .map((n) => n.id)
      return [
        ...(cancelIds.length > 0 ? [{ type: 'cancel_nodes' as const, nodeIds: cancelIds, reason: 'stopped_by_user' }] : []),
        { type: 'set_room_state', state: 'active' },
        { type: 'post_system', text: 'Stopped all active tasks in this collaboration room.', kind: 'routing_notice' }
      ]
    }
    return []
  }
}
