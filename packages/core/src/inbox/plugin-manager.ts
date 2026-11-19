import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PluginDescriptor, PluginInstance, SecretProvider } from '@myagents/protocol'
import type { InboundEnvelope, PluginContext, SourcePlugin } from '@myagents/plugin-sdk'
import { z } from 'zod'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'

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

function mapInstance(row: PluginInstanceRow): PluginInstance {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    config: JSON.parse(row.config_json || '{}') as Record<string, unknown>,
    cursor: row.cursor,
    enabled: Boolean(row.enabled),
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex.toLowerCase(), 'utf8')
  const b = Buffer.from(bHex.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
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

export const githubWebhookPlugin: SourcePlugin<{ webhookSecret?: string; repository?: string }> = {
  id: 'github-webhook',
  name: 'GitHub Webhook (Issues / PRs / Comments)',
  configSchema: z.object({
    webhookSecret: z.string().optional(),
    repository: z.string().optional()
  }).passthrough(),
  async parseWebhook(ctx, req): Promise<InboundEnvelope[]> {
    const secret = typeof ctx.config?.webhookSecret === 'string' ? ctx.config.webhookSecret.trim() : ''
    if (secret) {
      const sigHeader = req.headers['x-hub-signature-256'] || ''
      const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex')
      if (!sigHeader || !timingSafeHexEqual(sigHeader, expected)) {
        throw Errors.unauthorized('Invalid GitHub X-Hub-Signature-256')
      }
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      throw Errors.invalidParams('Invalid GitHub webhook JSON body')
    }

    const event = String(req.headers['x-github-event'] || payload.event || 'issue')
    const action = typeof payload.action === 'string' ? payload.action : 'opened'
    const repo = ((payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined) || 'unknown/repo'
    const sender = ((payload.sender as Record<string, unknown> | undefined)?.login as string | undefined) || 'github'
    const issue = (payload.issue ?? payload.pull_request) as Record<string, unknown> | undefined
    const comment = payload.comment as Record<string, unknown> | undefined
    const deliveryId = String(req.headers['x-github-delivery'] || `${event}:${repo}:${issue?.number ?? Date.now()}:${action}`)

    const title = comment
      ? `[GitHub ${repo}#${issue?.number ?? '?'}] New comment by @${sender}`
      : `[GitHub ${repo}#${issue?.number ?? '?'}] ${String(issue?.title || `${event} (${action})`)}`
    const content = comment
      ? String(comment.body || '')
      : String(issue?.body || payload.head_commit?.['message' as never] || JSON.stringify(payload).slice(0, 2000))
    const externalUrl =
      typeof comment?.html_url === 'string'
        ? comment.html_url
        : typeof issue?.html_url === 'string'
          ? issue.html_url
          : undefined

    const labels = Array.isArray(issue?.labels)
      ? issue!.labels.map((l) => (typeof l === 'object' && l && 'name' in l ? String((l as { name: unknown }).name) : String(l)))
      : []

    return [
      {
        id: randomUUID(),
        source: 'github',
        externalKey: deliveryId,
        externalUrl,
        authorName: sender,
        title,
        content: content || title,
        attachments: [],
        rawMeta: { event, action, repository: repo, labels },
        replyTarget: issue?.url ? { issueUrl: String(issue.url) } : undefined
      }
    ]
  }
}

export class PluginManager {
  private readonly plugins = new Map<string, SourcePlugin<any>>()

  constructor(
    private readonly database: CoreDatabase,
    private readonly secrets: SecretProvider
  ) {
    this.register(genericWebhookPlugin)
    this.register(githubWebhookPlugin)
  }

  register<TConfig>(plugin: SourcePlugin<TConfig>): void {
    this.plugins.set(plugin.id, plugin as SourcePlugin<any>)
  }

  listDescriptors(): PluginDescriptor[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.id === 'github-webhook'
        ? '接收 GitHub Issues / Pull Requests / Comments 事件，支持 HMAC-SHA256 验签'
        : '通用 JSON/文本 Webhook 归一化接入插件',
      supportsPull: Boolean(p.pull),
      supportsWebhook: Boolean(p.parseWebhook),
      supportsReply: Boolean(p.reply)
    }))
  }

  listInstances(): PluginInstance[] {
    const rows = this.database.db
      .prepare('SELECT * FROM plugin_instances ORDER BY created_at DESC')
      .all() as unknown as PluginInstanceRow[]
    return rows.map(mapInstance)
  }

  getInstance(id: string): PluginInstance {
    const row = this.database.db
      .prepare('SELECT * FROM plugin_instances WHERE id = ?')
      .get(id) as unknown as PluginInstanceRow | undefined
    if (!row) throw Errors.notFound(`Plugin instance not found: ${id}`)
    return mapInstance(row)
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

    const parsedConfig = plugin.configSchema.parse(input.config ?? {}) as Record<string, unknown>
    const now = Date.now()
    const id = input.id?.trim() || randomUUID()
    const existing = this.database.db
      .prepare('SELECT id FROM plugin_instances WHERE id = ?')
      .get(id) as { id: string } | undefined

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

  private createContext<TConfig>(instanceId: string, config: TConfig): PluginContext<TConfig> {
    return {
      instanceId,
      config,
      resolveSecret: (ref) => this.secrets.resolve(ref),
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
      const inst = this.getInstance(instanceId)
      if (inst.pluginId !== pluginId) throw Errors.invalidParams(`Instance ${instanceId} is not a ${pluginId} instance`)
      if (!inst.enabled) throw Errors.forbidden(`Plugin instance ${inst.name} is disabled`)
      config = inst.config
    }
    return await plugin.parseWebhook(this.createContext(instanceId, config), req)
  }

  async pullInstance(instanceId: string): Promise<InboundEnvelope[]> {
    const inst = this.getInstance(instanceId)
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
}
