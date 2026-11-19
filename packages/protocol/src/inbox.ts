import { z } from 'zod'
import { FileRefSchema } from './room'

export const InboxStatus = z.enum(['new', 'in_progress', 'resolved', 'ignored'])
export type InboxStatus = z.infer<typeof InboxStatus>

export const RoutingMatchType = z.enum(['keyword', 'regex', 'meta_equals', 'always'])
export type RoutingMatchType = z.infer<typeof RoutingMatchType>

export const RoutingRuleActionSchema = z.object({
  mode: z.enum(['create_room', 'append_room']).default('create_room'),
  targetRoomId: z.string().optional(),
  strategyId: z.string().optional(),
  strategyConfig: z.record(z.unknown()).optional(),
  agentIds: z.array(z.string()).optional(),
  workspaceId: z.string().nullable().optional(),
  promptPrefix: z.string().optional()
})
export type RoutingRuleAction = z.infer<typeof RoutingRuleActionSchema>

export const WebhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  createdAt: z.number()
})
export type WebhookConfig = z.infer<typeof WebhookSchema>

export const RoutingRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  sourceFilter: z.string().nullable(),
  matchType: RoutingMatchType,
  matchExpr: z.string(),
  allowWrite: z.boolean(),
  action: RoutingRuleActionSchema,
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type RoutingRule = z.infer<typeof RoutingRuleSchema>

export const RoutingRuleSaveInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  priority: z.number().int().min(1).max(10_000).default(100),
  sourceFilter: z.string().trim().nullable().optional(),
  matchType: RoutingMatchType.default('always'),
  matchExpr: z.string().default(''),
  allowWrite: z.boolean().default(false),
  action: RoutingRuleActionSchema,
  enabled: z.boolean().default(true)
})
export type RoutingRuleSaveInput = z.infer<typeof RoutingRuleSaveInput>

export const InboxItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourceInstanceId: z.string(),
  externalKey: z.string(),
  externalUrl: z.string().nullable(),
  authorName: z.string(),
  title: z.string(),
  content: z.string(),
  attachments: z.array(FileRefSchema),
  status: InboxStatus,
  assignedRoomId: z.string().nullable(),
  assignedRootNodeId: z.string().nullable(),
  matchedRuleId: z.string().nullable(),
  replyTarget: z.record(z.unknown()).nullable(),
  rawMeta: z.record(z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const PluginDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  supportsPull: z.boolean(),
  supportsWebhook: z.boolean(),
  supportsReply: z.boolean()
})
export type PluginDescriptor = z.infer<typeof PluginDescriptorSchema>

export const PluginInstanceSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  name: z.string(),
  config: z.record(z.unknown()),
  cursor: z.string().nullable(),
  enabled: z.boolean(),
  lastSyncAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type PluginInstance = z.infer<typeof PluginInstanceSchema>

export interface MessagesRevealedNotification {
  roomId: string
  messageIds: string[]
  visibleSeq: number
}
