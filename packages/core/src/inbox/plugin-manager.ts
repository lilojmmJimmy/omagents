import { randomUUID } from 'node:crypto'
import type { FileRef, PluginDescriptor, PluginInstance, Redactor, SecretProvider } from '@myagents/protocol'
import type { InboundEnvelope, PluginContext, SourcePlugin } from '@myagents/plugin-sdk'
import { z } from 'zod'
import { Errors } from '../errors'
import type { BlobService } from '../storage/blob-service'
import type { CoreDatabase } from '../storage/database'
import { emailPlugin } from './plugins/email-plugin'
import { githubPlugin } from './plugins/github-plugin'

const SECRET_CONFIG_KEYS = new Set(['webhookSecret', 'token', 'imapPass', 'smtpPass', 'password', 'secret'])
const MASKED_SECRET = '••••••••'

interface PluginInstanceRow {
  id: string
  plugin_id: string
  name: string
  config_json: string
  cursor: string | null
  enabled: number
  last_sync_at: number | null
  created_at: number
  updated_at: number
}

function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const key of SECRET_CONFIG_KEYS) {
    const val = out[key]
    if (typeof val === 'string' && val.length > 0) {
      out[key] = MASKED_SECRET
    }
  }
  return out
}

function mapInstance(row: PluginInstanceRow, maskSecrets: boolean): PluginInstance {
  const rawConfig = JSON.parse(row.config_json || '{}') as Record<string, unknown>
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    config: maskSecrets ? maskConfig(rawConfig) : rawConfig,
    cursor: row.cursor,
    enabled: Boolean(row.enabled),
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const genericWebhookPlugin: SourcePlugin<{ description?: string }> = {
  id: 'generic-webhook',
  name: 'Generic Webhook Source',
  configSchema: z.object({ description: z.string().optional() }).passthrough(),
  async parseWebhook(_ctx, req): Promise<InboundEnvelope[]> {
    const rawText = req.rawBody.toString('utf8')
    let parsed: Record<string, unknown> = {}
    try {
      const obj = JSON.parse(rawText)
      if (obj && typeof obj === 'object') parsed = obj as Record<string, unknown>
    } catch {
      parsed = { content: rawText }
    }
    const title = String(parsed.title || parsed.subject || 'Webhook Event').slice(0, 200)
    const content = String(parsed.content || parsed.text || parsed.body || rawText || title)
    const externalKey = String(parsed.externalKey || parsed.id || req.headers['x-request-id'] || randomUUID())
    const authorName = String(parsed.authorName || parsed.author || parsed.sender || 'webhook')
    const externalUrl = typeof parsed.externalUrl === 'string' ? parsed.externalUrl : undefined

    return [
      {
        id: randomUUID(),
        source: String(parsed.source || 'generic-webhook'),
        externalKey,
        externalUrl,
        authorName,
        title,
        content,
        attachments: [],
        rawMeta: parsed,
        replyTarget: parsed.replyTarget && typeof parsed.replyTarget === 'object'
          ? (parsed.replyTarget as Record<string, unknown>)
          : undefined
      }
    ]
  }
}

export { githubPlugin as githubWebhookPlugin }

function describePlugin(p: SourcePlugin<unknown>): string {
  switch (p.id) {
    case 'github-webhook':
      return 'Receives GitHub Issues/PRs via HMAC webhooks or REST API polling and posts outbound comment replies'
    case 'email-imap-smtp':
      return 'Polls IMAP mailboxes (with attachments) and sends threaded SMTP replies'
    case 'generic-webhook':
      return 'Generic JSON / plain-text webhook ingestion plugin'
    default:
      return p.name
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, SourcePlugin<any>>()

  constructor(
    private readonly database: CoreDatabase,
    private readonly secrets: SecretProvider,
    private readonly blobs?: BlobService,
    private readonly redactor?: Redactor
  ) {
    this.register(genericWebhookPlugin)
    this.register(githubPlugin)
    this.register(emailPlugin)
  }

  register<TConfig>(plugin: SourcePlugin<TConfig>): void {
    this.plugins.set(plugin.id, plugin as SourcePlugin<any>)
  }

  listDescriptors(): PluginDescriptor[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: describePlugin(p),
      supportsPull: Boolean(p.pull),
      supportsWebhook: Boolean(p.parseWebhook),
      supportsReply: Boolean(p.reply)
    }))
  }

  listInstances(): PluginInstance[] {
    const rows = this.database.db
      .prepare('SELECT * FROM plugin_instances ORDER BY created_at DESC')
      .all() as unknown as PluginInstanceRow[]
    return rows.map((row) => mapInstance(row, true))
  }

  getInstance(id: string): PluginInstance {
    return mapInstance(this.getInstanceRow(id), true)
  }

  private getInstanceRow(id: string): PluginInstanceRow {
    const row = this.database.db
      .prepare('SELECT * FROM plugin_instances WHERE id = ?')
      .get(id) as unknown as PluginInstanceRow | undefined
    if (!row) throw Errors.notFound(`Plugin instance not found: ${id}`)
    return row
  }

  private getInstanceRaw(id: string): PluginInstance {
    return mapInstance(this.getInstanceRow(id), false)
  }

  configureInstance(input: {
    id?: string
    pluginId: string
    name: string
    config?: Record<string, unknown>
    enabled?: boolean
  }): PluginInstance {
    const plugin = this.plugins.get(input.pluginId)
    if (!plugin) throw Errors.notFound(`Unknown pluginId: ${input.pluginId}`)

    const now = Date.now()
    const id = input.id?.trim() || randomUUID()
    const existing = this.database.db
      .prepare('SELECT id, config_json FROM plugin_instances WHERE id = ?')
      .get(id) as { id: string; config_json: string } | undefined

    const mergedRawConfig: Record<string, unknown> = { ...(input.config ?? {}) }
    if (existing) {
      const prevConfig = JSON.parse(existing.config_json || '{}') as Record<string, unknown>
      for (const key of SECRET_CONFIG_KEYS) {
        const incoming = mergedRawConfig[key]
        if (incoming === undefined || incoming === '' || incoming === MASKED_SECRET) {
          if (typeof prevConfig[key] === 'string' && prevConfig[key]) {
            mergedRawConfig[key] = prevConfig[key]
          }
        }
      }
    }

    const parsedConfig = plugin.configSchema.parse(mergedRawConfig) as Record<string, unknown>

    if (existing) {
      this.database.db
        .prepare(
          'UPDATE plugin_instances SET name = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?'
        )
        .run(input.name.trim(), JSON.stringify(parsedConfig), input.enabled === false ? 0 : 1, now, id)
    } else {
      this.database.db
        .prepare(
          `INSERT INTO plugin_instances (id, plugin_id, name, config_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.pluginId, input.name.trim(), JSON.stringify(parsedConfig), input.enabled === false ? 0 : 1, now, now)
    }
    return this.getInstance(id)
  }

  deleteInstance(id: string): void {
    const info = this.database.db.prepare('DELETE FROM plugin_instances WHERE id = ?').run(id)
    if (info.changes === 0) throw Errors.notFound(`Plugin instance not found: ${id}`)
  }

  private createContext<TConfig>(instanceId: string, config: TConfig): PluginContext<TConfig> {
    return {
      instanceId,
      config,
      resolveSecret: async (ref) => {
        const resolved = await this.secrets.resolve(ref)
        if (resolved) this.redactor?.registerSecret(resolved)
        return resolved
      },
      storeAttachment: this.blobs
        ? async (input) => this.blobs!.storeBuffer(input)
        : undefined,
      log: (level, message) => {
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[plugin:${instanceId}] ${message}`)
      }
    }
  }

  async parseWebhook(
    pluginId: string,
    instanceId: string,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ): Promise<InboundEnvelope[]> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin || !plugin.parseWebhook) {
      throw Errors.notFound(`Webhook handler not registered for plugin: ${pluginId}`)
    }
    let config: Record<string, unknown> = {}
    if (instanceId !== 'default') {
      const inst = this.getInstanceRaw(instanceId)
      if (inst.pluginId !== pluginId) throw Errors.invalidParams(`Instance ${instanceId} is not a ${pluginId} instance`)
      if (!inst.enabled) throw Errors.forbidden(`Plugin instance ${inst.name} is disabled`)
      config = inst.config
    }
    return await plugin.parseWebhook(this.createContext(instanceId, config), req)
  }

  async pullInstance(instanceId: string): Promise<InboundEnvelope[]> {
    const inst = this.getInstanceRaw(instanceId)
    if (!inst.enabled) throw Errors.forbidden(`Plugin instance ${inst.name} is disabled`)
    const plugin = this.plugins.get(inst.pluginId)
    if (!plugin || !plugin.pull) {
      return []
    }
    const res = await plugin.pull(this.createContext(inst.id, inst.config), inst.cursor ?? undefined)
    const now = Date.now()
    this.database.db
      .prepare('UPDATE plugin_instances SET cursor = ?, last_sync_at = ?, updated_at = ? WHERE id = ?')
      .run(res.nextCursor ?? inst.cursor, now, now, inst.id)
    return res.envelopes
  }

  canAutoReply(instanceId: string): boolean {
    if (!instanceId || instanceId === 'default' || instanceId === 'manual') return false
    const row = this.database.db
      .prepare('SELECT * FROM plugin_instances WHERE id = ?')
      .get(instanceId) as unknown as PluginInstanceRow | undefined
    if (!row || !row.enabled) return false
    const plugin = this.plugins.get(row.plugin_id)
    if (!plugin?.reply) return false
    const cfg = JSON.parse(row.config_json || '{}') as Record<string, unknown>
    if (cfg.autoReplyOnResolve === false) return false
    if (row.plugin_id === 'email-imap-smtp') {
      return typeof cfg.smtpHost === 'string' && cfg.smtpHost.trim().length > 0
    }
    if (row.plugin_id === 'github-webhook') {
      return typeof cfg.token === 'string' && cfg.token.trim().length > 0
    }
    return true
  }

  async replyInstance(
    instanceId: string,
    target: Record<string, unknown>,
    payload: { text: string; attachments?: FileRef[] }
  ): Promise<void> {
    const inst = this.getInstanceRaw(instanceId)
    if (!inst.enabled) throw Errors.forbidden(`Plugin instance ${inst.name} is disabled`)
    const plugin = this.plugins.get(inst.pluginId)
    if (!plugin || !plugin.reply) {
      throw Errors.invalidParams(`Plugin ${inst.pluginId} does not support outbound replies`)
    }
    await plugin.reply(this.createContext(inst.id, inst.config), target, payload)
  }
}
