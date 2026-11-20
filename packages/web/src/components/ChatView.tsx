import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  EyeOff,
  FastForward,
  FileText,
  Folder,
  Gauge,
  Inbox as InboxIcon,
  Layers,
  ListTree,
  Loader2,
  Paperclip,
  Pause,
  Play,
  Reply,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  pickLatestRetryableNode,
  type FileRef,
  type NodeEvent,
  type RoomMember,
  type RoomMessage,
  type TurnUsage,
  type WorkNode
} from '@myagents/protocol'
import { apiUploadBlob, blobUrl } from '../api/rpc-client'
import { useAppStore, type LiveToolStep, type LiveTurnBuffer } from '../store/app-store'

const SAFE_PREVIEW_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function AttachmentList({ attachments, alignRight }: { attachments?: FileRef[]; alignRight?: boolean }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className={`mt-1.5 flex flex-wrap gap-2 ${alignRight ? 'justify-end' : 'justify-start'}`}>
      {attachments.map((att) => {
        const isImg = SAFE_PREVIEW_IMAGES.has(att.mime)
        return (
          <div
            key={att.fileId}
            className="border border-[#e3e3e3] bg-white rounded-lg p-1.5 text-[11px] text-[#333] max-w-[240px]"
          >
            {isImg && (
              <a href={blobUrl(att.fileId)} target="_blank" rel="noreferrer" className="block mb-1">
                <img
                  src={blobUrl(att.fileId)}
                  alt={att.filename}
                  className="max-h-32 max-w-full rounded object-contain bg-[#fafafa]"
                />
              </a>
            )}
            <a
              href={blobUrl(att.fileId, true)}
              download={att.filename}
              className="flex items-center gap-1.5 hover:text-[#c2542d]"
              title={`Download ${att.filename}`}
            >
              <Download size={11} className="shrink-0" />
              <span className="truncate font-medium">{att.filename}</span>
              <span className="text-[#888] shrink-0">({formatBytes(att.sizeBytes)})</span>
            </a>
          </div>
        )
      })}
    </div>
  )
}

function formatTokens(n?: number | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '0.0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(0)
  return `${m}m ${s}s`
}

function formatCost(usd?: number | null): string | null {
  if (usd === undefined || usd === null || !Number.isFinite(usd) || usd <= 0) return null
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`
}

function extractThinkingText(events: NodeEvent[]): string {
  const parts: string[] = []
  for (const ev of events) {
    if (ev.kind === 'thinking') {
      const text = typeof ev.payload.text === 'string'
        ? ev.payload.text
        : typeof ev.payload.delta === 'string'
          ? ev.payload.delta
          : ''
      if (text.trim()) parts.push(text.trim())
    }
  }
  return parts.join('\n\n---\n\n')
}

function eventsToSteps(events: NodeEvent[]): LiveToolStep[] {
  const map = new Map<string, LiveToolStep>()
  const order: string[] = []
  for (const ev of events) {
    if (ev.kind === 'tool_start') {
      const id = String(ev.payload.id || ev.id)
      if (!map.has(id)) order.push(id)
      map.set(id, {
        id,
        name: String(ev.payload.name || 'tool'),
        input: ev.payload.input,
        done: false
      })
    } else if (ev.kind === 'tool_result') {
      const id = String(ev.payload.id || '')
      const existing = map.get(id)
      if (existing) {
        existing.output = String(ev.payload.output ?? '')
        existing.isError = Boolean(ev.payload.isError)
        existing.done = true
      }
    }
  }
  return order.map((id) => map.get(id)!)
}

function ThinkingCollapse({
  thinking,
  streaming,
  thinkingTokens
}: {
  thinking: string
  streaming?: boolean
  thinkingTokens?: number
}) {
  const [open, setOpen] = useState(Boolean(streaming))
  if (!thinking.trim()) return null

  return (
    <div className="my-2 border border-[#e6e2dc] rounded-lg bg-[#faf8f5] text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[#665b50] hover:text-[#222] cursor-pointer"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
          <Brain size={12} className={`shrink-0 ${streaming ? 'text-[#c2542d] animate-pulse' : 'text-[#8a7968]'}`} />
          <span className="font-medium">{streaming ? 'Thinking (CoT)...' : 'Thinking Process (CoT)'}</span>
          <span className="text-[11px] text-[#998d80]">
            · {thinking.length} chars
            {thinkingTokens ? ` · ${formatTokens(thinkingTokens)} tok` : ''}
          </span>
        </span>
        {streaming && <Loader2 size={12} className="animate-spin text-[#c2542d] shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-[#ede8e0] px-3 py-2">
          <div className="border-l-2 border-[#c2542d]/35 pl-2.5 text-[12px] leading-relaxed text-[#5c534a] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
            {thinking}
          </div>
        </div>
      )}
    </div>
  )
}

function ToolStepsCollapse({ steps }: { steps: Array<{ id: string; name: string; input?: unknown; output?: string; isError?: boolean; done: boolean }> }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="my-2 border border-[#e6e6e6] rounded-lg bg-[#fafafa] text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[#555] hover:text-[#111] cursor-pointer"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={12} />
        <span>Tool calls · {steps.length} steps</span>
        {steps.some((s) => !s.done) && <Loader2 size={12} className="animate-spin text-[#c2542d]" />}
      </button>
      {open && (
        <div className="border-t border-[#eaeaea] divide-y divide-[#efefef]">
          {steps.map((s) => (
            <div key={s.id} className="p-2.5 space-y-1">
              <div className="flex items-center gap-2 font-mono text-[11px] font-medium">
                <span className={s.isError ? 'text-red-600' : 'text-[#222]'}>{s.name}</span>
                {!s.done && <span className="text-[#c2542d]">Running...</span>}
              </div>
              {s.input !== undefined && (
                <pre className="bg-white border border-[#ececec] rounded p-1.5 overflow-x-auto text-[11px] text-[#444]">
                  {typeof s.input === 'string' ? s.input : JSON.stringify(s.input, null, 2)}
                </pre>
              )}
              {s.output !== undefined && (
                <pre
                  className={`border rounded p-1.5 overflow-x-auto max-h-48 text-[11px] whitespace-pre-wrap ${
                    s.isError ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-[#ececec] text-[#333]'
                  }`}
                >
                  {s.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TurnMetricsBar({
  usage,
  liveElapsedMs,
  liveEstimatedTps
}: {
  usage?: TurnUsage | null
  liveElapsedMs?: number
  liveEstimatedTps?: number
}) {
  const durationMs = liveElapsedMs ?? usage?.durationMs
  const tps = usage?.tokensPerSec ?? liveEstimatedTps
  const isEstimated = !usage?.tokensPerSec && liveEstimatedTps !== undefined
  const cost = formatCost(usage?.costUsd)

  const hasAny =
    durationMs !== undefined ||
    tps !== undefined ||
    usage?.inputTokens !== undefined ||
    usage?.outputTokens !== undefined ||
    usage?.contextUsedTokens !== undefined ||
    usage?.thinkingTokens !== undefined ||
    Boolean(cost)

  if (!hasAny) return null

  const ctxPct =
    usage?.contextUsedTokens && usage?.contextWindow
      ? Math.min(100, (usage.contextUsedTokens / usage.contextWindow) * 100)
      : null

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-[#888] font-mono select-text">
      {durationMs !== undefined && (
        <span className="inline-flex items-center gap-1" title="Turn execution duration">
          <Clock size={11} className="text-[#999]" />
          <span>{formatDuration(durationMs)}</span>
          {usage?.ttftMs !== undefined && (
            <span className="text-[#aaa]" title="Time to first token (TTFT)">
              (TTFT {formatDuration(usage.ttftMs)})
            </span>
          )}
        </span>
      )}

      {tps !== undefined && tps > 0 && (
        <span className="inline-flex items-center gap-1" title={isEstimated ? 'Live estimated output speed' : 'Output token rate'}>
          <Zap size={11} className="text-amber-600/80" />
          <span>{isEstimated ? `~${tps.toFixed(1)}` : tps.toFixed(1)} tok/s</span>
        </span>
      )}

      {(usage?.inputTokens !== undefined || usage?.outputTokens !== undefined || usage?.cacheReadTokens) && (
        <span title="Turn token usage (input / output)">
          {usage.inputTokens !== undefined && (
            <>
              <span>In {formatTokens(usage.inputTokens)}</span>
              {usage.cacheReadTokens ? <span className="text-[#aaa]"> (+{formatTokens(usage.cacheReadTokens)} cached)</span> : null}
            </>
          )}
          {usage.inputTokens !== undefined && usage.outputTokens !== undefined && <span className="mx-1 text-[#ccc]">/</span>}
          {usage.outputTokens !== undefined && (
            <>
              <span>Out {formatTokens(usage.outputTokens)}</span>
              {usage.thinkingTokens ? <span className="text-[#9a7b5c]"> (Thinking {formatTokens(usage.thinkingTokens)})</span> : null}
            </>
          )}
        </span>
      )}

      {usage?.contextUsedTokens !== undefined && usage.contextUsedTokens > 0 && (
        <span className="inline-flex items-center gap-1" title="Current context usage">
          <Layers size={11} className="text-[#999]" />
          <span>
            Context {formatTokens(usage.contextUsedTokens)}
            {usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)} (${ctxPct!.toFixed(1)}%)` : ''}
          </span>
        </span>
      )}

      {usage?.model && <span className="text-[#999]">{usage.model}</span>}
      {cost && <span className="text-[#999]">{cost}</span>}
    </div>
  )
}

function computeLiveMetrics(turn: LiveTurnBuffer, now: number): { elapsedMs: number; estimatedTps?: number } {
  const elapsedMs = Math.max(0, now - turn.startedAt)
  let estimatedTps: number | undefined
  if (!turn.usage?.tokensPerSec && turn.firstTokenAt && turn.outputChars >= 12) {
    const genSec = Math.max(0.2, (now - turn.firstTokenAt) / 1000)
    // Rough CJK/ASCII mixed estimate (~2.6 chars per token)
    const estTokens = turn.outputChars / 2.6
    estimatedTps = Number((estTokens / genSec).toFixed(1))
  }
  return { elapsedMs, estimatedTps }
}

export function ChatView({ onOpenNewChat }: { onOpenNewChat: () => void }) {
  const currentRoom = useAppStore((s) => s.currentRoom)
  const agents = useAppStore((s) => s.agents)
  const workspaces = useAppStore((s) => s.workspaces)
  const messagesByRoom = useAppStore((s) => s.messagesByRoom)
  const workNodesByRoom = useAppStore((s) => s.workNodesByRoom)
  const nodeEventsByNode = useAppStore((s) => s.nodeEventsByNode)
  const liveTurnsByRoom = useAppStore((s) => s.liveTurnsByRoom)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const controlNode = useAppStore((s) => s.controlNode)
  const controlRoom = useAppStore((s) => s.controlRoom)
  const handoffRoom = useAppStore((s) => s.handoffRoom)
  const setDockTab = useAppStore((s) => s.setDockTab)

  const [draft, setDraft] = useState('')
  const [replyTarget, setReplyTarget] = useState<RoomMessage | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<FileRef[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffTitle, setHandoffTitle] = useState('')
  const [handoffSeedText, setHandoffSeedText] = useState('')
  const [handoffStrategy, setHandoffStrategy] = useState<'open-channel' | 'single'>('open-channel')
  const [handoffWorkspaceId, setHandoffWorkspaceId] = useState('')
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const roomId = currentRoom?.id
  const messages = roomId ? (messagesByRoom[roomId] ?? []) : []
  const nodes = roomId ? (workNodesByRoom[roomId] ?? []) : []
  const liveTurns = roomId ? Object.values(liveTurnsByRoom[roomId] ?? {}) : []
  const activeNode = nodes.find((n) => ['queued', 'waiting_lock', 'starting', 'running'].includes(n.status))
  const retryableNode = !activeNode ? pickLatestRetryableNode(nodes) : undefined
  const ws = workspaces.find((w) => w.id === currentRoom?.primaryWorkspaceId)
  const isMultiAgent = Boolean(currentRoom && currentRoom.strategyId !== 'single')
  const primaryMember = currentRoom?.members[0]
  const primaryAgent = agents.find((a) => a.id === primaryMember?.agentId)
  const memberById = useMemo(() => {
    const m = new Map<string, RoomMember>()
    for (const mem of currentRoom?.members ?? []) m.set(mem.id, mem)
    return m
  }, [currentRoom])
  const msgById = useMemo(() => {
    const m = new Map<string, RoomMessage>()
    for (const msg of messages) m.set(msg.id, msg)
    return m
  }, [messages])

  // Live clock tick only while a turn is actively executing
  const isRunning = Boolean(activeNode || liveTurns.length > 0)
  useEffect(() => {
    if (!isRunning) return
    setNowTick(Date.now())
    const timer = setInterval(() => setNowTick(Date.now()), 200)
    return () => clearInterval(timer)
  }, [isRunning])

  const nodeById = useMemo(() => {
    const map = new Map<string, WorkNode>()
    for (const n of nodes) map.set(n.id, n)
    return map
  }, [nodes])

  // Aggregate session telemetry (latest context, speed, cumulative tokens & cost)
  const sessionStats = useMemo(() => {
    const liveTurn = liveTurns[0]
    let latestUsage: TurnUsage | null = liveTurn?.usage ?? null
    let totalIn = 0
    let totalOut = 0
    let totalCost = 0
    let lastDurationMs: number | undefined

    // nodes are ordered DESC by created_at in backend
    for (const n of nodes) {
      if (n.usage) {
        if (!latestUsage) latestUsage = n.usage
        if (lastDurationMs === undefined && n.usage.durationMs !== undefined) {
          lastDurationMs = n.usage.durationMs
        }
        totalIn += (n.usage.inputTokens ?? 0) + (n.usage.cacheReadTokens ?? 0) + (n.usage.cacheCreationTokens ?? 0)
        totalOut += n.usage.outputTokens ?? 0
        totalCost += n.usage.costUsd ?? 0
      } else if (lastDurationMs === undefined && n.startedAt && n.endedAt) {
        lastDurationMs = Math.max(0, n.endedAt - n.startedAt)
      }
    }

    const liveMetrics = liveTurn ? computeLiveMetrics(liveTurn, nowTick) : null
    const model = latestUsage?.model || primaryAgent?.driverConfig.model || undefined
    const contextUsed = latestUsage?.contextUsedTokens
    const contextWindow = latestUsage?.contextWindow
    const contextPct =
      contextUsed && contextWindow ? Math.min(100, (contextUsed / contextWindow) * 100) : null
    const speed = latestUsage?.tokensPerSec ?? liveMetrics?.estimatedTps
    const isEstimatedSpeed = !latestUsage?.tokensPerSec && liveMetrics?.estimatedTps !== undefined
    const displayDurationMs = liveMetrics
      ? liveMetrics.elapsedMs
      : activeNode?.startedAt
        ? Math.max(0, nowTick - activeNode.startedAt)
        : lastDurationMs

    return {
      model,
      contextUsed,
      contextWindow,
      contextPct,
      speed,
      isEstimatedSpeed,
      displayDurationMs,
      totalIn,
      totalOut,
      totalCost
    }
  }, [liveTurns, nodes, nowTick, activeNode, primaryAgent])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, liveTurns.map((t) => t.text.length + t.thinking.length + t.tools.length).join(',')])

  useEffect(() => {
    setReplyTarget(null)
    setPendingAttachments([])
    setUploadError(null)
    setHandoffOpen(false)
    setHandoffError(null)
  }, [roomId])

  const isRoundtable = currentRoom?.strategyId === 'roundtable'
  const rtConfig = (currentRoom?.strategyConfig ?? {}) as {
    maxRounds?: number
    blindFirstRound?: boolean
    anonymous?: boolean
    autoAdvance?: boolean
  }
  const rtState = (currentRoom?.strategyState ?? {}) as {
    phase?: string
    currentRound?: number
    currentSuperstep?: number
  }
  const rtPhaseBusyOrDone =
    !rtState.phase || rtState.phase === 'idle' || rtState.phase === 'done' || rtState.phase === 'summarizing'

  if (!currentRoom) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[#666]">
        <p className="text-sm">No active room open</p>
        <p className="text-xs text-[#999] mt-1">Configure a model provider and agent on the left, then start a new chat</p>
        <button
          type="button"
          onClick={onOpenNewChat}
          className="mt-4 px-4 py-2 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
        >
          New Room
        </button>
      </div>
    )
  }

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploadError(null)
    setUploading(true)
    try {
      const uploaded: FileRef[] = []
      for (const file of Array.from(files)) {
        uploaded.push(await apiUploadBlob(file))
      }
      setPendingAttachments((prev) => [...prev, ...uploaded].slice(0, 10))
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Attachment upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleSend = async () => {
    const text = draft.trim()
    if ((!text && pendingAttachments.length === 0) || sending || uploading) return
    const replyId = replyTarget?.id
    const attachmentsToSend = pendingAttachments
    setDraft('')
    setReplyTarget(null)
    setPendingAttachments([])
    setUploadError(null)
    setSending(true)
    try {
      await sendMessage(
        currentRoom.id,
        text,
        replyId,
        attachmentsToSend.map((a) => a.fileId)
      )
    } catch (err) {
      setDraft(text)
      setPendingAttachments(attachmentsToSend)
      alert(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const insertMention = (mentionText: string) => {
    setDraft((prev) => {
      const trimmed = prev.trimStart()
      return trimmed.startsWith(`${mentionText} `) ? prev : `${mentionText} ${prev}`
    })
  }

  const copySessionPath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath)
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  const sessionFilePath = primaryMember?.sessionFilePath || null
  const showTelemetryBar =
    Boolean(sessionFilePath) ||
    Boolean(sessionStats.model) ||
    Boolean(sessionStats.contextUsed) ||
    sessionStats.displayDurationMs !== undefined ||
    sessionStats.totalOut > 0

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="h-12 px-4 border-b border-[#ececec] flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
          <h2 className="text-sm font-medium text-[#111] truncate">{currentRoom.title}</h2>
          {!isMultiAgent && primaryMember && (
            <span className="text-[11px] px-2 py-0.5 rounded bg-[#c2542d]/10 text-[#c2542d] shrink-0 whitespace-nowrap">
              {primaryMember.displayName} · {primaryMember.driverKind}
            </span>
          )}
          {isMultiAgent && (
            <div className="flex items-center gap-1 overflow-x-auto">
              {currentRoom.members.map((mem) => {
                const memRunning = nodes.some(
                  (n) => n.assigneeMemberId === mem.id && ['starting', 'running'].includes(n.status)
                )
                return (
                  <button
                    key={mem.id}
                    type="button"
                    onClick={() => insertMention(`@${mem.displayName}`)}
                    title={`Click to insert @${mem.displayName} (${mem.driverKind ?? 'agent'} · ${mem.roleKind})`}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[#f4f4f4] hover:bg-[#c2542d]/10 hover:text-[#c2542d] text-[#444] shrink-0 whitespace-nowrap cursor-pointer"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        memRunning ? 'bg-[#c2542d] animate-pulse' : 'bg-[#bbb]'
                      }`}
                    />
                    <span>@{mem.displayName}</span>
                    {mem.roleKind === 'chair' && <span className="text-[9px] text-indigo-700 font-medium">Chair</span>}
                    {mem.roleKind === 'lead' && <span className="text-[9px] text-[#c2542d] font-medium">Lead</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[#666] shrink-0">
          {isRoundtable && (
            <>
              <span
                className={`text-[11px] px-2 py-0.5 rounded font-medium whitespace-nowrap ${
                  rtState.phase === 'paused_partial_failure'
                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                    : rtState.phase === 'done'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                }`}
              >
                Round {rtState.currentRound ?? 0}/{rtConfig.maxRounds ?? 2}
                {rtState.phase === 'paused_partial_failure'
                  ? ' · Partial failure'
                  : rtState.phase === 'summarizing'
                    ? ' · Summarizing'
                    : rtState.phase === 'done'
                      ? ' · Concluded'
                      : ''}
              </span>
              <button
                type="button"
                disabled={rtPhaseBusyOrDone}
                onClick={() => void controlRoom(currentRoom.id, 'next_round')}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                title="Advance to next discussion round"
              >
                <FastForward size={13} />
                <span>Next Round</span>
              </button>
              <button
                type="button"
                disabled={rtPhaseBusyOrDone}
                onClick={() => void controlRoom(currentRoom.id, 'summarize_now')}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                title="Request immediate Chair summary"
              >
                <Sparkles size={13} className="text-indigo-600" />
                <span>Summarize Now</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const latestSummary = [...messages]
                    .reverse()
                    .find((msg) => msg.authorKind === 'agent' && (msg.kind === 'summary' || msg.kind === 'result' || msg.kind === 'chat'))
                  setHandoffTitle(`${currentRoom.title} - Execution`)
                  setHandoffWorkspaceId(currentRoom.primaryWorkspaceId ?? '')
                  setHandoffSeedText(latestSummary?.content ?? '')
                  setHandoffStrategy('open-channel')
                  setHandoffError(null)
                  setHandoffOpen(true)
                }}
                className="flex items-center gap-1 px-2 py-1 rounded bg-[#c2542d]/10 text-[#c2542d] hover:bg-[#c2542d]/15 cursor-pointer whitespace-nowrap shrink-0 font-medium"
                title="Hand off roundtable conclusion to a new execution room"
              >
                <ArrowRightLeft size={13} />
                <span>Hand Off Execution</span>
              </button>
            </>
          )}
          {isMultiAgent && (
            <>
              <button
                type="button"
                onClick={() =>
                  void controlRoom(currentRoom.id, currentRoom.state === 'paused' ? 'resume' : 'pause')
                }
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] cursor-pointer whitespace-nowrap shrink-0"
                title={currentRoom.state === 'paused' ? 'Resume channel scheduling' : 'Pause channel scheduling'}
              >
                {currentRoom.state === 'paused' ? <Play size={13} className="text-emerald-600" /> : <Pause size={13} />}
                <span>{currentRoom.state === 'paused' ? 'Resume' : 'Pause'}</span>
              </button>
              <button
                type="button"
                onClick={() => setDockTab('tasks')}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] cursor-pointer whitespace-nowrap shrink-0"
                title="Inspect task node tree"
              >
                <ListTree size={13} className="shrink-0" />
                <span>Tasks</span>
              </button>
            </>
          )}
          {ws && (
            <button
              type="button"
              onClick={() => setDockTab('files')}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] cursor-pointer whitespace-nowrap"
              title={ws.rootPath}
            >
              <Folder size={13} className="shrink-0" />
              <span className="max-w-[110px] truncate">{ws.name}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setDockTab('terminal')}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[#f2f2f2] cursor-pointer whitespace-nowrap shrink-0"
          >
            <Terminal size={13} className="shrink-0" />
            <span>Terminal</span>
          </button>
        </div>
      </div>

      {/* Session Telemetry & JSONL Path Strip */}
      {showTelemetryBar && (
        <div className="px-4 py-1.5 bg-[#fafafa] border-b border-[#efefef] flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-[#666] font-mono shrink-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            {sessionStats.model && (
              <span className="text-[#333] font-medium truncate max-w-[200px]" title={`Model: ${sessionStats.model}`}>
                {sessionStats.model}
              </span>
            )}

            {sessionStats.contextUsed !== undefined && sessionStats.contextUsed > 0 && (
              <span className="inline-flex items-center gap-1.5" title="Current context window usage">
                <Layers size={11} className="text-[#888] shrink-0" />
                <span>
                  Context {formatTokens(sessionStats.contextUsed)}
                  {sessionStats.contextWindow ? ` / ${formatTokens(sessionStats.contextWindow)}` : ''}
                  {sessionStats.contextPct !== null ? ` (${sessionStats.contextPct.toFixed(1)}%)` : ''}
                </span>
                {sessionStats.contextPct !== null && (
                  <span className="w-12 h-1.5 rounded-full bg-[#e6e6e6] overflow-hidden inline-block">
                    <span
                      className={`block h-full rounded-full ${
                        sessionStats.contextPct >= 85
                          ? 'bg-red-500'
                          : sessionStats.contextPct >= 60
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.max(2, sessionStats.contextPct)}%` }}
                    />
                  </span>
                )}
              </span>
            )}

            {sessionStats.speed !== undefined && sessionStats.speed > 0 && (
              <span className="inline-flex items-center gap-1" title={sessionStats.isEstimatedSpeed ? 'Live estimated speed' : 'Token output speed'}>
                <Gauge size={11} className="text-amber-600/80 shrink-0" />
                <span>
                  {sessionStats.isEstimatedSpeed ? `~${sessionStats.speed.toFixed(1)}` : sessionStats.speed.toFixed(1)} tok/s
                </span>
              </span>
            )}

            {sessionStats.displayDurationMs !== undefined && (
              <span className="inline-flex items-center gap-1" title={isRunning ? 'Current turn elapsed time' : 'Last turn duration'}>
                <Clock size={11} className="text-[#888] shrink-0" />
                <span>{formatDuration(sessionStats.displayDurationMs)}</span>
              </span>
            )}

            {(sessionStats.totalIn > 0 || sessionStats.totalOut > 0) && (
              <span className="text-[#888]" title="Cumulative session token usage">
                Total {formatTokens(sessionStats.totalIn)} in / {formatTokens(sessionStats.totalOut)} out
                {formatCost(sessionStats.totalCost) ? ` · ${formatCost(sessionStats.totalCost)}` : ''}
              </span>
            )}
          </div>

          {/* Only shown when the agent session is persisted as a JSONL file on disk (hidden for DB-backed agents) */}
          {sessionFilePath && (
            <div className="flex items-center gap-1 min-w-0 max-w-full">
              <FileText size={11} className="text-[#888] shrink-0" />
              <span className="text-[#888] shrink-0">Session:</span>
              <span
                className="text-[#444] truncate max-w-[320px]"
                title={sessionFilePath}
              >
                {sessionFilePath}
              </span>
              <button
                type="button"
                onClick={() => void copySessionPath(sessionFilePath)}
                className="p-0.5 text-[#777] hover:text-[#111] rounded hover:bg-[#ececec] cursor-pointer shrink-0"
                title="Copy JSONL session transcript path"
              >
                {copiedPath ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-[820px] mx-auto space-y-5">
          {messages.length === 0 && liveTurns.length === 0 && (
            <div className="text-center text-xs text-[#999] py-12">
              Send the first message to start talking. Workspace path: <code className="font-mono">{ws?.rootPath}</code>
            </div>
          )}

          {messages.map((m) => {
            const isHuman = m.authorKind === 'human'
            const isSystem = m.authorKind === 'system'
            const persistedEvents = m.workNodeId ? (nodeEventsByNode[m.workNodeId] ?? []) : []
            const steps = eventsToSteps(persistedEvents)
            const persistedThinking = extractThinkingText(persistedEvents)
            const matchedNode = m.workNodeId ? nodeById.get(m.workNodeId) : undefined
            const msgUsage = (m.meta?.usage as TurnUsage | undefined) ?? matchedNode?.usage ?? null
            const fallbackDuration =
              !msgUsage?.durationMs && matchedNode?.startedAt && matchedNode?.endedAt
                ? Math.max(0, matchedNode.endedAt - matchedNode.startedAt)
                : undefined
            const mergedUsage: TurnUsage | null =
              msgUsage || fallbackDuration !== undefined
                ? { ...(msgUsage ?? {}), durationMs: msgUsage?.durationMs ?? fallbackDuration }
                : null

            const repliedMsg = m.replyToMsgId ? msgById.get(m.replyToMsgId) : undefined
            const isIntake = m.authorKind === 'intake' || m.kind === 'intake_seed'

            if (isIntake) {
              return (
                <div key={m.id} className="rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-amber-900">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <InboxIcon size={12} />
                      <span>Inbox Ticket</span>
                      <span className="font-mono text-[10px] opacity-75">#{`m${m.seq}`}</span>
                      <span className="text-[11px] opacity-85">{m.authorName}</span>
                    </span>
                    <span className="text-[10px] opacity-75">{new Date(m.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-sm text-[#222] whitespace-pre-wrap">{m.content}</div>
                  <AttachmentList attachments={m.attachments} />
                </div>
              )
            }

            if (isHuman) {
              return (
                <div key={m.id} className="flex flex-col items-end gap-1">
                  {repliedMsg && (
                    <div className="text-[11px] text-[#777] bg-[#f8f8f8] border border-[#e8e8e8] px-2 py-0.5 rounded max-w-[75%] truncate">
                      Reply #{`m${repliedMsg.seq}`} {repliedMsg.authorName}: {repliedMsg.content}
                    </div>
                  )}
                  <div className="max-w-[82%] bg-[#f2f2f2] text-[#111] text-sm px-3.5 py-2.5 rounded-xl whitespace-pre-wrap">
                    <span className="text-[10px] text-[#999] font-mono mr-1.5">#m{m.seq}</span>
                    {m.content}
                  </div>
                  <AttachmentList attachments={m.attachments} alignRight />
                </div>
              )
            }

            if (isSystem) {
              const isNotice = m.kind === 'routing_notice'
              return (
                <div
                  key={m.id}
                  className={`text-xs rounded-lg px-3 py-2 border ${
                    isNotice
                      ? 'text-[#555] bg-[#fafafa] border-[#e6e6e6]'
                      : 'text-red-700 bg-red-50 border-red-200'
                  }`}
                >
                  <span className="text-[10px] font-mono opacity-60 mr-1.5">#m{m.seq}</span>
                  {m.content}
                </div>
              )
            }

            return (
              <div key={m.id} className="group space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs text-[#666]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-[#999]">#m{m.seq}</span>
                    <span className="font-medium text-[#111]">{m.authorName}</span>
                    {m.kind === 'result' && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700">
                        Submitted
                      </span>
                    )}
                    {m.kind === 'summary' && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 font-medium">
                        Roundtable Summary
                      </span>
                    )}
                    {m.visibilityScope === 'private' && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.2 rounded bg-amber-50 text-amber-700">
                        <EyeOff size={10} />
                        <span>Blind · Pending Reveal</span>
                      </span>
                    )}
                    <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {isMultiAgent && (
                    <button
                      type="button"
                      onClick={() => setReplyTarget(m)}
                      className="hidden group-hover:inline-flex items-center gap-1 text-[11px] text-[#777] hover:text-[#c2542d] cursor-pointer"
                      title="Reply to this message"
                    >
                      <Reply size={11} />
                      <span>Reply</span>
                    </button>
                  )}
                </div>
                {repliedMsg && (
                  <div className="text-[11px] text-[#777] border-l-2 border-[#ddd] pl-2 truncate">
                    Reply #m{repliedMsg.seq} ({repliedMsg.authorName}): {repliedMsg.content}
                  </div>
                )}
                <ThinkingCollapse thinking={persistedThinking} thinkingTokens={mergedUsage?.thinkingTokens} />
                <ToolStepsCollapse steps={steps} />
                <div className="markdown-body text-sm text-[#111]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
                <AttachmentList attachments={m.attachments} />
                <TurnMetricsBar usage={mergedUsage} />
              </div>
            )
          })}

          {/* Streaming live turns */}
          {liveTurns.map((turn) => {
            const { elapsedMs, estimatedTps } = computeLiveMetrics(turn, nowTick)
            const liveAuthor = memberById.get(turn.memberId)?.displayName || primaryMember?.displayName || 'Agent'
            return (
              <div key={turn.workNodeId} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-[#c2542d]">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="font-medium">{liveAuthor}</span>
                  <span>Running...</span>
                </div>
                <ThinkingCollapse
                  thinking={turn.thinking}
                  streaming={!turn.text}
                  thinkingTokens={turn.usage?.thinkingTokens}
                />
                <ToolStepsCollapse steps={turn.tools} />
                {turn.text && (
                  <div className="markdown-body text-sm text-[#111]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
                  </div>
                )}
                <TurnMetricsBar usage={turn.usage} liveElapsedMs={elapsedMs} liveEstimatedTps={estimatedTps} />
              </div>
            )
          })}

          {/* Running state before first stream chunk */}
          {activeNode && liveTurns.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-[#666]">
              <Loader2 size={13} className="animate-spin text-[#c2542d]" />
              <span>Node status: {activeNode.status}...</span>
              {activeNode.startedAt && (
                <span className="font-mono text-[11px] text-[#999]">
                  ({formatDuration(Math.max(0, nowTick - activeNode.startedAt))})
                </span>
              )}
            </div>
          )}

          {/* Retry bar for failed/paused node */}
          {retryableNode && (
            <div className="flex items-center justify-between bg-[#fafafa] border border-[#e5e5e5] rounded-lg px-3 py-2 text-xs">
              <span className="text-[#555]">
                Last turn status: <strong>{retryableNode.status}</strong>
                {retryableNode.errorText ? ` (${retryableNode.errorText})` : ''}
              </span>
              <button
                type="button"
                onClick={() => void controlNode(retryableNode.id, 'retry')}
                className="flex items-center gap-1 px-2.5 py-1 bg-white border border-[#d8d8d8] hover:border-[#c2542d] rounded-md text-[#111] cursor-pointer"
              >
                <RotateCcw size={12} />
                <span>Retry</span>
              </button>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-[#ececec] bg-white shrink-0">
        <div className="max-w-[820px] mx-auto space-y-1.5">
          {replyTarget && (
            <div className="flex items-center justify-between text-[11px] bg-[#fafafa] border border-[#e5e5e5] rounded-lg px-2.5 py-1 text-[#555]">
              <span className="truncate">
                Replying to <strong>#m{replyTarget.seq}</strong> (@{replyTarget.authorName}): {replyTarget.content}
              </span>
              <button
                type="button"
                onClick={() => setReplyTarget(null)}
                className="p-0.5 text-[#888] hover:text-[#111] cursor-pointer shrink-0"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {isMultiAgent && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => insertMention('@everyone')}
                className="px-2 py-0.5 rounded bg-[#f3f3f3] hover:bg-[#e8e8e8] text-[#444] font-mono cursor-pointer"
              >
                @everyone
              </button>
              {currentRoom.members.map((mem) => (
                <button
                  key={mem.id}
                  type="button"
                  onClick={() => insertMention(`@${mem.displayName}`)}
                  className="px-2 py-0.5 rounded bg-[#f3f3f3] hover:bg-[#c2542d]/10 hover:text-[#c2542d] text-[#444] font-mono cursor-pointer"
                >
                  @{mem.displayName}
                </button>
              ))}
            </div>
          )}
          <div className="border border-[#dcdcdc] focus-within:border-[#c2542d] rounded-xl p-2 bg-white">
            {uploadError && (
              <div className="mb-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                {uploadError}
              </div>
            )}
            {pendingAttachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {pendingAttachments.map((att) => (
                  <span
                    key={att.fileId}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#f5f5f5] border border-[#e2e2e2] text-[11px] text-[#333]"
                  >
                    <Paperclip size={10} className="text-[#777]" />
                    <span className="max-w-[160px] truncate">{att.filename}</span>
                    <span className="text-[#888]">({formatBytes(att.sizeBytes)})</span>
                    <button
                      type="button"
                      onClick={() => setPendingAttachments((prev) => prev.filter((x) => x.fileId !== att.fileId))}
                      className="text-[#888] hover:text-red-600 cursor-pointer"
                      title="Remove attachment"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={
                isMultiAgent
                  ? 'Type a message... Use @member / @everyone to target someone, or reply to a message'
                  : 'Type a message... (Enter to send, Shift+Enter for newline)'
              }
              rows={2}
              className="w-full resize-none text-sm focus:outline-none px-1.5 py-1"
            />
            <div className="flex items-center justify-between pt-1 px-1">
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void handleFileSelect(e)}
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-[#dcdcdc] hover:border-[#c2542d] rounded-md text-[#555] hover:text-[#111] disabled:opacity-50 cursor-pointer"
                  title="Attach files to this message"
                >
                  {uploading ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
                  <span>{uploading ? 'Uploading...' : 'Attach'}</span>
                </button>
                <span className="text-[11px] text-[#999]">
                  {currentRoom.state === 'paused'
                    ? 'Paused'
                    : activeNode
                      ? `Running (${activeNode.status})`
                      : 'Ready'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {activeNode && (
                  <button
                    type="button"
                    onClick={() => void controlNode(activeNode.id, 'stop')}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-[#f2f2f2] hover:bg-[#e5e5e5] text-[#222] rounded-lg cursor-pointer"
                  >
                    <Square size={12} />
                    <span>Interrupt</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={(!draft.trim() && pendingAttachments.length === 0) || sending || uploading}
                  onClick={() => void handleSend()}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-[#c2542d] hover:bg-[#ad4723] text-white rounded-lg disabled:opacity-40 cursor-pointer"
                >
                  <Send size={12} />
                  <span>Send</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {handoffOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={async (e: FormEvent) => {
              e.preventDefault()
              if (handoffLoading) return
              setHandoffError(null)
              setHandoffLoading(true)
              try {
                const latestSummaryMsg = [...messages]
                  .reverse()
                  .find((msg) => msg.authorKind === 'agent' && msg.kind === 'summary')
                const leadMember =
                  currentRoom.members.find((m) => m.roleKind === 'chair' || m.roleKind === 'lead') ??
                  currentRoom.members[0]!
                const selectedMembers = handoffStrategy === 'single' ? [leadMember] : currentRoom.members
                const targetMembers = selectedMembers.map((m) => ({
                  agentId: m.agentId,
                  displayName: m.displayName,
                  roleKind:
                    handoffStrategy === 'single'
                      ? ('member' as const)
                      : m.id === leadMember.id
                        ? ('lead' as const)
                        : ('member' as const)
                }))
                await handoffRoom({
                  sourceRoomId: currentRoom.id,
                  sourceMsgId: latestSummaryMsg?.id,
                  targetStrategyId: handoffStrategy,
                  title: handoffTitle.trim() || undefined,
                  workspaceId: handoffWorkspaceId || currentRoom.primaryWorkspaceId,
                  seedText: handoffSeedText.trim() || undefined,
                  members: targetMembers
                })
                setHandoffOpen(false)
              } catch (err) {
                setHandoffError(err instanceof Error ? err.message : 'Handoff failed')
              } finally {
                setHandoffLoading(false)
              }
            }}
            className="w-full max-w-[460px] bg-white rounded-xl shadow-xl border border-[#e5e5e5] p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#111]">Hand Off Execution</h3>
              <button type="button" onClick={() => setHandoffOpen(false)} className="text-[#888] hover:text-[#111]">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-[#666]">
              Hand off this roundtable conclusion and shared room memory to a new collaboration room while preserving full discussion traceability.
            </p>
            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block text-[#555] mb-1">Target Room Strategy</label>
                <select
                  value={handoffStrategy}
                  onChange={(e) => setHandoffStrategy(e.target.value as 'open-channel' | 'single')}
                  className="w-full px-2.5 py-2 text-xs border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="open-channel">Open Channel (keep all members, Lead coordinates execution)</option>
                  <option value="single">1v1 Direct (hand off to the first member alone)</option>
                </select>
              </div>
              <div>
                <label className="block text-[#555] mb-1">New Room Title</label>
                <input
                  value={handoffTitle}
                  onChange={(e) => setHandoffTitle(e.target.value)}
                  className="w-full px-2.5 py-2 text-xs border border-[#dcdcdc] rounded-lg"
                />
              </div>
              <div>
                <label className="block text-[#555] mb-1">Execution Workspace</label>
                <select
                  value={handoffWorkspaceId}
                  onChange={(e) => setHandoffWorkspaceId(e.target.value)}
                  className="w-full px-2.5 py-2 text-xs border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="">Keep current workspace</option>
                  {workspaces
                    .filter((w) => w.kind === 'project')
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        [Project] {w.name} — {w.rootPath}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-[#555] mb-1">Initial Execution Directive / Conclusion Summary</label>
                <textarea
                  rows={4}
                  value={handoffSeedText}
                  onChange={(e) => setHandoffSeedText(e.target.value)}
                  className="w-full px-2.5 py-2 text-xs border border-[#dcdcdc] rounded-lg resize-y"
                />
              </div>
            </div>
            {handoffError && <div className="text-xs text-red-600">{handoffError}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setHandoffOpen(false)}
                className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={handoffLoading}
                className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg disabled:opacity-40 cursor-pointer"
              >
                {handoffLoading ? 'Handing off...' : 'Confirm Handoff & Start'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
