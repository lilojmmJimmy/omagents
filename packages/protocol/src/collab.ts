import type { z } from 'zod'
import type { Agent, Workspace, WorkspaceMode } from './models'
import type { RoomDetail, RoomMember, RoomMessage, WorkNode, WorkNodeKind } from './room'

export const WORKSPACE_TOOLS = [
  'workspace_list',
  'workspace_read',
  'workspace_grep',
  'workspace_git_diff',
  'workspace_write',
  'workspace_patch',
  'workspace_exec'
] as const
export type WorkspaceToolName = (typeof WORKSPACE_TOOLS)[number]

export const COLLAB_TOOLS = [
  'collab_dispatch',
  'collab_reply',
  'collab_publish',
  'collab_history',
  'collab_remember'
] as const
export type CollabToolName = (typeof COLLAB_TOOLS)[number]

export type MessageVisibility = { scope: 'public' } | { scope: 'private'; allowedMemberIds: string[] }

export type EngineAction =
  | {
      type: 'spawn_node'
      assigneeMemberId: string
      kind: WorkNodeKind
      instruction: string
      expectedResult?: string
      parentNodeId?: string
      dependsOn?: string[]
      workspaceMode?: WorkspaceMode
      inheritWorkspaceFromNodeId?: string
      resources?: string[]
      visibilityOnPublish?: MessageVisibility
      superstep?: number
    }
  | { type: 'reveal_messages'; messageIds: string[] }
  | { type: 'post_system'; text: string; kind?: 'routing_notice' | 'system_notice' }
  | { type: 'update_strategy_state'; delta: Record<string, unknown> }
  | { type: 'set_room_state'; state: 'active' | 'running' | 'pausing' | 'paused' | 'done' }
  | { type: 'cancel_nodes'; nodeIds: string[]; reason: string }

export interface RoomSnapshot<TConfig = Record<string, unknown>, TState = Record<string, unknown>> {
  room: RoomDetail
  config: TConfig
  state: TState
  members: RoomMember[]
  recentMessages: RoomMessage[]
  activeNodes: WorkNode[]
}

export type RoomControlAction = 'pause' | 'resume' | 'stop' | 'next_round' | 'summarize_now'

export interface CollabStrategy<TConfig = Record<string, unknown>, TState = Record<string, unknown>> {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly executionModel: 'event-driven' | 'superstep'
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
  readonly allowedTools: readonly CollabToolName[]
  readonly defaultWorkspaceMode: WorkspaceMode

  initialState(config: TConfig): TState
  reduceState(prev: TState, delta: Record<string, unknown>): TState

  onHumanMessage(ctx: RoomSnapshot<TConfig, TState>, msg: RoomMessage): EngineAction[]
  onNodeSettled(ctx: RoomSnapshot<TConfig, TState>, node: WorkNode): EngineAction[]
  onSuperstepBarrier?(ctx: RoomSnapshot<TConfig, TState>, superstep: number, settledNodes: WorkNode[]): EngineAction[]
  onControl?(ctx: RoomSnapshot<TConfig, TState>, action: RoomControlAction): EngineAction[]
  onMembersChanged?(ctx: RoomSnapshot<TConfig, TState>): EngineAction[]
  validateToolCall?(
    ctx: RoomSnapshot<TConfig, TState>,
    node: WorkNode,
    tool: CollabToolName,
    args: unknown
  ): { ok: true } | { ok: false; reason: string }
}

// 5-Layer Agent Environment Isolation Profile (activated in v0.1b)
export interface IsolationProfile {
  level: 'standard' | 'fenced-ro' | 'lockdown'
  cleanEnv: boolean
  configHomeDir?: string
  envOverrides?: Record<string, string>
  mcpConfigPath?: string
  blockSubagents: boolean
  writableDirs: string[]
  readonlyDirs: string[]
  readableFiles: string[]
  disallowedTools: string[]
  allowedTools: string[]
}

export interface EnvironmentIsolator {
  buildLaunchPlan(ctx: {
    agent: Agent
    workspace: Workspace
    workspaceMode: WorkspaceMode
    strategyPolicy: WorkspaceMode
    sourceTrustLevel: 'trusted' | 'untrusted'
    isMultiAgentRoom: boolean
    readableFiles: string[]
    readonlyRefPaths: string[]
    mcpConfigPath?: string
    mcpConfigHash?: string
    skillsHash?: string
    externalMcpNames?: string[]
  }): Promise<{ profile: IsolationProfile; configHash: string }>
}

// Security & Governance Extension Hooks
export interface Actor {
  kind: 'human' | 'system' | 'webhook'
  id: string
  username: string
}

export interface RequestContext {
  token?: string
  cookie?: string
  origin?: string
  host?: string
  remoteAddress?: string
}

export interface AuthGuard {
  authorize(
    ctx: RequestContext,
    action: string,
    resource?: { type: string; id?: string }
  ): Promise<{ allowed: boolean; actor: Actor; code?: 'unauthorized' | 'forbidden'; reason?: string }>
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
  checkToolCall(req: {
    roomId: string
    workNodeId: string
    agentId: string
    toolName: string
    args: unknown
  }): Promise<{ decision: 'allow' | 'deny' | 'ask'; reason?: string }>
}
