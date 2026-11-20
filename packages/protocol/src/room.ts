import { z } from 'zod'
import { WorkspaceMode } from './models'

export const RoomState = z.enum(['active', 'running', 'pausing', 'paused', 'done'])
export type RoomState = z.infer<typeof RoomState>

export const RoomMemberRole = z.enum(['lead', 'chair', 'member'])
export type RoomMemberRole = z.infer<typeof RoomMemberRole>

export const RoomMemberSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  driverKind: z.string().optional(),
  displayName: z.string(),
  roleKind: RoomMemberRole,
  rolePrompt: z.string(),
  position: z.number().int().nonnegative(),
  joinedAt: z.number(),
  removedAt: z.number().nullable(),
  nativeSessionId: z.string().nullable().optional(),
  sessionFilePath: z.string().nullable().optional()
})
export type RoomMember = z.infer<typeof RoomMemberSchema>

export const SharedMemorySchema = z.object({
  id: z.string(),
  text: z.string(),
  authorId: z.string(),
  updatedAt: z.number()
})
export type SharedMemory = z.infer<typeof SharedMemorySchema>

export const RoomSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  strategyId: z.string(),
  strategyConfig: z.record(z.unknown()),
  strategyState: z.record(z.unknown()),
  state: RoomState,
  primaryWorkspaceId: z.string().nullable(),
  lastSeq: z.number().int().nonnegative(),
  pinnedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  members: z.array(RoomMemberSchema),
  activeNodeCount: z.number().int().nonnegative().optional(),
  hasFailedNode: z.boolean().optional()
})
export type RoomSummary = z.infer<typeof RoomSummarySchema>

export const RoomDetailSchema = RoomSummarySchema.extend({
  sharedMemories: z.array(SharedMemorySchema),
  summaryText: z.string().nullable(),
  summaryUptoSeq: z.number().int().nonnegative()
})
export type RoomDetail = z.infer<typeof RoomDetailSchema>

export const MessageAuthorKind = z.enum(['human', 'agent', 'system', 'intake'])
export type MessageAuthorKind = z.infer<typeof MessageAuthorKind>

export const MessageKind = z.enum([
  'chat',
  'result',
  'reply',
  'summary',
  'routing_notice',
  'system_notice',
  'intake_seed'
])
export type MessageKind = z.infer<typeof MessageKind>

export const VisibilityScope = z.enum(['public', 'private'])
export type VisibilityScope = z.infer<typeof VisibilityScope>

export const FileRefSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative()
})
export type FileRef = z.infer<typeof FileRefSchema>

export const RoomMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  seq: z.number().int().positive(),
  visibleSeq: z.number().int().nonnegative(),
  authorKind: MessageAuthorKind,
  authorId: z.string(),
  authorName: z.string(),
  kind: MessageKind,
  content: z.string(),
  attachments: z.array(FileRefSchema),
  replyToMsgId: z.string().nullable(),
  workNodeId: z.string().nullable(),
  visibilityScope: VisibilityScope,
  visibleTo: z.array(z.string()),
  meta: z.record(z.unknown()),
  createdAt: z.number()
})
export type RoomMessage = z.infer<typeof RoomMessageSchema>

export const WorkNodeKind = z.enum([
  'turn',
  'delegation',
  'subtask',
  'transfer',
  'member_reply',
  'routing',
  'round_post',
  'summary'
])
export type WorkNodeKind = z.infer<typeof WorkNodeKind>

export const WorkNodeStatus = z.enum([
  'queued',
  'waiting_deps',
  'waiting_lock',
  'starting',
  'running',
  'waiting_children',
  'awaiting_human',
  'paused',
  'completed',
  'failed',
  'cancelled'
])
export type WorkNodeStatus = z.infer<typeof WorkNodeStatus>

export const SETTLED_NODE_STATUSES: ReadonlySet<WorkNodeStatus> = new Set([
  'completed',
  'failed',
  'cancelled'
])

export const LOCK_HOLDING_STATUSES: ReadonlySet<WorkNodeStatus> = new Set([
  'starting',
  'running'
])

export const WorkNodeControlAction = z.enum(['stop', 'continue', 'cancel', 'retry', 'reassign'])
export type WorkNodeControlAction = z.infer<typeof WorkNodeControlAction>

export const TurnUsageSchema = z.object({
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  thinkingTokens: z.number().optional(),
  contextUsedTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  ttftMs: z.number().optional(),
  tokensPerSec: z.number().optional(),
  numTurns: z.number().optional()
})
export type TurnUsage = z.infer<typeof TurnUsageSchema>

export const WorkNodeSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  rootNodeId: z.string(),
  parentNodeId: z.string().nullable(),
  supersedesNodeId: z.string().nullable(),
  transferredToNodeId: z.string().nullable(),
  requestMsgId: z.string().nullable(),
  assigneeMemberId: z.string(),
  assigneeAgentId: z.string(),
  kind: WorkNodeKind,
  status: WorkNodeStatus,
  blockingReason: z.string().nullable().optional(),
  superstep: z.number().int().nullable(),
  instruction: z.string(),
  expectedResult: z.string().nullable(),
  workspaceMode: WorkspaceMode,
  workspaceId: z.string().nullable(),
  resources: z.array(z.string()),
  resultText: z.string().nullable(),
  resultJson: z.record(z.unknown()).nullable(),
  usage: TurnUsageSchema.nullable(),
  errorText: z.string().nullable(),
  attempt: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  updatedAt: z.number()
})
export type WorkNode = z.infer<typeof WorkNodeSchema>

export const NodeEventKind = z.enum(['thinking', 'tool_start', 'tool_result', 'notice', 'error'])
export type NodeEventKind = z.infer<typeof NodeEventKind>

export const NodeEventSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  attempt: z.number().int().positive(),
  seq: z.number().int().positive(),
  kind: NodeEventKind,
  payload: z.record(z.unknown()),
  createdAt: z.number()
})
export type NodeEvent = z.infer<typeof NodeEventSchema>

export const AgentSessionStatus = z.enum([
  'cold',
  'starting',
  'ready',
  'busy',
  'hibernated',
  'detached',
  'crashed'
])
export type AgentSessionStatus = z.infer<typeof AgentSessionStatus>

export const TerminalSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  daemonSessionId: z.string(),
  title: z.string(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type TerminalSession = z.infer<typeof TerminalSessionSchema>

export function pickLatestRetryableNode(nodes: readonly WorkNode[]): WorkNode | undefined {
  if (nodes.length === 0) return undefined
  const supersededIds = new Set(
    nodes.map((n) => n.supersedesNodeId).filter((id): id is string => Boolean(id))
  )
  const sorted = [...nodes].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt))
  const anchor = sorted[0]!
  const latestBatch = sorted.filter(
    (n) =>
      !supersededIds.has(n.id) &&
      (n.rootNodeId === anchor.rootNodeId ||
        (anchor.requestMsgId !== null && n.requestMsgId === anchor.requestMsgId) ||
        (anchor.superstep !== null && n.superstep === anchor.superstep))
  )
  return latestBatch.find((n) => n.status === 'failed' || n.status === 'paused')
}
