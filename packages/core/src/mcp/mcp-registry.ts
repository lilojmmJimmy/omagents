import { randomUUID } from 'node:crypto'
import type { McpProbeResult, McpServer, McpServerSaveInput, Redactor, SecretProvider } from '@myagents/protocol'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import { McpClient, type ResolvedExternalMcpServer } from './mcp-client'

interface McpServerRow {
  id: string
  name: string
  transport: McpServer['transport']
  command: string | null
  args_json: string
  url: string | null
  env_refs_json: string
  header_refs_json: string
  enabled: number
  created_at: number
  updated_at: number
}

function parseStringRecord(raw: string | null | undefined): Record<string, string> {
  try {
    const obj = JSON.parse(raw || '{}') as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function mapServer(row: McpServerRow): McpServer {
  const envRefs = parseStringRecord(row.env_refs_json)
  const headerRefs = parseStringRecord(row.header_refs_json)
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: JSON.parse(row.args_json || '[]') as string[],
    url: row.url,
    envKeys: Object.keys(envRefs),
    headerKeys: Object.keys(headerRefs),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class McpRegistryService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly secrets: SecretProvider,
    private readonly redactor?: Redactor
  ) {}

  list(): McpServer[] {
    const rows = this.database.db
      .prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC')
      .all() as unknown as McpServerRow[]
    return rows.map(mapServer)
  }

  get(id: string): McpServer {
    const row = this.database.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as
      | McpServerRow
      | undefined
    if (!row) throw Errors.notFound(`MCP server not found: ${id}`)
    return mapServer(row)
  }

  save(input: McpServerSaveInput): McpServer {
    if (input.name.toLowerCase() === 'myagents') {
      throw Errors.invalidParams('Server name "myagents" is reserved')
    }
    const now = Date.now()
    const cleanArgs = input.args.map((a) => String(a))
    const command = input.transport === 'stdio' ? input.command?.trim() || null : null
    const url = input.transport === 'http' ? input.url?.trim() || null : null

    if (input.id) {
      const existing = this.database.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(input.id) as unknown as
        | McpServerRow
        | undefined
      if (!existing) throw Errors.notFound(`MCP server not found: ${input.id}`)

      const dup = this.database.db
        .prepare('SELECT id FROM mcp_servers WHERE LOWER(name) = LOWER(?) AND id != ?')
        .get(input.name, input.id)
      if (dup) throw Errors.conflict('name_taken', `MCP server name already exists: ${input.name}`)

      const nextEnvRefs = input.envRefs === undefined ? existing.env_refs_json : JSON.stringify(input.envRefs)
      const nextHeaderRefs =
        input.headerRefs === undefined ? existing.header_refs_json : JSON.stringify(input.headerRefs)
      const nextEnabled = input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0

      this.database.db
        .prepare(
          `UPDATE mcp_servers
           SET name = ?, transport = ?, command = ?, args_json = ?, url = ?,
               env_refs_json = ?, header_refs_json = ?, enabled = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.transport,
          command,
          JSON.stringify(cleanArgs),
          url,
          nextEnvRefs,
          nextHeaderRefs,
          nextEnabled,
          now,
          input.id
        )
      return this.get(input.id)
    }

    const dup = this.database.db.prepare('SELECT id FROM mcp_servers WHERE LOWER(name) = LOWER(?)').get(input.name)
    if (dup) throw Errors.conflict('name_taken', `MCP server name already exists: ${input.name}`)

    const id = randomUUID()
    this.database.db
      .prepare(
        `INSERT INTO mcp_servers (
           id, name, transport, command, args_json, url, env_refs_json, header_refs_json, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.transport,
        command,
        JSON.stringify(cleanArgs),
        url,
        JSON.stringify(input.envRefs ?? {}),
        JSON.stringify(input.headerRefs ?? {}),
        input.enabled === false ? 0 : 1,
        now,
        now
      )
    return this.get(id)
  }

  delete(id: string): void {
    this.database.transaction(() => {
      const info = this.database.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
      if (info.changes === 0) throw Errors.notFound(`MCP server not found: ${id}`)

      const agentRows = this.database.db.prepare('SELECT id, mcp_server_ids_json FROM agents').all() as Array<{
        id: string
        mcp_server_ids_json: string
      }>
      const now = Date.now()
      for (const agent of agentRows) {
        const ids = JSON.parse(agent.mcp_server_ids_json || '[]') as string[]
        if (ids.includes(id)) {
          const next = ids.filter((x) => x !== id)
          this.database.db
            .prepare('UPDATE agents SET mcp_server_ids_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(next), now, agent.id)
        }
      }
    })
  }

  async probe(id: string): Promise<McpProbeResult> {
    const row = this.database.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as
      | McpServerRow
      | undefined
    if (!row) throw Errors.notFound(`MCP server not found: ${id}`)

    const resolved = await this.resolveRow(row)
    const client = new McpClient(resolved)
    const start = Date.now()
    try {
      await client.connect(12_000)
      const tools = await client.listTools(12_000)
      return {
        ok: true,
        latencyMs: Date.now() - start,
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {})
        }))
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        tools: [],
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      await client.close()
    }
  }

  async resolveForAgent(mcpServerIds: readonly string[]): Promise<ResolvedExternalMcpServer[]> {
    const uniqueIds = [...new Set(mcpServerIds.map((id) => id.trim()).filter(Boolean))]
    if (uniqueIds.length === 0) return []

    const resolved: ResolvedExternalMcpServer[] = []
    for (const id of uniqueIds) {
      const row = this.database.db
        .prepare('SELECT * FROM mcp_servers WHERE id = ? AND enabled = 1')
        .get(id) as unknown as McpServerRow | undefined
      if (!row || row.name.toLowerCase() === 'myagents') continue
      resolved.push(await this.resolveRow(row))
    }
    return resolved
  }

  private async resolveRow(row: McpServerRow): Promise<ResolvedExternalMcpServer> {
    const envRefs = parseStringRecord(row.env_refs_json)
    const headerRefs = parseStringRecord(row.header_refs_json)
    const env = await this.resolveMap(envRefs)
    const headers = await this.resolveMap(headerRefs)

    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      ...(row.transport === 'stdio'
        ? {
            command: row.command ?? undefined,
            args: JSON.parse(row.args_json || '[]') as string[],
            ...(Object.keys(env).length > 0 ? { env } : {})
          }
        : {
            url: row.url ?? undefined,
            ...(Object.keys(headers).length > 0 ? { headers } : {})
          })
    }
  }

  private async resolveMap(refs: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const [key, ref] of Object.entries(refs)) {
      const val = await this.secrets.resolve(ref)
      if (val !== null) {
        out[key] = val
        this.redactor?.registerSecret(val)
      }
    }
    return out
  }
}
