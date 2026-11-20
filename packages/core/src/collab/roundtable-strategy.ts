import {
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

export const RoundtableConfigSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(10).default(2),
    blindFirstRound: z.boolean().default(true),
    anonymous: z.boolean().default(false),
    chairParticipates: z.boolean().default(true),
    autoAdvance: z.boolean().default(true),
    defaultWorkspaceMode: WorkspaceMode.default('read-only')
  })
  .passthrough()

export type RoundtableConfig = z.infer<typeof RoundtableConfigSchema>

export type RoundtablePhase =
  | 'idle'
  | 'discussing'
  | 'awaiting_next_round'
  | 'paused_partial_failure'
  | 'summarizing'
  | 'done'

export type RoundtableState = {
  topic: string | null
  currentRound: number
  currentSuperstep: number
  phase: RoundtablePhase
  lastBarrierSuperstep: number
  verdictsBySuperstep: Record<string, Array<{ memberId: string; verdict?: string; status: string }>>
}

function getParticipants(members: RoomMember[], chairParticipates: boolean): { chair: RoomMember; speakers: RoomMember[] } {
  const active = [...members.filter((m) => m.removedAt === null)].sort((a, b) => a.position - b.position)
  const chair = active.find((m) => m.roleKind === 'chair') ?? active.find((m) => m.roleKind === 'lead') ?? active[0]!
  const nonChairs = active.filter((m) => m.id !== chair.id)
  const speakers = chairParticipates || nonChairs.length === 0 ? active : nonChairs
  return { chair, speakers }
}

function buildRoundNodes(opts: {
  speakers: RoomMember[]
  topic: string
  round: number
  superstep: number
  blind: boolean
  workspaceMode: WorkspaceMode
}): EngineAction[] {
  const { speakers, topic, round, superstep, blind, workspaceMode } = opts
  const instruction =
    round === 1
      ? `[Round ${round} Independent Position] Present your independent analysis and key rationale for the topic:\n\n${topic}`
      : `[Round ${round} Roundtable Peer Review] Review the revealed positions and new context from the previous round, then refine or reaffirm your stance:\n\n${topic}`

  return speakers.map((member) => ({
    type: 'spawn_node',
    assigneeMemberId: member.id,
    kind: 'round_post',
    instruction,
    expectedResult: round === 1 ? 'Independent position and core rationale' : 'Updated stance (optional verdict: hold/changed/approve/revise)',
    workspaceMode,
    visibilityOnPublish: blind ? { scope: 'private', allowedMemberIds: [member.id] } : { scope: 'public' },
    superstep
  }))
}

function buildSummaryAction(chair: RoomMember, topic: string, superstep: number, maxRounds: number): EngineAction {
  return {
    type: 'spawn_node',
    assigneeMemberId: chair.id,
    kind: 'summary',
    instruction: `[Roundtable Chair Summary] Synthesize all visible discussion rounds (up to ${maxRounds}), identify areas of consensus and disagreement, and propose actionable next steps. Original topic:\n\n${topic}`,
    expectedResult: 'Structured roundtable conclusion and action plan',
    workspaceMode: 'read-only',
    visibilityOnPublish: { scope: 'public' },
    superstep
  }
}

export const roundtableStrategy: CollabStrategy<RoundtableConfig, RoundtableState> = {
  id: 'roundtable',
  label: 'Roundtable',
  description: 'Pregel Super-step multi-agent blind roundtable supporting round-1 isolation, optional anonymity, multi-round convergence, and Chair synthesis handoff.',
  executionModel: 'superstep',
  configSchema: RoundtableConfigSchema,
  allowedTools: ['collab_publish', 'collab_history', 'collab_remember'],
  defaultWorkspaceMode: 'read-only',

  initialState() {
    return {
      topic: null,
      currentRound: 0,
      currentSuperstep: 0,
      phase: 'idle',
      lastBarrierSuperstep: 0,
      verdictsBySuperstep: {}
    }
  },

  reduceState(prev, delta) {
    const next: RoundtableState = {
      topic: typeof delta.topic === 'string' ? delta.topic : (prev.topic ?? null),
      currentRound: typeof delta.currentRound === 'number' ? delta.currentRound : (prev.currentRound ?? 0),
      currentSuperstep: typeof delta.currentSuperstep === 'number' ? delta.currentSuperstep : (prev.currentSuperstep ?? 0),
      phase: (typeof delta.phase === 'string' ? delta.phase : prev.phase ?? 'idle') as RoundtablePhase,
      lastBarrierSuperstep:
        typeof delta.lastBarrierSuperstep === 'number' ? delta.lastBarrierSuperstep : (prev.lastBarrierSuperstep ?? 0),
      verdictsBySuperstep: { ...(prev.verdictsBySuperstep ?? {}) }
    }
    if (delta.appendVerdicts && typeof delta.appendVerdicts === 'object') {
      const entry = delta.appendVerdicts as {
        superstep: number
        records: Array<{ memberId: string; verdict?: string; status: string }>
      }
      next.verdictsBySuperstep[String(entry.superstep)] = entry.records
    }
    return next
  },

  onHumanMessage(ctx: RoomSnapshot<RoundtableConfig, RoundtableState>, msg: RoomMessage): EngineAction[] {
    const active = ctx.members.filter((m) => m.removedAt === null)
    if (active.length === 0) {
      return [{ type: 'post_system', text: 'No active member available in this roundtable room.', kind: 'system_notice' }]
    }

    const phase = ctx.state.phase ?? 'idle'
    // Mid-discussion human interjection must NOT reset round = 1
    if (phase !== 'idle' && phase !== 'done') {
      return [
        {
          type: 'post_system',
          text: 'Recorded moderator interjection; it will take effect on the next super-step without resetting the current round.',
          kind: 'routing_notice'
        }
      ]
    }

    const { speakers } = getParticipants(active, ctx.config.chairParticipates ?? true)
    const nextSuperstep = (ctx.state.currentSuperstep ?? 0) + 1
    const blind = ctx.config.blindFirstRound ?? true
    const wsMode = ctx.config.defaultWorkspaceMode ?? 'read-only'

    return [
      {
        type: 'update_strategy_state',
        delta: {
          topic: msg.content,
          currentRound: 1,
          currentSuperstep: nextSuperstep,
          phase: 'discussing'
        }
      },
      {
        type: 'post_system',
        text: `Roundtable started (Round 1 / ${ctx.config.maxRounds ?? 2}${blind ? ' · blind isolation' : ''}${ctx.config.anonymous ? ' · anonymous' : ''}) with ${speakers.length} participant(s) sharing independent positions in parallel.`,
        kind: 'routing_notice'
      },
      ...buildRoundNodes({
        speakers,
        topic: msg.content,
        round: 1,
        superstep: nextSuperstep,
        blind,
        workspaceMode: wsMode
      }),
      { type: 'set_room_state', state: 'running' }
    ]
  },

  onNodeSettled(_ctx: RoomSnapshot<RoundtableConfig, RoundtableState>, _node: WorkNode): EngineAction[] {
    // Super-step advancement happens atomically at onSuperstepBarrier
    return []
  },

  onSuperstepBarrier(
    ctx: RoomSnapshot<RoundtableConfig, RoundtableState>,
    superstep: number,
    settledNodes: WorkNode[]
  ): EngineAction[] {
    if (superstep <= (ctx.state.lastBarrierSuperstep ?? 0)) {
      return []
    }

    const active = ctx.members.filter((m) => m.removedAt === null)
    if (active.length === 0) {
      return [{ type: 'set_room_state', state: 'active' }]
    }

    const settledIds = new Set(settledNodes.map((n) => n.id))
    const privateMsgIds = ctx.recentMessages
      .filter((m) => m.visibilityScope === 'private' && m.workNodeId && settledIds.has(m.workNodeId))
      .map((m) => m.id)

    const verdictRecords = settledNodes.map((n) => ({
      memberId: n.assigneeMemberId,
      verdict: typeof n.resultJson?.verdict === 'string' ? String(n.resultJson.verdict) : undefined,
      status: n.status
    }))

    const actions: EngineAction[] = []
    if (privateMsgIds.length > 0) {
      actions.push({ type: 'reveal_messages', messageIds: privateMsgIds })
    }

    const phase = ctx.state.phase ?? 'idle'
    if (phase === 'summarizing') {
      const summaryOk = settledNodes.some((n) => n.kind === 'summary' && n.status === 'completed')
      actions.push({
        type: 'update_strategy_state',
        delta: {
          lastBarrierSuperstep: superstep,
          phase: summaryOk ? 'done' : 'paused_partial_failure',
          appendVerdicts: { superstep, records: verdictRecords }
        }
      })
      actions.push({ type: 'set_room_state', state: summaryOk ? 'done' : 'paused' })
      actions.push({
        type: 'post_system',
        text: summaryOk
          ? 'Chair summary completed. Use "Handoff" to dispatch execution tasks or post a new topic to start another cycle.'
          : 'Chair summary failed; retry the node or trigger Summarize Now again.',
        kind: 'routing_notice'
      })
      return actions
    }

    const hasFailures = settledNodes.some((n) => n.status === 'failed' || n.status === 'cancelled')
    if (hasFailures) {
      actions.push({
        type: 'update_strategy_state',
        delta: {
          lastBarrierSuperstep: superstep,
          phase: 'paused_partial_failure',
          appendVerdicts: { superstep, records: verdictRecords }
        }
      })
      actions.push({ type: 'set_room_state', state: 'paused' })
      actions.push({
        type: 'post_system',
        text: `Round ${ctx.state.currentRound ?? 1} encountered partial failure or cancellation and is paused awaiting intervention (retry failed seats in Tasks, or click Next Round / Summarize Now).`,
        kind: 'system_notice'
      })
      return actions
    }

    const currentRound = ctx.state.currentRound ?? 1
    const maxRounds = ctx.config.maxRounds ?? 2
    const topic = ctx.state.topic || ''
    const { chair, speakers } = getParticipants(active, ctx.config.chairParticipates ?? true)

    const allConverged =
      currentRound >= 2 &&
      settledNodes.length > 0 &&
      settledNodes.every((n) => {
        const v = typeof n.resultJson?.verdict === 'string' ? String(n.resultJson.verdict).toLowerCase() : ''
        return v === 'hold' || v === 'approve'
      })

    if (allConverged || currentRound >= maxRounds) {
      const nextSuperstep = superstep + 1
      actions.push({
        type: 'update_strategy_state',
        delta: {
          lastBarrierSuperstep: superstep,
          currentSuperstep: nextSuperstep,
          phase: 'summarizing',
          appendVerdicts: { superstep, records: verdictRecords }
        }
      })
      actions.push({
        type: 'post_system',
        text: allConverged
          ? `Round ${currentRound} reached consensus (hold/approve); proceeding to Chair summary.`
          : `Completed all ${maxRounds} rounds (responses revealed); proceeding to Chair summary.`,
        kind: 'routing_notice'
      })
      actions.push(buildSummaryAction(chair, topic, nextSuperstep, maxRounds))
      actions.push({ type: 'set_room_state', state: 'running' })
      return actions
    }

    if (!(ctx.config.autoAdvance ?? true)) {
      actions.push({
        type: 'update_strategy_state',
        delta: {
          lastBarrierSuperstep: superstep,
          phase: 'awaiting_next_round',
          appendVerdicts: { superstep, records: verdictRecords }
        }
      })
      actions.push({ type: 'set_room_state', state: 'paused' })
      actions.push({
        type: 'post_system',
        text: `Round ${currentRound} / ${maxRounds} positions revealed; waiting for Next Round or Summarize Now.`,
        kind: 'routing_notice'
      })
      return actions
    }

    const nextRound = currentRound + 1
    const nextSuperstep = superstep + 1
    const blind = ctx.config.blindFirstRound ?? true
    actions.push({
      type: 'update_strategy_state',
      delta: {
        lastBarrierSuperstep: superstep,
        currentRound: nextRound,
        currentSuperstep: nextSuperstep,
        phase: 'discussing',
        appendVerdicts: { superstep, records: verdictRecords }
      }
    })
    actions.push({
      type: 'post_system',
      text: `Round ${currentRound} positions revealed; advancing automatically to Round ${nextRound} / ${maxRounds} peer review.`,
      kind: 'routing_notice'
    })
    actions.push(
      ...buildRoundNodes({
        speakers,
        topic,
        round: nextRound,
        superstep: nextSuperstep,
        blind,
        workspaceMode: ctx.config.defaultWorkspaceMode ?? 'read-only'
      })
    )
    actions.push({ type: 'set_room_state', state: 'running' })
    return actions
  },

  validateToolCall(_ctx, _node, tool) {
    if (tool === 'collab_dispatch' || tool === 'collab_reply') {
      return {
        ok: false,
        reason: 'Roundtable super-step strategy forbids collab_dispatch and collab_reply.'
      }
    }
    return { ok: true }
  },

  onControl(ctx: RoomSnapshot<RoundtableConfig, RoundtableState>, action: RoomControlAction): EngineAction[] {
    const active = ctx.members.filter((m) => m.removedAt === null)
    const { chair, speakers } = getParticipants(active, ctx.config.chairParticipates ?? true)
    const topic = ctx.state.topic || ctx.room.title
    const currentRound = ctx.state.currentRound ?? 1
    const currentSuperstep = ctx.state.currentSuperstep ?? 1
    const maxRounds = ctx.config.maxRounds ?? 2

    if (action === 'pause') {
      return [
        { type: 'set_room_state', state: 'paused' },
        { type: 'post_system', text: 'Roundtable discussion paused by user.', kind: 'routing_notice' }
      ]
    }

    if (action === 'stop') {
      const cancelIds = ctx.activeNodes
        .filter((n) => !['completed', 'failed', 'cancelled'].includes(n.status))
        .map((n) => n.id)
      return [
        ...(cancelIds.length > 0 ? [{ type: 'cancel_nodes' as const, nodeIds: cancelIds, reason: 'stopped_by_user' }] : []),
        { type: 'update_strategy_state', delta: { phase: 'idle', lastBarrierSuperstep: currentSuperstep } },
        { type: 'set_room_state', state: 'active' },
        { type: 'post_system', text: 'Stopped current roundtable discussion.', kind: 'routing_notice' }
      ]
    }

    if (action === 'summarize_now') {
      const cancelIds = ctx.activeNodes
        .filter((n) => !['completed', 'failed', 'cancelled'].includes(n.status))
        .map((n) => n.id)
      const privateIds = ctx.recentMessages.filter((m) => m.visibilityScope === 'private').map((m) => m.id)
      const nextSuperstep = currentSuperstep + 1
      return [
        ...(privateIds.length > 0 ? [{ type: 'reveal_messages' as const, messageIds: privateIds }] : []),
        ...(cancelIds.length > 0 ? [{ type: 'cancel_nodes' as const, nodeIds: cancelIds, reason: 'summarize_now' }] : []),
        {
          type: 'update_strategy_state',
          delta: {
            lastBarrierSuperstep: currentSuperstep,
            currentSuperstep: nextSuperstep,
            phase: 'summarizing'
          }
        },
        buildSummaryAction(chair, topic, nextSuperstep, maxRounds),
        { type: 'set_room_state', state: 'running' },
        { type: 'post_system', text: 'Early summary triggered by user; Chair is synthesizing results.', kind: 'routing_notice' }
      ]
    }

    if (action === 'next_round' || (action === 'resume' && (ctx.state.phase === 'awaiting_next_round' || ctx.state.phase === 'paused_partial_failure'))) {
      if (ctx.activeNodes.some((n) => ['queued', 'starting', 'running'].includes(n.status))) {
        return [
          { type: 'set_room_state', state: 'running' },
          { type: 'post_system', text: 'Roundtable execution resumed.', kind: 'routing_notice' }
        ]
      }
      const nextSuperstep = currentSuperstep + 1
      if (currentRound >= maxRounds) {
        return [
          {
            type: 'update_strategy_state',
            delta: { lastBarrierSuperstep: currentSuperstep, currentSuperstep: nextSuperstep, phase: 'summarizing' }
          },
          buildSummaryAction(chair, topic, nextSuperstep, maxRounds),
          { type: 'set_room_state', state: 'running' }
        ]
      }
      const nextRound = currentRound + 1
      return [
        {
          type: 'update_strategy_state',
          delta: {
            lastBarrierSuperstep: currentSuperstep,
            currentRound: nextRound,
            currentSuperstep: nextSuperstep,
            phase: 'discussing'
          }
        },
        { type: 'post_system', text: `Manually advanced to Round ${nextRound} / ${maxRounds}.`, kind: 'routing_notice' },
        ...buildRoundNodes({
          speakers,
          topic,
          round: nextRound,
          superstep: nextSuperstep,
          blind: ctx.config.blindFirstRound ?? true,
          workspaceMode: ctx.config.defaultWorkspaceMode ?? 'read-only'
        }),
        { type: 'set_room_state', state: 'running' }
      ]
    }

    if (action === 'resume') {
      const hasRunning = ctx.activeNodes.some((n) => ['queued', 'starting', 'running', 'waiting_children'].includes(n.status))
      return [
        { type: 'set_room_state', state: hasRunning ? 'running' : 'active' },
        { type: 'post_system', text: 'Roundtable discussion resumed.', kind: 'routing_notice' }
      ]
    }

    return []
  }
}
