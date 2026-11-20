import { z } from 'zod'

export const UsageWindowSchema = z.enum(['24h', '7d', '30d', 'all'])
export type UsageWindow = z.infer<typeof UsageWindowSchema>

export const UsageAnalyticsQuerySchema = z.object({
  window: UsageWindowSchema.default('7d'),
  agentId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
  model: z.string().min(1).optional()
})
export type UsageAnalyticsQuery = z.infer<typeof UsageAnalyticsQuerySchema>

export const UsageBucketSchema = z.object({
  runs: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  thinkingTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  avgDurationMs: z.number().nonnegative(),
  avgTtftMs: z.number().nonnegative()
})
export type UsageBucket = z.infer<typeof UsageBucketSchema>

export const UsageTimeBucketSchema = UsageBucketSchema.extend({
  bucket: z.string()
})
export type UsageTimeBucket = z.infer<typeof UsageTimeBucketSchema>

export const UsageByAgentSchema = UsageBucketSchema.extend({
  agentId: z.string(),
  agentName: z.string(),
  driverKind: z.string()
})
export type UsageByAgent = z.infer<typeof UsageByAgentSchema>

export const UsageByModelSchema = UsageBucketSchema.extend({
  model: z.string()
})
export type UsageByModel = z.infer<typeof UsageByModelSchema>

export const UsageByRoomSchema = UsageBucketSchema.extend({
  roomId: z.string(),
  roomTitle: z.string(),
  strategyId: z.string()
})
export type UsageByRoom = z.infer<typeof UsageByRoomSchema>

export const UsageRecentRunSchema = z.object({
  nodeId: z.string(),
  roomId: z.string(),
  roomTitle: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  model: z.string(),
  status: z.string(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  thinkingTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  createdAt: z.number()
})
export type UsageRecentRun = z.infer<typeof UsageRecentRunSchema>

export const UsageAnalyticsReportSchema = z.object({
  window: UsageWindowSchema,
  sinceMs: z.number().nullable(),
  generatedAt: z.number(),
  totals: UsageBucketSchema,
  byDay: z.array(UsageTimeBucketSchema),
  byAgent: z.array(UsageByAgentSchema),
  byModel: z.array(UsageByModelSchema),
  byRoom: z.array(UsageByRoomSchema),
  recentRuns: z.array(UsageRecentRunSchema)
})
export type UsageAnalyticsReport = z.infer<typeof UsageAnalyticsReportSchema>
