import { z } from 'zod'
import type { CollabStrategy, EngineAction, RoomMessage, RoomSnapshot, WorkNode } from '@myagents/protocol'

const SingleConfigSchema = z.object({}).passthrough()
type SingleConfig = z.infer<typeof SingleConfigSchema>
type SingleState = { turnCount: number }

export const singleStrategy: CollabStrategy<SingleConfig, SingleState> = {
  id: 'single',
  label: '1v1 单聊',
  description: '单个 Agent 在绑定工作区中进行持久化多轮对话，支持流式输出与文件处理。',
  executionModel: 'event-driven',
  configSchema: SingleConfigSchema,
  allowedTools: [],
  defaultWorkspaceMode: 'shared-rw',

  initialState() {
    return { turnCount: 0 }
  },

  reduceState(prev, delta) {
    const inc = typeof delta.incrementTurn === 'number' ? delta.incrementTurn : 0
    return {
      turnCount: (prev.turnCount ?? 0) + inc
    }
  },

  onHumanMessage(ctx: RoomSnapshot<SingleConfig, SingleState>, msg: RoomMessage): EngineAction[] {
    const primary = ctx.members.find((m) => m.removedAt === null)
    if (!primary) {
      return [{ type: 'post_system', text: '该会话没有可用的 Agent 成员。' }]
    }
    return [
      {
        type: 'spawn_node',
        assigneeMemberId: primary.id,
        kind: 'turn',
        instruction: msg.content,
        workspaceMode: 'shared-rw',
        visibilityOnPublish: { scope: 'public' }
      },
      { type: 'set_room_state', state: 'running' }
    ]
  },

  onNodeSettled(ctx: RoomSnapshot<SingleConfig, SingleState>, node: WorkNode): EngineAction[] {
    const stillActive = ctx.activeNodes.some((n) => n.id !== node.id)
    const actions: EngineAction[] = []
    if (node.status === 'completed') {
      actions.push({ type: 'update_strategy_state', delta: { incrementTurn: 1 } })
    }
    if (!stillActive) {
      actions.push({ type: 'set_room_state', state: 'active' })
    }
    return actions
  }
}
