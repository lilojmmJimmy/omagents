import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const DriverKind = z.enum(['builtin', 'claude', 'acp', 'codex', 'custom'])
export type DriverKind = z.infer<typeof DriverKind>

export const PermissionMode = z.enum(['read-only', 'workspace-write', 'full'])
export type PermissionMode = z.infer<typeof PermissionMode>

export const IsolationMode = z.enum(['standard', 'isolated-home', 'lockdown'])
export type IsolationMode = z.infer<typeof IsolationMode>

export const WorkspaceKind = z.enum(['agent_private', 'project', 'git_worktree', 'shared'])
export type WorkspaceKind = z.infer<typeof WorkspaceKind>

export const WorkspaceMode = z.enum(['read-only', 'shared-rw', 'worktree'])
export type WorkspaceMode = z.infer<typeof WorkspaceMode>

export const ModelProviderKind = z.enum(['openai-compat', 'anthropic', 'ollama', 'custom'])
export type ModelProviderKind = z.infer<typeof ModelProviderKind>

export const ModelProviderSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  kind: ModelProviderKind,
  baseUrl: z.string().url(),
  apiKeyRef: z.string().nullable(),
  hasApiKey: z.boolean().optional(),
  defaultModel: z.string().min(1).max(200),
  models: z.array(z.string().min(1).max(200)),
  extra: z.record(z.unknown()).default({}),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type ModelProvider = z.infer<typeof ModelProviderSchema>

export const ModelProviderSaveInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  kind: ModelProviderKind.default('openai-compat'),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().optional(), // undefined = keep existing on update; empty string = clear
  defaultModel: z.string().trim().min(1).max(200),
  models: z.array(z.string().trim().min(1).max(200)).default([]),
  extra: z.record(z.unknown()).optional()
})
export type ModelProviderSaveInput = z.infer<typeof ModelProviderSaveInput>

export const WorkspaceSchema = z.object({
  id: z.string(),
  kind: WorkspaceKind,
  name: z.string(),
  rootPath: z.string(),
  isGit: z.boolean(),
  gitCommonDir: z.string().nullable(),
  gitBranch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  parentWorkspaceId: z.string().nullable(),
  ownerType: z.enum(['agent', 'room', 'work_node', 'global']),
  ownerId: z.string().nullable(),
  readonlyRefs: z.array(z.string()),
  cleanedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const AgentDriverConfigSchema = z
  .object({
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
    cliPath: z.string().optional(),
    effort: z.string().optional(),
    dialect: z.string().optional()
  })
  .passthrough()
export type AgentDriverConfig = z.infer<typeof AgentDriverConfigSchema>

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  bio: z.string(),
  avatar: z.record(z.unknown()),
  systemPrompt: z.string(),
  driverKind: DriverKind,
  providerId: z.string().nullable(),
  driverConfig: AgentDriverConfigSchema,
  defaultWorkspaceId: z.string(),
  defaultWorkspacePath: z.string().optional(),
  permissionMode: PermissionMode,
  isolationMode: IsolationMode,
  skillIds: z.array(z.string()),
  mcpServerIds: z.array(z.string()),
  maxRunningTurns: z.number().int().min(1),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Agent = z.infer<typeof AgentSchema>

export const AgentCreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  bio: z.string().trim().max(500).default(''),
  systemPrompt: z.string().max(50_000).default(''),
  driverKind: DriverKind,
  providerId: z.string().nullable().optional(),
  driverConfig: AgentDriverConfigSchema.default({}),
  permissionMode: PermissionMode.default('workspace-write'),
  isolationMode: IsolationMode.default('standard'),
  skillIds: z.array(z.string()).default([]),
  mcpServerIds: z.array(z.string()).default([]),
  maxRunningTurns: z.number().int().min(1).max(20).optional()
})
export type AgentCreateInput = z.infer<typeof AgentCreateInput>

export const AgentUpdateInput = AgentCreateInput.partial()
export type AgentUpdateInput = z.infer<typeof AgentUpdateInput>

export const DriverCapabilitiesSchema = z.object({
  supportsNativeResume: z.boolean(),
  supportsSteerWhileRunning: z.boolean(),
  supportsReadOnlyEnforcement: z.boolean(),
  supportsDynamicMcp: z.boolean(),
  supportsSubagentBlock: z.boolean()
})
export type DriverCapabilities = z.infer<typeof DriverCapabilitiesSchema>

export const AgentDescriptorSchema = z.object({
  kind: DriverKind,
  label: z.string(),
  description: z.string(),
  requiresProvider: z.boolean(),
  requiresExternalCli: z.boolean(),
  enabledInV1: z.boolean(),
  capabilities: DriverCapabilitiesSchema
})
export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>

export const AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    kind: 'builtin',
    label: 'Builtin Lightweight Agent',
    description:
      'In-process lightweight ReAct agent connecting directly to OpenAI-compatible model providers with workspace file and command tools.',
    requiresProvider: true,
    requiresExternalCli: false,
    enabledInV1: true,
    capabilities: {
      supportsNativeResume: false,
      supportsSteerWhileRunning: false,
      supportsReadOnlyEnforcement: true,
      supportsDynamicMcp: true,
      supportsSubagentBlock: true
    }
  },
  {
    kind: 'claude',
    label: 'Claude Code CLI',
    description:
      'Managed local Claude Code CLI (stream-json) supporting long-running coding sessions, native resume, and hot-restart handoff.',
    requiresProvider: false,
    requiresExternalCli: true,
    enabledInV1: true,
    capabilities: {
      supportsNativeResume: true,
      supportsSteerWhileRunning: false,
      supportsReadOnlyEnforcement: true,
      supportsDynamicMcp: true,
      supportsSubagentBlock: true
    }
  },
  {
    kind: 'codex',
    label: 'Codex CLI',
    description:
      'Managed local Codex CLI (codex exec --json) supporting sandbox controls, native resume, dynamic MCP, and NDJSON event streaming.',
    requiresProvider: false,
    requiresExternalCli: true,
    enabledInV1: true,
    capabilities: {
      supportsNativeResume: true,
      supportsSteerWhileRunning: false,
      supportsReadOnlyEnforcement: true,
      supportsDynamicMcp: true,
      supportsSubagentBlock: true
    }
  },
  {
    kind: 'acp',
    label: 'Gemini / ACP CLI',
    description: 'Managed local Gemini CLI or external ACP/stream-json compatible coding agent CLI.',
    requiresProvider: false,
    requiresExternalCli: true,
    enabledInV1: true,
    capabilities: {
      supportsNativeResume: false,
      supportsSteerWhileRunning: false,
      supportsReadOnlyEnforcement: true,
      supportsDynamicMcp: false,
      supportsSubagentBlock: true
    }
  }
]
