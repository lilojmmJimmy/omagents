import type {
  Agent,
  CollabToolName,
  DriverCapabilities,
  DriverKind,
  IsolationProfile,
  RoomMessage,
  TurnUsage,
  Workspace,
  WorkspaceMode
} from '@myagents/protocol'
import type { ResolvedExternalMcpServer } from '../mcp/mcp-client'

export interface TurnStreamEvent {
  kind: 'text' | 'thinking' | 'tool_start' | 'tool_result' | 'usage' | 'notice' | 'error'
  delta?: string
  toolCall?: {
    id: string
    name: string
    input?: unknown
    output?: string
    isError?: boolean
  }
  usage?: TurnUsage
}

export interface SessionRecord {
  id: string
  roomId: string
  roomMemberId: string
  agentId: string
  driverKind: DriverKind
  daemonSessionId: string | null
  nativeSessionId: string | null
  configHash: string | null
  lastDeliveredSeq: number
  lastConsumedOffset: number
}

export interface TurnInput {
  session: SessionRecord
  agent: Agent
  roomId: string
  workNodeId: string
  attempt: number
  workspace: Workspace
  workspaceMode: WorkspaceMode
  isolation: IsolationProfile
  configHash: string
  instruction: string
  systemContextPrompt?: string
  skillsPrompt?: string
  mcpConfigPath?: string
  externalMcpServers?: ResolvedExternalMcpServer[]
  allowedCollabTools?: readonly CollabToolName[]
  callCollabTool?: (
    toolName: CollabToolName,
    args: Record<string, unknown>,
    toolCallId: string
  ) => Promise<{ ok: boolean; output: string; isError?: boolean }>
  historyMessages: RoomMessage[]
  abortSignal: AbortSignal
  emit: (event: TurnStreamEvent) => void
  onSessionUpdate: (
    patch: Partial<Pick<SessionRecord, 'daemonSessionId' | 'nativeSessionId' | 'configHash' | 'lastConsumedOffset'>>
  ) => void
}

export interface TurnOutput {
  finalText: string
  usage?: TurnUsage
  nativeSessionId?: string
}

export interface AgentDriver {
  readonly kind: DriverKind
  readonly capabilities: DriverCapabilities
  runTurn(input: TurnInput): Promise<TurnOutput>
  disposeSession?(session: SessionRecord): Promise<void>
}
