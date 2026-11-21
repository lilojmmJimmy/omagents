import { randomUUID } from 'node:crypto'
import type { ModelProvider, ModelProviderSaveInput, SecretProvider } from '@myagents/protocol'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'

interface ProviderRow {
  id: string
  name: string
  kind: ModelProvider['kind']
  base_url: string
  api_key_ref: string | null
  default_model: string
  models_json: string
  extra_json: string
  created_at: number
  updated_at: number
}

function mapProvider(row: ProviderRow): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKeyRef: null, // Never leak secret reference over RPC
    hasApiKey: Boolean(row.api_key_ref),
    defaultModel: row.default_model,
    models: JSON.parse(row.models_json || '[]') as string[],
    extra: JSON.parse(row.extra_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProviderService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly secrets: SecretProvider
  ) {}

  list(): ModelProvider[] {
    const rows = this.database.db
      .prepare('SELECT * FROM model_providers ORDER BY created_at DESC')
      .all() as unknown as ProviderRow[]
    return rows.map(mapProvider)
  }

  get(id: string): ModelProvider {
    const row = this.database.db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as unknown as
      | ProviderRow
      | undefined
    if (!row) throw Errors.notFound(`Model provider not found: ${id}`)
    return mapProvider(row)
  }

  async resolveCredentials(id: string): Promise<{ provider: ModelProvider; apiKey: string | null }> {
    const row = this.database.db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as unknown as
      | ProviderRow
      | undefined
    if (!row) throw Errors.notFound(`Model provider not found: ${id}`)
    const apiKey = row.api_key_ref ? await this.secrets.resolve(row.api_key_ref) : null
    return { provider: mapProvider(row), apiKey }
  }

  save(input: ModelProviderSaveInput): ModelProvider {
    const now = Date.now()
    const models = input.models.length > 0 ? input.models : [input.defaultModel]
    const cleanUrl = input.baseUrl.replace(/\/+$/, '')

    if (input.id) {
      const existing = this.database.db
        .prepare('SELECT * FROM model_providers WHERE id = ?')
        .get(input.id) as unknown as ProviderRow | undefined
      if (!existing) throw Errors.notFound(`Model provider not found: ${input.id}`)
      const nextKey = input.apiKey === undefined ? existing.api_key_ref : input.apiKey.trim() || null
      this.database.db
        .prepare(
          `UPDATE model_providers
           SET name = ?, kind = ?, base_url = ?, api_key_ref = ?, default_model = ?, models_json = ?, extra_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.kind,
          cleanUrl,
          nextKey,
          input.defaultModel,
          JSON.stringify(models),
          JSON.stringify(input.extra ?? {}),
          now,
          input.id
        )
      return this.get(input.id)
    }

    const id = randomUUID()
    this.database.db
      .prepare(
        `INSERT INTO model_providers (id, name, kind, base_url, api_key_ref, default_model, models_json, extra_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.kind,
        cleanUrl,
        input.apiKey?.trim() || null,
        input.defaultModel,
        JSON.stringify(models),
        JSON.stringify(input.extra ?? {}),
        now,
        now
      )
    return this.get(id)
  }

  delete(id: string): void {
    const info = this.database.db.prepare('DELETE FROM model_providers WHERE id = ?').run(id)
    if (info.changes === 0) throw Errors.notFound(`Model provider not found: ${id}`)
  }

  async probe(id: string): Promise<{ ok: boolean; latencyMs: number; models?: string[]; error?: string }> {
    const { provider, apiKey } = await this.resolveCredentials(id)
    const start = Date.now()
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const res = await fetch(url, { headers, signal: controller.signal })
      const latencyMs = Date.now() - start
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300)
        return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text}` }
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      const models = Array.isArray(data?.data)
        ? data.data
            .map((m) => m.id)
            .filter((m): m is string => typeof m === 'string')
            .slice(0, 100)
        : undefined
      return { ok: true, latencyMs, models }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }
}
