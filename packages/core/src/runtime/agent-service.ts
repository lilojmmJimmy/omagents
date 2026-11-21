import { randomUUID } from 'node:crypto'
import type { Agent, AgentCreateInput, AgentUpdateInput } from '@myagents/protocol'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import type { WorkspaceService } from '../workspace/workspace-service'

interface AgentRow {
  id: string
  name: string
  bio: string
  avatar_json: string
  system_prompt: string
  driver_kind: Agent['driverKind']
  provider_id: string | null
  driver_config_json: string
  default_workspace_id: string
  workspace_root_path?: string
  permission_mode: Agent['permissionMode']
  isolation_mode: Agent['isolationMode']
  skill_ids_json: string
  mcp_server_ids_json: string
  max_running_turns: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    avatar: JSON.parse(row.avatar_json || '{}') as Record<string, unknown>,
    systemPrompt: row.system_prompt,
    driverKind: row.driver_kind,
    providerId: row.provider_id,
    driverConfig: JSON.parse(row.driver_config_json || '{}') as Agent['driverConfig'],
    defaultWorkspaceId: row.default_workspace_id,
    defaultWorkspacePath: row.workspace_root_path,
    permissionMode: row.permission_mode,
    isolationMode: row.isolation_mode,
    skillIds: JSON.parse(row.skill_ids_json || '[]') as string[],
    mcpServerIds: JSON.parse(row.mcp_server_ids_json || '[]') as string[],
    maxRunningTurns: row.max_running_turns,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class AgentService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly workspaces: WorkspaceService
  ) {}

  list(includeArchived = false): Agent[] {
    const sql = includeArchived
      ? `SELECT a.*, w.root_path AS workspace_root_path FROM agents a JOIN workspaces w ON w.id = a.default_workspace_id ORDER BY a.created_at DESC`
      : `SELECT a.*, w.root_path AS workspace_root_path FROM agents a JOIN workspaces w ON w.id = a.default_workspace_id WHERE a.archived_at IS NULL ORDER BY a.created_at DESC`
    const rows = this.database.db.prepare(sql).all() as unknown as AgentRow[]
    return rows.map(mapAgent)
  }

  get(id: string): Agent {
    const row = this.database.db
      .prepare(
        `SELECT a.*, w.root_path AS workspace_root_path FROM agents a JOIN workspaces w ON w.id = a.default_workspace_id WHERE a.id = ?`
      )
      .get(id) as unknown as AgentRow | undefined
    if (!row) throw Errors.notFound(`Agent not found: ${id}`)
    return mapAgent(row)
  }

  create(input: AgentCreateInput): Agent {
    if (input.driverKind === 'builtin' && !input.providerId) {
      throw Errors.invalidParams('Builtin agent requires a model provider')
    }
    const existing = this.database.db.prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE').get(input.name)
    if (existing) throw Errors.conflict('name_taken', `Agent name already exists: ${input.name}`)

    const id = randomUUID()
    const now = Date.now()
    const maxTurns = input.maxRunningTurns ?? (input.driverKind === 'builtin' ? 5 : 2)

    this.database.transaction(() => {
      const ws = this.workspaces.createAgentPrivateWorkspace(id, input.name)
      this.database.db
        .prepare(
          `INSERT INTO agents (
             id, name, bio, avatar_json, system_prompt, driver_kind, provider_id, driver_config_json,
             default_workspace_id, permission_mode, isolation_mode, skill_ids_json, mcp_server_ids_json,
             max_running_turns, created_at, updated_at
           ) VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name,
          input.bio,
          input.systemPrompt,
          input.driverKind,
          input.providerId ?? null,
          JSON.stringify(input.driverConfig ?? {}),
          ws.id,
          input.permissionMode,
          input.isolationMode,
          JSON.stringify(input.skillIds ?? []),
          JSON.stringify(input.mcpServerIds ?? []),
          maxTurns,
          now,
          now
        )
    })

    return this.get(id)
  }

  update(id: string, patch: AgentUpdateInput): Agent {
    const current = this.get(id)
    const nextName = patch.name?.trim() || current.name
    if (nextName.toLowerCase() !== current.name.toLowerCase()) {
      const dup = this.database.db
        .prepare('SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?')
        .get(nextName, id)
      if (dup) throw Errors.conflict('name_taken', `Agent name already exists: ${nextName}`)
    }
    const nextDriver = patch.driverKind ?? current.driverKind
    const nextProviderId = patch.providerId === undefined ? current.providerId : patch.providerId
    if (nextDriver === 'builtin' && !nextProviderId) {
      throw Errors.invalidParams('Builtin agent requires a model provider')
    }

    this.database.db
      .prepare(
        `UPDATE agents
         SET name = ?, bio = ?, system_prompt = ?, driver_kind = ?, provider_id = ?, driver_config_json = ?,
             permission_mode = ?, isolation_mode = ?, skill_ids_json = ?, mcp_server_ids_json = ?,
             max_running_turns = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextName,
        patch.bio ?? current.bio,
        patch.systemPrompt ?? current.systemPrompt,
        nextDriver,
        nextProviderId,
        JSON.stringify(patch.driverConfig ?? current.driverConfig),
        patch.permissionMode ?? current.permissionMode,
        patch.isolationMode ?? current.isolationMode,
        JSON.stringify(patch.skillIds ?? current.skillIds),
        JSON.stringify(patch.mcpServerIds ?? current.mcpServerIds),
        patch.maxRunningTurns ?? current.maxRunningTurns,
        Date.now(),
        id
      )
    return this.get(id)
  }

  archive(id: string, archived: boolean): Agent {
    this.get(id)
    this.database.db
      .prepare('UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? Date.now() : null, Date.now(), id)
    return this.get(id)
  }
}
