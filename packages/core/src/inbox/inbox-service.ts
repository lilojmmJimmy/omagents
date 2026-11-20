import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  InboxItem,
  InboxStatus,
  RoutingRule,
  RoutingRuleSaveInput,
  WebhookConfig,
  WorkNode
} from '@myagents/protocol'
import type { InboundEnvelope } from '@myagents/plugin-sdk'
import type { CollabEngine } from '../collab/collab-engine'
import { Errors } from '../errors'
import type { AgentService } from '../runtime/agent-service'
import type { BlobService } from '../storage/blob-service'
import type { CoreDatabase } from '../storage/database'
import type { PluginManager } from './plugin-manager'

interface WebhookRow {
  id: string
  name: string
  secret_hash: string
  enabled: number
  created_at: number
}

interface RoutingRuleRow {
  id: string
  name: string
  priority: number
  source_filter: string | null
  match_type: RoutingRule['matchType']
  match_expr: string
  allow_write: number
  action_json: string
  enabled: number
  created_at: number
  updated_at: number
}

interface InboxItemRow {
  id: string
  source: string
  source_instance_id: string
  external_key: string
  external_url: string | null
  author_name: string
  title: string
  content: string
  attachments_json: string
  status: InboxStatus
  assigned_room_id: string | null
  assigned_root_node_id: string | null
  matched_rule_id: string | null
  reply_target_json: string | null
  raw_meta_json: string
  created_at: number
  updated_at: number
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function mapWebhook(row: WebhookRow): WebhookConfig {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  }
}

function mapRule(row: RoutingRuleRow): RoutingRule {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    sourceFilter: row.source_filter,
    matchType: row.match_type,
    matchExpr: row.match_expr,
    allowWrite: Boolean(row.allow_write),
    action: JSON.parse(row.action_json || '{}') as RoutingRule['action'],
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapItem(row: InboxItemRow): InboxItem {
  return {
    id: row.id,
    source: row.source,
    sourceInstanceId: row.source_instance_id,
    externalKey: row.external_key,
    externalUrl: row.external_url,
    authorName: row.author_name,
    title: row.title,
    content: row.content,
    attachments: JSON.parse(row.attachments_json || '[]') as InboxItem['attachments'],
    status: row.status,
    assignedRoomId: row.assigned_room_id,
    assignedRootNodeId: row.assigned_root_node_id,
    matchedRuleId: row.matched_rule_id,
    replyTarget: row.reply_target_json ? (JSON.parse(row.reply_target_json) as Record<string, unknown>) : null,
    rawMeta: JSON.parse(row.raw_meta_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function getNestedField(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.').filter(Boolean)
  let cur: unknown = obj
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export class InboxService {
  constructor(
    private readonly database: CoreDatabase,
    private readonly collab: CollabEngine,
    private readonly agents: AgentService,
    private readonly plugins: PluginManager,
    private readonly onUpdated?: (item: InboxItem | { deletedId?: string }) => void,
    private readonly blobs?: BlobService
  ) {}

  listWebhooks(): WebhookConfig[] {
    const rows = this.database.db
      .prepare('SELECT id, name, secret_hash, enabled, created_at FROM webhooks ORDER BY created_at DESC')
      .all() as unknown as WebhookRow[]
    return rows.map(mapWebhook)
  }

  createWebhook(name: string): { webhook: WebhookConfig; secret: string } {
    const cleanName = name.trim()
    if (!cleanName) throw Errors.invalidParams('Webhook name is required')
    const id = randomUUID()
    const secret = `whsec_${randomBytes(24).toString('hex')}`
    const now = Date.now()
    this.database.db
      .prepare('INSERT INTO webhooks (id, name, secret_hash, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(id, cleanName, sha256Hex(secret), now)
    const row = this.database.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as unknown as WebhookRow
    return { webhook: mapWebhook(row), secret }
  }

  deleteWebhook(id: string): void {
    const res = this.database.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id)
    if (res.changes === 0) throw Errors.notFound(`Webhook not found: ${id}`)
  }

  verifyWebhookSecret(hookId: string, secret: string): boolean {
    const row = this.database.db
      .prepare('SELECT secret_hash, enabled FROM webhooks WHERE id = ?')
      .get(hookId) as { secret_hash: string; enabled: number } | undefined
    if (!row || !row.enabled || !secret) return false
    return timingSafeStringEqual(row.secret_hash, sha256Hex(secret))
  }

  listRules(): RoutingRule[] {
    const rows = this.database.db
      .prepare('SELECT * FROM routing_rules ORDER BY priority ASC, created_at ASC')
      .all() as unknown as RoutingRuleRow[]
    return rows.map(mapRule)
  }

  saveRule(rawInput: RoutingRuleSaveInput): RoutingRule {
    const input = rawInput
    const id = input.id?.trim() || randomUUID()
    const now = Date.now()
    const existing = this.database.db.prepare('SELECT id FROM routing_rules WHERE id = ?').get(id) as { id: string } | undefined

    if (existing) {
      this.database.db
        .prepare(
          `UPDATE routing_rules
           SET name = ?, priority = ?, source_filter = ?, match_type = ?, match_expr = ?,
               allow_write = ?, action_json = ?, enabled = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.priority,
          input.sourceFilter || null,
          input.matchType,
          input.matchExpr,
          input.allowWrite ? 1 : 0,
          JSON.stringify(input.action),
          input.enabled ? 1 : 0,
          now,
          id
        )
    } else {
      this.database.db
        .prepare(
          `INSERT INTO routing_rules (
             id, name, priority, source_filter, match_type, match_expr, allow_write, action_json, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name,
          input.priority,
          input.sourceFilter || null,
          input.matchType,
          input.matchExpr,
          input.allowWrite ? 1 : 0,
          JSON.stringify(input.action),
          input.enabled ? 1 : 0,
          now,
          now
        )
    }
    const row = this.database.db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id) as unknown as RoutingRuleRow
    return mapRule(row)
  }

  deleteRule(id: string): void {
    const res = this.database.db.prepare('DELETE FROM routing_rules WHERE id = ?').run(id)
    if (res.changes === 0) throw Errors.notFound(`Routing rule not found: ${id}`)
  }

  listItems(status?: InboxStatus): InboxItem[] {
    const rows = status
      ? (this.database.db
          .prepare('SELECT * FROM inbox_items WHERE status = ? ORDER BY created_at DESC LIMIT 200')
          .all(status) as unknown as InboxItemRow[])
      : (this.database.db
          .prepare('SELECT * FROM inbox_items ORDER BY created_at DESC LIMIT 200')
          .all() as unknown as InboxItemRow[])
    return rows.map(mapItem)
  }

  getItem(id: string): InboxItem {
    const row = this.database.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as unknown as InboxItemRow | undefined
    if (!row) throw Errors.notFound(`Inbox item not found: ${id}`)
    return mapItem(row)
  }

  async createManual(input: {
    title: string
    content: string
    authorName?: string
    source?: string
    externalUrl?: string
    attachmentFileIds?: string[]
  }): Promise<InboxItem> {
    const attachments = this.blobs ? this.blobs.resolveRefs(input.attachmentFileIds ?? []) : []
    const envelope: InboundEnvelope = {
      id: randomUUID(),
      source: input.source?.trim() || 'manual',
      externalKey: `manual-${randomUUID()}`,
      externalUrl: input.externalUrl?.trim() || undefined,
      authorName: input.authorName?.trim() || 'admin',
      title: input.title.trim(),
      content: input.content.trim(),
      attachments,
      rawMeta: { manual: true }
    }
    return await this.ingestEnvelope(envelope, 'manual')
  }

  async ingestGenericWebhook(
    hookId: string,
    secret: string,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ): Promise<{ deduplicated: boolean; item: InboxItem }> {
    if (!this.verifyWebhookSecret(hookId, secret)) {
      throw Errors.unauthorized('Invalid or disabled webhook secret')
    }
    const envelopes = await this.plugins.parseWebhook('generic-webhook', 'default', req)
    const first = envelopes[0]!
    const existing = this.database.db
      .prepare('SELECT * FROM inbox_items WHERE source = ? AND source_instance_id = ? AND external_key = ?')
      .get(first.source, hookId, first.externalKey) as unknown as InboxItemRow | undefined
    if (existing) {
      return { deduplicated: true, item: mapItem(existing) }
    }
    const item = await this.ingestEnvelope(first, hookId)
    return { deduplicated: false, item }
  }

  async ingestPluginWebhook(
    pluginId: string,
    instanceId: string,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ): Promise<{ items: InboxItem[] }> {
    const envelopes = await this.plugins.parseWebhook(pluginId, instanceId, req)
    const items: InboxItem[] = []
    for (const env of envelopes) {
      items.push(await this.ingestEnvelope(env, instanceId))
    }
    return { items }
  }

  async syncPluginInstance(instanceId: string): Promise<InboxItem[]> {
    const envelopes = await this.plugins.pullInstance(instanceId)
    const items: InboxItem[] = []
    for (const env of envelopes) {
      items.push(await this.ingestEnvelope(env, instanceId))
    }
    return items
  }

  async ingestEnvelope(envelope: InboundEnvelope, sourceInstanceId = 'default'): Promise<InboxItem> {
    const existing = this.database.db
      .prepare('SELECT * FROM inbox_items WHERE source = ? AND source_instance_id = ? AND external_key = ?')
      .get(envelope.source, sourceInstanceId, envelope.externalKey) as unknown as InboxItemRow | undefined
    if (existing) return mapItem(existing)

    const id = randomUUID()
    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO inbox_items (
           id, source, source_instance_id, external_key, external_url, author_name, title, content,
           attachments_json, status, reply_target_json, raw_meta_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`
      )
      .run(
        id,
        envelope.source,
        sourceInstanceId,
        envelope.externalKey,
        envelope.externalUrl ?? null,
        envelope.authorName,
        envelope.title,
        envelope.content,
        JSON.stringify(envelope.attachments ?? []),
        envelope.replyTarget ? JSON.stringify(envelope.replyTarget) : null,
        JSON.stringify(envelope.rawMeta ?? {}),
        now,
        now
      )

    if (this.blobs && (envelope.attachments?.length ?? 0) > 0) {
      this.blobs.attachRefs(
        envelope.attachments.map((a) => a.fileId),
        'inbox',
        id
      )
    }

    let item = this.getItem(id)
    const matched = this.matchRule(item)
    if (matched) {
      try {
        item = await this.dispatchWithRule(item, matched)
      } catch (err) {
        console.error('[inbox] auto-routing failed:', err)
      }
    }
    this.onUpdated?.(item)
    return item
  }

  private matchRule(item: InboxItem): RoutingRule | null {
    const rules = this.listRules().filter((r) => r.enabled)
    const haystack = `${item.title}\n${item.content}`

    for (const rule of rules) {
      if (rule.sourceFilter && rule.sourceFilter !== '*' && rule.sourceFilter.toLowerCase() !== item.source.toLowerCase()) {
        continue
      }
      if (rule.matchType === 'always') return rule
      if (rule.matchType === 'keyword') {
        const keywords = rule.matchExpr
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
        if (keywords.length > 0 && keywords.some((kw) => haystack.toLowerCase().includes(kw))) {
          return rule
        }
      } else if (rule.matchType === 'regex') {
        try {
          if (rule.matchExpr && new RegExp(rule.matchExpr, 'i').test(haystack)) return rule
        } catch {
          // ignore malformed regex
        }
      } else if (rule.matchType === 'meta_equals') {
        const eqIdx = rule.matchExpr.indexOf('=')
        if (eqIdx > 0) {
          const key = rule.matchExpr.slice(0, eqIdx).trim()
          const expected = rule.matchExpr.slice(eqIdx + 1).trim()
          const actual = getNestedField(item.rawMeta, key)
          if (actual !== undefined && String(actual) === expected) return rule
        }
      }
    }
    return null
  }

  private async dispatchWithRule(item: InboxItem, rule: RoutingRule): Promise<InboxItem> {
    const action = rule.action
    return await this.assignItem({
      itemId: item.id,
      mode: action.mode === 'append_room' ? 'append_room' : 'create_room',
      roomId: action.targetRoomId,
      strategyId: action.strategyId,
      strategyConfig: action.strategyConfig,
      agentIds: action.agentIds,
      workspaceId: action.workspaceId ?? undefined,
      allowWrite: rule.allowWrite,
      promptPrefix: action.promptPrefix,
      matchedRuleId: rule.id
    })
  }

  async assignItem(input: {
    itemId: string
    mode: 'create_room' | 'append_room'
    roomId?: string
    strategyId?: string
    strategyConfig?: Record<string, unknown>
    agentIds?: string[]
    workspaceId?: string
    allowWrite?: boolean
    promptPrefix?: string
    matchedRuleId?: string
  }): Promise<InboxItem> {
    const item = this.getItem(input.itemId)
    const allowWrite = Boolean(input.allowWrite)
    const forceReadOnly = !allowWrite

    let targetRoomId = input.roomId
    if (input.mode === 'create_room' || !targetRoomId) {
      const candidateAgents = (input.agentIds ?? []).filter(Boolean)
      const allActive = candidateAgents.length > 0
        ? candidateAgents.map((id) => this.agents.get(id))
        : this.agents.list(false).slice(0, 1)
      if (allActive.length === 0) {
        throw Errors.invalidParams('No active agents available to assign inbox item')
      }
      const chosenStrategy =
        input.strategyId?.trim() || (allActive.length > 1 ? 'open-channel' : 'single')
      const created = await this.collab.createRoom({
        title: `[Ticket] ${item.title.slice(0, 60)}`,
        purpose: `Inbox ${item.source}:${item.externalKey}`,
        strategyId: chosenStrategy,
        strategyConfig: input.strategyConfig,
        primaryWorkspaceId: input.workspaceId || allActive[0]!.defaultWorkspaceId,
        members: allActive.map((a, idx) => ({
          agentId: a.id,
          displayName: a.name,
          roleKind: idx === 0 && chosenStrategy !== 'single' ? (chosenStrategy === 'roundtable' ? 'chair' : 'lead') : 'member'
        }))
      })
      targetRoomId = created.id
    } else {
      this.collab.getRoom(targetRoomId)
    }

    const prefix = input.promptPrefix?.trim()
      ? `${input.promptPrefix.trim()}\n\n`
      : allowWrite
        ? ''
        : '[Security Policy: This message originates from an external inbox event; read-only/lockdown isolation is enabled]\n\n'
    const seedContent = [
      `${prefix}### Inbox Ticket: ${item.title}`,
      `- Source: \`${item.source}\` / Author: \`${item.authorName}\``,
      item.externalUrl ? `- Source URL: ${item.externalUrl}` : '',
      '',
      item.content
    ]
      .filter(Boolean)
      .join('\n')

    const { spawnedRootNodeIds } = await this.collab.sendMessageDetailed(targetRoomId, {
      content: seedContent,
      authorKind: 'intake',
      authorId: item.source,
      authorName: `${item.source}:${item.authorName}`,
      messageKind: 'intake_seed',
      sourceTrustLevel: allowWrite ? 'trusted' : 'untrusted',
      forceReadOnly,
      attachments: item.attachments,
      idempotencyKey: `inbox-assign-${item.id}-${Date.now()}`
    })

    const now = Date.now()
    this.database.db
      .prepare(
        `UPDATE inbox_items
         SET status = 'in_progress', assigned_room_id = ?, assigned_root_node_id = ?, matched_rule_id = COALESCE(?, matched_rule_id), updated_at = ?
         WHERE id = ?`
      )
      .run(targetRoomId, spawnedRootNodeIds[0] ?? null, input.matchedRuleId ?? null, now, item.id)

    const updated = this.getItem(item.id)
    this.onUpdated?.(updated)
    return updated
  }

  deleteItem(itemId: string): void {
    this.getItem(itemId)
    this.blobs?.releaseOwnerRefs('inbox', [itemId])
    this.database.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(itemId)
    this.onUpdated?.({ deletedId: itemId })
  }

  private extractResolutionSummary(item: InboxItem): string {
    if (item.assignedRoomId) {
      const msg = this.database.db
        .prepare(
          `SELECT content FROM room_messages
           WHERE room_id = ? AND author_kind = 'agent' AND kind IN ('summary', 'result', 'chat')
           ORDER BY seq DESC LIMIT 1`
        )
        .get(item.assignedRoomId) as { content: string } | undefined
      if (msg?.content?.trim()) return msg.content.trim().slice(0, 4_000)
    }
    if (item.assignedRootNodeId) {
      const node = this.database.db
        .prepare('SELECT result_text FROM work_nodes WHERE id = ?')
        .get(item.assignedRootNodeId) as { result_text: string | null } | undefined
      if (node?.result_text?.trim()) return node.result_text.trim().slice(0, 4_000)
    }
    return `Resolved: ${item.title}`
  }

  private recordReplyMeta(itemId: string, rawMeta: Record<string, unknown>, replyMeta: Record<string, unknown>): InboxItem {
    const nextMeta = { ...rawMeta, _reply: replyMeta }
    this.database.db
      .prepare('UPDATE inbox_items SET raw_meta_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), Date.now(), itemId)
    const updated = this.getItem(itemId)
    this.onUpdated?.(updated)
    return updated
  }

  async replyToItem(itemId: string, explicitText?: string): Promise<InboxItem> {
    const item = this.getItem(itemId)
    if (!item.replyTarget) {
      throw Errors.invalidParams('Inbox item does not have a reply target')
    }
    if (!item.sourceInstanceId || item.sourceInstanceId === 'default' || item.sourceInstanceId === 'manual') {
      throw Errors.invalidParams('Inbox item is not linked to a reply-capable plugin instance')
    }

    const body = explicitText?.trim() ? explicitText.trim() : this.extractResolutionSummary(item)
    try {
      await this.plugins.replyInstance(item.sourceInstanceId, item.replyTarget, { text: body })
      return this.recordReplyMeta(item.id, item.rawMeta, {
        status: 'sent',
        sentAt: Date.now(),
        preview: body.slice(0, 200)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.recordReplyMeta(item.id, item.rawMeta, {
        status: 'failed',
        attemptedAt: Date.now(),
        error: msg.slice(0, 500)
      })
      throw err
    }
  }

  private async tryAutoReply(item: InboxItem, explicitText?: string): Promise<InboxItem> {
    if (!item.replyTarget || !item.sourceInstanceId) return item
    try {
      return await this.replyToItem(item.id, explicitText)
    } catch (err) {
      console.error('[inbox] outbound reply failed:', err)
      return this.getItem(item.id)
    }
  }

  async setStatus(
    itemId: string,
    status: InboxStatus,
    opts?: { sendReply?: boolean; replyText?: string }
  ): Promise<InboxItem> {
    this.getItem(itemId)
    this.database.db
      .prepare('UPDATE inbox_items SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), itemId)
    let updated = this.getItem(itemId)
    this.onUpdated?.(updated)

    if (
      status === 'resolved' &&
      opts?.sendReply !== false &&
      updated.replyTarget &&
      (Boolean(opts?.replyText?.trim()) || this.plugins.canAutoReply(updated.sourceInstanceId))
    ) {
      updated = await this.tryAutoReply(updated, opts?.replyText)
    }
    return updated
  }

  onRootNodeSettled(node: WorkNode): void {
    if (node.parentNodeId !== null) return
    const row = this.database.db
      .prepare('SELECT * FROM inbox_items WHERE assigned_root_node_id = ?')
      .get(node.id) as unknown as InboxItemRow | undefined
    if (!row || row.status === 'resolved' || row.status === 'ignored') return
    if (node.status === 'completed') {
      this.database.db
        .prepare("UPDATE inbox_items SET status = 'resolved', updated_at = ? WHERE id = ?")
        .run(Date.now(), row.id)
      const resolved = this.getItem(row.id)
      this.onUpdated?.(resolved)
      if (resolved.replyTarget && this.plugins.canAutoReply(resolved.sourceInstanceId)) {
        void this.tryAutoReply(resolved)
      }
    }
  }
}
