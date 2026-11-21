import { z } from 'zod'

export const McpTransport = z.enum(['stdio', 'http'])
export type McpTransport = z.infer<typeof McpTransport>

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransport,
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  envKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type McpServer = z.infer<typeof McpServerSchema>

export const McpServerSaveInput = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().regex(MCP_SERVER_NAME_RE, 'Server name must be 1-64 characters of letters, digits, _ or -'),
    transport: McpTransport,
    command: z.string().trim().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().trim().optional(),
    envRefs: z.record(z.string()).optional(),
    headerRefs: z.record(z.string()).optional(),
    enabled: z.boolean().optional()
  })
  .superRefine((val, ctx) => {
    if (val.name.toLowerCase() === 'myagents') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Server name "myagents" is reserved'
      })
    }
    if (val.transport === 'stdio' && !val.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'Command is required for stdio MCP servers'
      })
    }
    if (val.transport === 'http') {
      const rawUrl = val.url?.trim() ?? ''
      let valid = false
      try {
        const parsed = new URL(rawUrl)
        valid = parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        valid = false
      }
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'A valid http:// or https:// URL is required for HTTP MCP servers'
        })
      }
    }
  })
export type McpServerSaveInput = z.infer<typeof McpServerSaveInput>

export const McpProbeResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional()
    })
  ),
  error: z.string().optional()
})
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>

export const SkillSourceType = z.enum(['local', 'git'])
export type SkillSourceType = z.infer<typeof SkillSourceType>

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceType: SkillSourceType,
  sourceUri: z.string(),
  pinnedCommit: z.string().nullable(),
  localPath: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Skill = z.infer<typeof SkillSchema>

export const SkillInstallInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sourceType: SkillSourceType,
  sourceUri: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
  description: z.string().trim().max(1000).optional()
})
export type SkillInstallInput = z.infer<typeof SkillInstallInput>

export const BackgroundJobType = z.enum(['sync_source', 'backup_snapshot', 'routine_tick'])
export type BackgroundJobType = z.infer<typeof BackgroundJobType>

export const BackgroundJobStatus = z.enum(['pending', 'running', 'completed', 'failed'])
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatus>

export const BackgroundJobSchema = z.object({
  id: z.string(),
  jobType: BackgroundJobType,
  payload: z.record(z.unknown()),
  status: BackgroundJobStatus,
  runAfter: z.number(),
  retryCount: z.number().int().nonnegative(),
  idempotencyKey: z.string().nullable(),
  errorText: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>

export const BackgroundJobEnqueueInput = z.object({
  jobType: BackgroundJobType,
  payload: z.record(z.unknown()).default({}),
  runAfter: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
})
export type BackgroundJobEnqueueInput = z.infer<typeof BackgroundJobEnqueueInput>

export const ScheduledJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  jobType: BackgroundJobType,
  cronExpr: z.string(),
  payload: z.record(z.unknown()),
  enabled: z.boolean(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastJobId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>

export const ScheduledJobSaveInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  jobType: BackgroundJobType,
  cronExpr: z.string().trim().min(1).max(100),
  payload: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional()
})
export type ScheduledJobSaveInput = z.infer<typeof ScheduledJobSaveInput>
