import { useState, type ChangeEvent, type FormEvent } from 'react'
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Inbox,
  KeyRound,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Send,
  ShieldAlert,
  Trash2,
  Webhook,
  Workflow,
  X
} from 'lucide-react'
import type { FileRef, InboxItem, InboxStatus, RoutingMatchType } from '@myagents/protocol'
import { apiUploadBlob, blobUrl, rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

type InboxSubTab = 'items' | 'webhooks' | 'rules'

function statusBadge(status: InboxStatus): { label: string; cls: string } {
  switch (status) {
    case 'new':
      return { label: 'Pending', cls: 'bg-[#c2542d]/15 text-[#c2542d]' }
    case 'in_progress':
      return { label: 'In Progress', cls: 'bg-blue-50 text-blue-700' }
    case 'resolved':
      return { label: 'Resolved', cls: 'bg-emerald-50 text-emerald-700' }
    case 'ignored':
      return { label: 'Dismissed', cls: 'bg-[#efefef] text-[#777]' }
  }
}

export function InboxView() {
  const inboxItems = useAppStore((s) => s.inboxItems)
  const webhooks = useAppStore((s) => s.webhooks)
  const routingRules = useAppStore((s) => s.routingRules)
  const pluginDescriptors = useAppStore((s) => s.pluginDescriptors)
  const pluginInstances = useAppStore((s) => s.pluginInstances)
  const agents = useAppStore((s) => s.agents)
  const rooms = useAppStore((s) => s.rooms)
  const workspaces = useAppStore((s) => s.workspaces)
  const refreshInbox = useAppStore((s) => s.refreshInbox)
  const refreshAll = useAppStore((s) => s.refreshAll)
  const selectRoom = useAppStore((s) => s.selectRoom)

  const [tab, setTab] = useState<InboxSubTab>('items')
  const [statusFilter, setStatusFilter] = useState<InboxStatus | 'all'>('all')
  const [error, setError] = useState<string | null>(null)

  // Manual ticket creation
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTitle, setManualTitle] = useState('')
  const [manualContent, setManualContent] = useState('')
  const [manualAuthor, setManualAuthor] = useState('admin')
  const [manualAttachments, setManualAttachments] = useState<FileRef[]>([])
  const [manualUploading, setManualUploading] = useState(false)

  // Outbound reply composer state
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)

  // Assign modal state
  const [assignTarget, setAssignTarget] = useState<InboxItem | null>(null)
  const [assignMode, setAssignMode] = useState<'create_room' | 'append_room'>('create_room')
  const [assignRoomId, setAssignRoomId] = useState('')
  const [assignStrategyId, setAssignStrategyId] = useState<'single' | 'open-channel' | 'roundtable'>('open-channel')
  const [assignAgentIds, setAssignAgentIds] = useState<string[]>(() => agents.slice(0, 1).map((a) => a.id))
  const [assignWorkspaceId, setAssignWorkspaceId] = useState('')
  const [assignAllowWrite, setAssignAllowWrite] = useState(false)

  // Webhook creation state
  const [hookName, setHookName] = useState('')
  const [createdHookSecret, setCreatedHookSecret] = useState<{ id: string; name: string; secret: string } | null>(null)
  const [copiedSecret, setCopiedSecret] = useState(false)

  // Plugin instance form (GitHub / Email)
  const [pluginId, setPluginId] = useState('github-webhook')
  const [pluginName, setPluginName] = useState('')
  const [pluginSecret, setPluginSecret] = useState('')
  const [ghRepo, setGhRepo] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [ghLabels, setGhLabels] = useState('')
  const [ghIncludePrs, setGhIncludePrs] = useState(true)
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState(993)
  const [imapSecure, setImapSecure] = useState(true)
  const [imapUser, setImapUser] = useState('')
  const [imapPass, setImapPass] = useState('')
  const [imapMailbox, setImapMailbox] = useState('INBOX')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(465)
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [fromAddress, setFromAddress] = useState('')
  const [pluginAutoReply, setPluginAutoReply] = useState(true)
  const [syncingInstanceId, setSyncingInstanceId] = useState<string | null>(null)

  // Rule creation state
  const [ruleName, setRuleName] = useState('')
  const [rulePriority, setRulePriority] = useState(100)
  const [ruleSourceFilter, setRuleSourceFilter] = useState('')
  const [ruleMatchType, setRuleMatchType] = useState<RoutingMatchType>('keyword')
  const [ruleMatchExpr, setRuleMatchExpr] = useState('')
  const [ruleAllowWrite, setRuleAllowWrite] = useState(false)
  const [ruleStrategyId, setRuleStrategyId] = useState<'single' | 'open-channel' | 'roundtable'>('open-channel')
  const [ruleWorkspaceId, setRuleWorkspaceId] = useState('')
  const [ruleAgentIds, setRuleAgentIds] = useState<string[]>(() => agents.slice(0, 1).map((a) => a.id))

  const visibleItems = statusFilter === 'all' ? inboxItems : inboxItems.filter((i) => i.status === statusFilter)

  const openAssignModal = (item: InboxItem) => {
    setAssignTarget(item)
    setAssignMode('create_room')
    setAssignAgentIds(agents.slice(0, 1).map((a) => a.id))
    setAssignStrategyId(agents.length > 1 ? 'open-channel' : 'single')
    setAssignRoomId(rooms[0]?.id ?? '')
    setAssignWorkspaceId('')
    setAssignAllowWrite(false)
  }

  const handleManualFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setError(null)
    setManualUploading(true)
    try {
      const uploaded: FileRef[] = []
      for (const f of Array.from(files)) {
        uploaded.push(await apiUploadBlob(f))
      }
      setManualAttachments((prev) => [...prev, ...uploaded].slice(0, 10))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload attachment')
    } finally {
      setManualUploading(false)
      e.target.value = ''
    }
  }

  const handleCreateManual = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await rpc.call('inbox.createManual', {
        title: manualTitle,
        content: manualContent,
        authorName: manualAuthor,
        attachmentFileIds: manualAttachments.map((a) => a.fileId)
      })
      setManualTitle('')
      setManualContent('')
      setManualAttachments([])
      setManualOpen(false)
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket')
    }
  }

  const handleDeleteItem = async (item: InboxItem) => {
    if (!confirm(`Delete inbox item "${item.title}"?`)) return
    setError(null)
    try {
      await rpc.call('inbox.delete', { itemId: item.id })
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item')
    }
  }

  const handleSendReply = async (itemId: string) => {
    setError(null)
    setReplySending(true)
    try {
      await rpc.call('inbox.reply', {
        itemId,
        text: replyDraft.trim() || undefined
      })
      setReplyOpenId(null)
      setReplyDraft('')
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Outbound reply failed')
    } finally {
      setReplySending(false)
    }
  }

  const handleAssignSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!assignTarget) return
    setError(null)
    try {
      const updated = await rpc.call<InboxItem>('inbox.assign', {
        itemId: assignTarget.id,
        mode: assignMode,
        roomId: assignMode === 'append_room' ? assignRoomId : undefined,
        strategyId: assignMode === 'create_room' ? assignStrategyId : undefined,
        agentIds: assignMode === 'create_room' ? assignAgentIds : undefined,
        workspaceId: assignWorkspaceId || undefined,
        allowWrite: assignAllowWrite
      })
      setAssignTarget(null)
      await refreshAll()
      if (updated.assignedRoomId) {
        await selectRoom(updated.assignedRoomId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign ticket')
    }
  }

  const handleSetStatus = async (itemId: string, status: InboxStatus) => {
    setError(null)
    try {
      await rpc.call('inbox.setStatus', { itemId, status })
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    }
  }

  const handleCreateWebhook = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const res = await rpc.call<{ webhook: { id: string; name: string }; secret: string }>('webhooks.create', {
        name: hookName
      })
      setHookName('')
      setCreatedHookSecret({ id: res.webhook.id, name: res.webhook.name, secret: res.secret })
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook')
    }
  }

  const handleDeleteWebhook = async (id: string) => {
    await rpc.call('webhooks.delete', { id })
    await refreshInbox()
  }

  const handleConfigurePlugin = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      let config: Record<string, unknown> = {}
      if (pluginId === 'email-imap-smtp') {
        config = {
          imapHost,
          imapPort: Number(imapPort) || 993,
          imapSecure,
          imapUser,
          imapPass,
          mailbox: imapMailbox.trim() || 'INBOX',
          smtpHost: smtpHost.trim() || undefined,
          smtpPort: Number(smtpPort) || 465,
          smtpSecure,
          fromAddress: fromAddress.trim() || undefined,
          autoReplyOnResolve: pluginAutoReply
        }
      } else {
        config = {
          ...(pluginSecret.trim() ? { webhookSecret: pluginSecret.trim() } : {}),
          ...(ghRepo.trim() ? { repository: ghRepo.trim() } : {}),
          ...(ghToken.trim() ? { token: ghToken.trim() } : {}),
          ...(ghLabels.trim() ? { labels: ghLabels.trim() } : {}),
          includePullRequests: ghIncludePrs,
          autoReplyOnResolve: pluginAutoReply
        }
      }
      await rpc.call('plugins.configure', {
        pluginId,
        name: pluginName,
        config,
        enabled: true
      })
      setPluginName('')
      setPluginSecret('')
      setGhRepo('')
      setGhToken('')
      setGhLabels('')
      setImapPass('')
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to configure plugin')
    }
  }

  const handleSyncPlugin = async (instanceId: string) => {
    setError(null)
    setSyncingInstanceId(instanceId)
    try {
      await rpc.call('plugins.syncNow', { instanceId }, 60_000)
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin sync failed')
    } finally {
      setSyncingInstanceId(null)
    }
  }

  const handleDeletePluginInstance = async (id: string, name: string) => {
    if (!confirm(`Delete plugin instance "${name}"?`)) return
    setError(null)
    try {
      await rpc.call('plugins.delete', { id })
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plugin instance')
    }
  }

  const handleCreateRule = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const selectedAgents = ruleAgentIds.length > 0 ? ruleAgentIds : agents.slice(0, 1).map((a) => a.id)
      await rpc.call('routingRules.save', {
        name: ruleName,
        priority: Number(rulePriority) || 100,
        sourceFilter: ruleSourceFilter.trim() || null,
        matchType: ruleMatchType,
        matchExpr: ruleMatchExpr,
        allowWrite: ruleAllowWrite,
        enabled: true,
        action: {
          mode: 'create_room',
          strategyId: ruleStrategyId,
          agentIds: selectedAgents,
          workspaceId: ruleWorkspaceId || null
        }
      })
      setRuleName('')
      setRuleMatchExpr('')
      setRuleWorkspaceId('')
      await refreshInbox()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing rule')
    }
  }

  const toggleRuleEnabled = async (ruleId: string) => {
    const r = routingRules.find((x) => x.id === ruleId)
    if (!r) return
    await rpc.call('routingRules.save', {
      id: r.id,
      name: r.name,
      priority: r.priority,
      sourceFilter: r.sourceFilter,
      matchType: r.matchType,
      matchExpr: r.matchExpr,
      allowWrite: r.allowWrite,
      action: r.action,
      enabled: !r.enabled
    })
    await refreshInbox()
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedSecret(true)
      setTimeout(() => setCopiedSecret(false), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-[#111] flex items-center gap-2">
              <Inbox size={17} className="text-[#c2542d]" />
              <span>Unified Inbox & Webhooks</span>
            </h1>
            <p className="text-xs text-[#666] mt-0.5">
              Ingest external webhooks, SourcePlugins, and manual tickets with default read-only Lockdown isolation, plus automatic or manual room dispatch.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-white border border-[#e5e5e5] rounded-lg text-xs">
            {([
              ['items', `Tickets (${inboxItems.length})`, Inbox],
              ['webhooks', `Webhooks & Plugins (${webhooks.length})`, Webhook],
              ['rules', `Routing Rules (${routingRules.length})`, Workflow]
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md cursor-pointer ${
                  tab === key ? 'bg-[#c2542d]/10 text-[#c2542d] font-medium' : 'text-[#555] hover:bg-[#f5f5f5]'
                }`}
              >
                <Icon size={13} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

        {/* TAB 1: ITEMS */}
        {tab === 'items' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                <Filter size={13} className="text-[#888]" />
                {(['all', 'new', 'in_progress', 'resolved', 'ignored'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`px-2.5 py-1 rounded-md border cursor-pointer ${
                      statusFilter === st
                        ? 'bg-[#111] text-white border-[#111]'
                        : 'bg-white text-[#555] border-[#dcdcdc] hover:border-[#aaa]'
                    }`}
                  >
                    {st === 'all' ? 'All' : statusBadge(st).label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setManualOpen(!manualOpen)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
              >
                <Plus size={13} />
                <span>New Ticket</span>
              </button>
            </div>

            {manualOpen && (
              <form onSubmit={handleCreateManual} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs text-[#555] mb-1">Title *</label>
                    <input
                      required
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                      placeholder="e.g. Investigate payment callback failure"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Author</label>
                    <input
                      value={manualAuthor}
                      onChange={(e) => setManualAuthor(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#555] mb-1">Details *</label>
                  <textarea
                    required
                    rows={3}
                    value={manualContent}
                    onChange={(e) => setManualContent(e.target.value)}
                    placeholder="Describe context, logs, or reproduction details..."
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#dcdcdc] hover:border-[#c2542d] rounded-lg cursor-pointer text-[#555]">
                      <Paperclip size={12} />
                      <span>{manualUploading ? 'Uploading...' : 'Attach Files'}</span>
                      <input type="file" multiple className="hidden" onChange={(e) => void handleManualFileSelect(e)} />
                    </label>
                    {manualAttachments.map((att) => (
                      <span
                        key={att.fileId}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f5f5f5] border border-[#e2e2e2] text-[11px]"
                      >
                        <span className="truncate max-w-[140px]">{att.filename}</span>
                        <button
                          type="button"
                          onClick={() => setManualAttachments((prev) => prev.filter((x) => x.fileId !== att.fileId))}
                          className="text-[#888] hover:text-red-600 cursor-pointer"
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setManualOpen(false)} className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer">
                      Cancel
                    </button>
                    <button type="submit" disabled={manualUploading} className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer">
                      Create & Match Rules
                    </button>
                  </div>
                </div>
              </form>
            )}

            {visibleItems.length === 0 ? (
              <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
                No inbox tickets yet. Create one manually or connect an external webhook.
              </div>
            ) : (
              <div className="space-y-2.5">
                {visibleItems.map((item) => {
                  const badge = statusBadge(item.status)
                  const replyInfo = (item.rawMeta?._reply as
                    | { status?: string; error?: string; sentAt?: number }
                    | undefined)
                  return (
                    <div key={item.id} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${badge.cls}`}>{badge.label}</span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">{item.source}</span>
                            {replyInfo?.status === 'sent' && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
                                Replied
                              </span>
                            )}
                            {replyInfo?.status === 'failed' && (
                              <span
                                className="text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-700"
                                title={replyInfo.error}
                              >
                                Reply failed
                              </span>
                            )}
                            <span className="text-sm font-medium text-[#111] truncate">{item.title}</span>
                          </div>
                          <div className="text-[11px] text-[#888] flex items-center gap-3 flex-wrap">
                            <span>Author: {item.authorName}</span>
                            <span>{new Date(item.createdAt).toLocaleString()}</span>
                            {item.matchedRuleId && <span className="text-emerald-700">Matched auto-routing rule</span>}
                            {item.externalUrl && (
                              <a
                                href={item.externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 text-[#c2542d] hover:underline"
                              >
                                <span>Source</span>
                                <ExternalLink size={10} />
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.assignedRoomId && (
                            <button
                              type="button"
                              onClick={() => void selectRoom(item.assignedRoomId!)}
                              className="px-2.5 py-1 text-xs border border-[#dcdcdc] hover:border-[#c2542d] rounded-lg text-[#111] cursor-pointer"
                            >
                              Open Room
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openAssignModal(item)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-[#c2542d]/10 text-[#c2542d] hover:bg-[#c2542d]/15 rounded-lg cursor-pointer"
                          >
                            <Send size={11} />
                            <span>Assign</span>
                          </button>
                          {item.replyTarget && item.sourceInstanceId !== 'default' && item.sourceInstanceId !== 'manual' && (
                            <button
                              type="button"
                              onClick={() => {
                                setReplyOpenId(replyOpenId === item.id ? null : item.id)
                                setReplyDraft('')
                              }}
                              className="flex items-center gap-1 px-2 py-1 text-xs border border-[#dcdcdc] hover:border-[#c2542d] rounded-lg text-[#333] cursor-pointer"
                              title="Send outbound reply via source channel"
                            >
                              <Reply size={11} />
                              <span>Reply</span>
                            </button>
                          )}
                          {item.status !== 'resolved' && (
                            <button
                              type="button"
                              onClick={() => void handleSetStatus(item.id, 'resolved')}
                              className="px-2 py-1 text-xs border border-[#dcdcdc] hover:border-emerald-500 hover:text-emerald-700 rounded-lg cursor-pointer"
                            >
                              Resolve
                            </button>
                          )}
                          {item.status !== 'ignored' && (
                            <button
                              type="button"
                              onClick={() => void handleSetStatus(item.id, 'ignored')}
                              className="px-2 py-1 text-xs border border-[#dcdcdc] hover:text-[#333] text-[#777] rounded-lg cursor-pointer"
                            >
                              Dismiss
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(item)}
                            className="p-1 text-[#888] hover:text-red-600 cursor-pointer"
                            title="Delete inbox item"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-[#444] whitespace-pre-wrap line-clamp-3 bg-[#fafafa] border border-[#f0f0f0] rounded-lg p-2.5">
                        {item.content}
                      </p>
                      {item.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {item.attachments.map((att) => (
                            <a
                              key={att.fileId}
                              href={blobUrl(att.fileId, true)}
                              download={att.filename}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f5f5f5] border border-[#e3e3e3] text-[11px] text-[#333] hover:text-[#c2542d]"
                            >
                              <Download size={10} />
                              <span className="max-w-[180px] truncate">{att.filename}</span>
                              <span className="text-[#888]">({att.sizeBytes}B)</span>
                            </a>
                          ))}
                        </div>
                      )}
                      {replyOpenId === item.id && (
                        <div className="border-t border-[#efefef] pt-2.5 space-y-2 text-xs">
                          <textarea
                            rows={2}
                            value={replyDraft}
                            onChange={(e) => setReplyDraft(e.target.value)}
                            placeholder="Optional custom reply text (leave empty to use agent resolution summary)..."
                            className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setReplyOpenId(null)}
                              className="px-2.5 py-1 border border-[#dcdcdc] rounded-lg cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={replySending}
                              onClick={() => void handleSendReply(item.id)}
                              className="px-2.5 py-1 bg-[#c2542d] text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer"
                            >
                              {replySending ? 'Sending...' : 'Send Reply'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: WEBHOOKS & PLUGINS */}
        {tab === 'webhooks' && (
          <div className="space-y-5">
            {createdHookSecret && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-amber-900 flex items-center gap-1.5">
                    <KeyRound size={14} />
                    <span>Webhook "{createdHookSecret.name}" secret is shown only once. Store it securely:</span>
                  </div>
                  <button type="button" onClick={() => setCreatedHookSecret(null)} className="text-amber-800 cursor-pointer">
                    <X size={14} />
                  </button>
                </div>
                <div className="font-mono bg-white border border-amber-200 rounded px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <span className="truncate">
                    POST {window.location.origin}/webhooks/generic/{createdHookSecret.id} · X-Webhook-Secret: {createdHookSecret.secret}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyText(createdHookSecret.secret)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 rounded text-amber-900 shrink-0 cursor-pointer"
                  >
                    {copiedSecret ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                    <span>{copiedSecret ? 'Secret Copied' : 'Copy Secret'}</span>
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleCreateWebhook} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
              <div className="text-xs font-medium text-[#333]">Create Generic Webhook Endpoint</div>
              <div className="flex gap-2">
                <input
                  required
                  value={hookName}
                  onChange={(e) => setHookName(e.target.value)}
                  placeholder="e.g. Production Alerts / Support Form"
                  className="flex-1 px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
                >
                  Create Webhook & Secret
                </button>
              </div>
            </form>

            <div className="bg-white border border-[#e5e5e5] rounded-xl divide-y divide-[#efefef]">
              {webhooks.length === 0 ? (
                <div className="p-6 text-center text-xs text-[#888]">No generic webhooks created yet</div>
              ) : (
                webhooks.map((w) => (
                  <div key={w.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-medium text-[#111]">{w.name}</div>
                      <div className="font-mono text-[11px] text-[#777] truncate">
                        POST {window.location.origin}/webhooks/generic/{w.id}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteWebhook(w.id)}
                      className="p-1.5 text-[#888] hover:text-red-600 cursor-pointer"
                      title="Delete webhook"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* SourcePlugin Registry & Instances */}
            <div className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
              <div className="text-xs font-medium text-[#333]">Channel Plugins (GitHub & Email IMAP/SMTP)</div>
              <form onSubmit={handleConfigurePlugin} className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2.5">
                  <select
                    value={pluginId}
                    onChange={(e) => setPluginId(e.target.value)}
                    className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                  >
                    {pluginDescriptors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <input
                    required
                    value={pluginName}
                    onChange={(e) => setPluginName(e.target.value)}
                    placeholder="Instance name (e.g. my-repo or support-mailbox)"
                    className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                  />
                </div>

                {pluginId === 'email-imap-smtp' ? (
                  <div className="space-y-2.5 border border-[#efefef] rounded-lg p-3 bg-[#fafafa]">
                    <div className="grid grid-cols-4 gap-2">
                      <input
                        required
                        value={imapHost}
                        onChange={(e) => setImapHost(e.target.value)}
                        placeholder="IMAP host (e.g. imap.gmail.com)"
                        className="col-span-2 px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <input
                        type="number"
                        value={imapPort}
                        onChange={(e) => setImapPort(Number(e.target.value))}
                        placeholder="IMAP port"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <label className="flex items-center gap-1.5 px-2 text-[#555] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={imapSecure}
                          onChange={(e) => setImapSecure(e.target.checked)}
                        />
                        <span>IMAP TLS</span>
                      </label>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        required
                        value={imapUser}
                        onChange={(e) => setImapUser(e.target.value)}
                        placeholder="IMAP username / email"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <input
                        required
                        type="password"
                        value={imapPass}
                        onChange={(e) => setImapPass(e.target.value)}
                        placeholder="IMAP password or env:EMAIL_PASS"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <input
                        value={imapMailbox}
                        onChange={(e) => setImapMailbox(e.target.value)}
                        placeholder="Mailbox (INBOX)"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <input
                        value={smtpHost}
                        onChange={(e) => setSmtpHost(e.target.value)}
                        placeholder="SMTP host (optional for reply)"
                        className="col-span-2 px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <input
                        type="number"
                        value={smtpPort}
                        onChange={(e) => setSmtpPort(Number(e.target.value))}
                        placeholder="SMTP port"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <label className="flex items-center gap-1.5 px-2 text-[#555] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={smtpSecure}
                          onChange={(e) => setSmtpSecure(e.target.checked)}
                        />
                        <span>SMTP TLS</span>
                      </label>
                    </div>
                    <input
                      value={fromAddress}
                      onChange={(e) => setFromAddress(e.target.value)}
                      placeholder="From address override (optional, defaults to IMAP username)"
                      className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                    />
                  </div>
                ) : pluginId === 'github-webhook' ? (
                  <div className="space-y-2 border border-[#efefef] rounded-lg p-3 bg-[#fafafa]">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={pluginSecret}
                        onChange={(e) => setPluginSecret(e.target.value)}
                        placeholder="Webhook HMAC Secret (optional)"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                      <input
                        value={ghRepo}
                        onChange={(e) => setGhRepo(e.target.value)}
                        placeholder="Repository owner/repo (optional for Pull)"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white font-mono"
                      />
                      <input
                        type="password"
                        value={ghToken}
                        onChange={(e) => setGhToken(e.target.value)}
                        placeholder="PAT token or env:GITHUB_TOKEN (optional)"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white font-mono"
                      />
                      <input
                        value={ghLabels}
                        onChange={(e) => setGhLabels(e.target.value)}
                        placeholder="Labels filter (comma-separated, optional)"
                        className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                      />
                    </div>
                    <label className="inline-flex items-center gap-1.5 text-[#555] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ghIncludePrs}
                        onChange={(e) => setGhIncludePrs(e.target.checked)}
                      />
                      <span>Include Pull Requests when polling</span>
                    </label>
                  </div>
                ) : (
                  <input
                    value={pluginSecret}
                    onChange={(e) => setPluginSecret(e.target.value)}
                    placeholder="Optional configuration secret"
                    className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                  />
                )}

                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5 text-[#555] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pluginAutoReply}
                      onChange={(e) => setPluginAutoReply(e.target.checked)}
                    />
                    <span>Auto-reply to external channel when resolved</span>
                  </label>
                  <button
                    type="submit"
                    className="px-3 py-1.5 bg-[#111] text-white rounded-lg cursor-pointer"
                  >
                    Create Plugin Instance
                  </button>
                </div>
              </form>
              {pluginInstances.length > 0 && (
                <div className="divide-y divide-[#f0f0f0] border-t border-[#efefef] pt-2">
                  {pluginInstances.map((inst) => {
                    const desc = pluginDescriptors.find((d) => d.id === inst.pluginId)
                    return (
                      <div key={inst.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-[#111]">{inst.name}</span>
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555]">
                              {inst.pluginId}
                            </span>
                            {desc?.supportsWebhook && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Webhook</span>
                            )}
                            {desc?.supportsPull && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">Pull</span>
                            )}
                            {desc?.supportsReply && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">Reply</span>
                            )}
                          </div>
                          {desc?.supportsWebhook && (
                            <div className="font-mono text-[11px] text-[#777] truncate">
                              POST {window.location.origin}/webhooks/{inst.pluginId}/{inst.id}
                            </div>
                          )}
                          {inst.lastSyncAt && (
                            <div className="text-[11px] text-[#888]">
                              Last sync: {new Date(inst.lastSyncAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {desc?.supportsPull && (
                            <button
                              type="button"
                              disabled={syncingInstanceId === inst.id}
                              onClick={() => void handleSyncPlugin(inst.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 border border-[#dcdcdc] hover:border-[#c2542d] rounded-md cursor-pointer disabled:opacity-50"
                            >
                              <RefreshCw size={11} className={syncingInstanceId === inst.id ? 'animate-spin' : ''} />
                              <span>{syncingInstanceId === inst.id ? 'Syncing...' : 'Sync Now'}</span>
                            </button>
                          )}
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                            {inst.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleDeletePluginInstance(inst.id, inst.name)}
                            className="p-1 text-[#888] hover:text-red-600 cursor-pointer"
                            title="Delete plugin instance"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: ROUTING RULES */}
        {tab === 'rules' && (
          <div className="space-y-4">
            <form onSubmit={handleCreateRule} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3 text-xs">
              <div className="font-medium text-[#333]">Add Auto-Routing Rule</div>
              <div className="grid grid-cols-4 gap-2.5">
                <input
                  required
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="Rule name *"
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                />
                <input
                  type="number"
                  value={rulePriority}
                  onChange={(e) => setRulePriority(Number(e.target.value))}
                  placeholder="Priority (lower first)"
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                />
                <input
                  value={ruleSourceFilter}
                  onChange={(e) => setRuleSourceFilter(e.target.value)}
                  placeholder="Source filter (blank=all, e.g. github)"
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg"
                />
                <select
                  value={ruleStrategyId}
                  onChange={(e) => setRuleStrategyId(e.target.value as 'single' | 'open-channel' | 'roundtable')}
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="single">1v1 Direct (single)</option>
                  <option value="open-channel">Open Channel (open-channel)</option>
                  <option value="roundtable">Roundtable (roundtable)</option>
                </select>
              </div>
              <div className="grid grid-cols-4 gap-2.5">
                <select
                  value={ruleMatchType}
                  onChange={(e) => setRuleMatchType(e.target.value as RoutingMatchType)}
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="keyword">keyword (comma-separated keywords)</option>
                  <option value="regex">regex (regular expression)</option>
                  <option value="meta_equals">meta_equals (key=value)</option>
                  <option value="always">always (match all)</option>
                </select>
                <input
                  value={ruleMatchExpr}
                  onChange={(e) => setRuleMatchExpr(e.target.value)}
                  placeholder={ruleMatchType === 'always' ? 'Leave blank to match all' : 'Match expression (e.g. urgent,bug)'}
                  className="col-span-2 px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg font-mono"
                />
                <select
                  value={ruleWorkspaceId}
                  onChange={(e) => setRuleWorkspaceId(e.target.value)}
                  className="px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                  title="Optional target workspace"
                >
                  <option value="">Default Agent Workspace</option>
                  {workspaces
                    .filter((w) => w.kind === 'project')
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        [Project] {w.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[#555]">Target Agents:</span>
                  {agents.map((a) => {
                    const checked = ruleAgentIds.includes(a.id)
                    return (
                      <label key={a.id} className="inline-flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setRuleAgentIds((prev) =>
                              prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                            )
                          }
                        />
                        <span>{a.name}</span>
                      </label>
                    )
                  })}
                  <label className="inline-flex items-center gap-1 text-amber-800 cursor-pointer ml-2">
                    <input
                      type="checkbox"
                      checked={ruleAllowWrite}
                      onChange={(e) => setRuleAllowWrite(e.target.checked)}
                    />
                    <ShieldAlert size={12} />
                    <span>Allow workspace writes (unchecked = default read-only Lockdown)</span>
                  </label>
                </div>
                <button type="submit" className="px-3 py-1.5 font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer">
                  Save Rule
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {routingRules.length === 0 ? (
                <div className="bg-white border border-[#e5e5e5] rounded-xl p-6 text-center text-xs text-[#888]">
                  No auto-routing rules yet. Incoming tickets will wait for manual assignment.
                </div>
              ) : (
                routingRules.map((r) => (
                  <div key={r.id} className="bg-white border border-[#e5e5e5] rounded-xl p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono px-1.5 py-0.5 rounded bg-[#f2f2f2]">P{r.priority}</span>
                        <span className="font-medium text-[#111]">{r.name}</span>
                        <span className="font-mono text-[#666]">{r.matchType}{r.matchExpr ? `: ${r.matchExpr}` : ''}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            r.allowWrite ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {r.allowWrite ? 'Workspace writable' : 'Default read-only Lockdown'}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#888]">
                        Target strategy: {r.action.strategyId || 'open-channel'} · Source filter: {r.sourceFilter || '*'}
                        {r.action.workspaceId
                          ? ` · Workspace: ${workspaces.find((w) => w.id === r.action.workspaceId)?.name || r.action.workspaceId}`
                          : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void toggleRuleEnabled(r.id)}
                        className={`px-2 py-1 rounded border cursor-pointer ${
                          r.enabled ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-[#dcdcdc] text-[#888]'
                        }`}
                      >
                        {r.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void rpc.call('routingRules.delete', { id: r.id }).then(() => refreshInbox())}
                        className="p-1 text-[#888] hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Assign Modal */}
      {assignTarget && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleAssignSubmit} className="w-full max-w-md bg-white rounded-xl border border-[#e5e5e5] p-5 space-y-3.5 shadow-lg text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Assign Ticket: {assignTarget.title}</h3>
              <button type="button" onClick={() => setAssignTarget(null)} className="text-[#777] cursor-pointer">
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 bg-[#f3f3f3] rounded-lg">
              <button
                type="button"
                onClick={() => setAssignMode('create_room')}
                className={`py-1.5 rounded-md font-medium cursor-pointer ${
                  assignMode === 'create_room' ? 'bg-white text-[#111]' : 'text-[#666]'
                }`}
              >
                New Room
              </button>
              <button
                type="button"
                onClick={() => setAssignMode('append_room')}
                className={`py-1.5 rounded-md font-medium cursor-pointer ${
                  assignMode === 'append_room' ? 'bg-white text-[#111]' : 'text-[#666]'
                }`}
              >
                Append to Existing Room
              </button>
            </div>

            {assignMode === 'create_room' ? (
              <div className="space-y-2.5">
                <div>
                  <label className="block text-[#555] mb-1">Collaboration Strategy</label>
                  <select
                    value={assignStrategyId}
                    onChange={(e) => setAssignStrategyId(e.target.value as 'single' | 'open-channel' | 'roundtable')}
                    className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                  >
                    <option value="single">1v1 Direct (single)</option>
                    <option value="open-channel">Open Channel (open-channel)</option>
                    <option value="roundtable">Roundtable (roundtable)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#555] mb-1">Assign Agents</label>
                  <div className="max-h-32 overflow-y-auto border border-[#dcdcdc] rounded-lg divide-y divide-[#efefef]">
                    {agents.map((a) => {
                      const checked = assignAgentIds.includes(a.id)
                      return (
                        <label key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setAssignAgentIds((prev) =>
                                prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                              )
                            }
                          />
                          <span>{a.name}</span>
                          <span className="font-mono text-[10px] text-[#888]">{a.driverKind}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-[#555] mb-1">Workspace (optional)</label>
                  <select
                    value={assignWorkspaceId}
                    onChange={(e) => setAssignWorkspaceId(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                  >
                    <option value="">Default</option>
                    {workspaces
                      .filter((w) => w.kind === 'project')
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          [Project] {w.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-[#555] mb-1">Select Existing Room</label>
                <select
                  value={assignRoomId}
                  onChange={(e) => setAssignRoomId(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-[#dcdcdc] rounded-lg bg-white"
                >
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title} ({r.strategyId})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="flex items-center gap-1.5 text-amber-800 cursor-pointer">
              <input
                type="checkbox"
                checked={assignAllowWrite}
                onChange={(e) => setAssignAllowWrite(e.target.checked)}
              />
              <ShieldAlert size={12} />
              <span>Allow workspace modifications (unchecked = default read-only Lockdown)</span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAssignTarget(null)} className="px-3 py-1.5 border border-[#dcdcdc] rounded-lg cursor-pointer">
                Cancel
              </button>
              <button type="submit" className="px-3 py-1.5 font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer">
                Assign & Start
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
