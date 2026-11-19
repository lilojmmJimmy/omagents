import { z } from 'zod'
import type { TurnUsage } from './room'

export const RPC_ERROR_CODES = {
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  METHOD_NOT_FOUND: -32601,
  NOT_FOUND: -32001,
  CONFLICT: -32002,
  GUARDRAIL_EXCEEDED: -32003,
  CAPACITY_OR_LOCK_BUSY: -32004,
  PATH_OUT_OF_BOUNDS: -32005,
  DRIVER_ERROR: -32006,
  RECONCILING: -32007,
  UNAUTHORIZED: -32010,
  FORBIDDEN: -32011
} as const

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional()
})
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: number
    message: string
    data?: { reason?: string; details?: unknown }
  }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

export interface FileEntry {
  name: string
  path: string // relative posix path within workspace
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

export interface GitStatusInfo {
  isGit: boolean
  branch: string | null
  files: Array<{
    path: string
    status: string
    staged: boolean
  }>
}

export interface GitDiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
  patch: string
}

export interface StreamDeltaNotification {
  roomId: string
  workNodeId: string
  attempt: number
  eventSeq: number
  memberId: string
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
