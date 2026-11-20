import type {
  TurnUsage,
  UsageAnalyticsQuery,
  UsageAnalyticsReport,
  UsageBucket,
  UsageByAgent,
  UsageByModel,
  UsageByRoom,
  UsageRecentRun,
  UsageTimeBucket,
  UsageWindow
} from '@myagents/protocol'
import type { CoreDatabase } from '../storage/database'

interface RawUsageNodeRow {
  id: string
  room_id: string
  assignee_agent_id: string
  status: string
  driver_snapshot_json: string
  usage_json: string | null
  started_at: number | null
  ended_at: number | null
  created_at: number
  agent_name: string
  driver_kind: string
  agent_driver_config_json: string
  room_title: string
  strategy_id: string
}

interface BucketAcc {
  runs: number
  completedRuns: number
  failedRuns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
  totalTokens: number
  costUsd: number
  durationSum: number
  durationCount: number
  ttftSum: number
  ttftCount: number
}

function createAcc(): BucketAcc {
  return {
    runs: 0,
    completedRuns: 0,
    failedRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationSum: 0,
    durationCount: 0,
    ttftSum: 0,
    ttftCount: 0
  }
}

function finalizeAcc(acc: BucketAcc): UsageBucket {
  return {
    runs: acc.runs,
    completedRuns: acc.completedRuns,
    failedRuns: acc.failedRuns,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    thinkingTokens: acc.thinkingTokens,
    totalTokens: acc.totalTokens,
    costUsd: Number(acc.costUsd.toFixed(6)),
    avgDurationMs: acc.durationCount > 0 ? Math.round(acc.durationSum / acc.durationCount) : 0,
    avgTtftMs: acc.ttftCount > 0 ? Math.round(acc.ttftSum / acc.ttftCount) : 0
  }
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatBucketKey(ts: number, window: UsageWindow): string {
  const d = new Date(ts)
  if (window === '24h') {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function buildContiguousBuckets(window: UsageWindow, now: number): Map<string, BucketAcc> {
  const buckets = new Map<string, BucketAcc>()
  if (window === '24h') {
    const start = new Date(now - 23 * 3_600_000)
    start.setMinutes(0, 0, 0)
    for (let i = 0; i < 24; i++) {
      buckets.set(formatBucketKey(start.getTime() + i * 3_600_000, '24h'), createAcc())
    }
  } else if (window === '7d' || window === '30d') {
    const days = window === '7d' ? 7 : 30
    const start = new Date(now - (days - 1) * 86_400_000)
    start.setHours(0, 0, 0, 0)
    for (let i = 0; i < days; i++) {
      buckets.set(formatBucketKey(start.getTime() + i * 86_400_000, window), createAcc())
    }
  }
  return buckets
}

function sinceMsForWindow(window: UsageWindow, now: number): number | null {
  switch (window) {
    case '24h':
      return now - 24 * 3_600_000
    case '7d':
      return now - 7 * 86_400_000
    case '30d':
      return now - 30 * 86_400_000
    case 'all':
      return null
  }
}

function addSample(
  acc: BucketAcc,
  sample: {
    status: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    thinkingTokens: number
    totalTokens: number
    costUsd: number
    durationMs: number
    ttftMs: number
  }
): void {
  acc.runs += 1
  if (sample.status === 'completed') acc.completedRuns += 1
  else if (sample.status === 'failed') acc.failedRuns += 1
  acc.inputTokens += sample.inputTokens
  acc.outputTokens += sample.outputTokens
  acc.cacheReadTokens += sample.cacheReadTokens
  acc.cacheCreationTokens += sample.cacheCreationTokens
  acc.thinkingTokens += sample.thinkingTokens
  acc.totalTokens += sample.totalTokens
  acc.costUsd += sample.costUsd
  if (sample.durationMs > 0) {
    acc.durationSum += sample.durationMs
    acc.durationCount += 1
  }
  if (sample.ttftMs > 0) {
    acc.ttftSum += sample.ttftMs
    acc.ttftCount += 1
  }
}

export class UsageAnalyticsService {
  constructor(private readonly database: CoreDatabase) {}

  getReport(query: Partial<UsageAnalyticsQuery> = {}, now = Date.now()): UsageAnalyticsReport {
    const window: UsageWindow = query.window ?? '7d'
    const sinceMs = sinceMsForWindow(window, now)

    const clauses: string[] = ['(r.id IS NULL OR r.deleted_at IS NULL)']
    const sqlParams: Array<string | number> = []

    if (sinceMs !== null) {
      clauses.push('wn.created_at >= ?')
      sqlParams.push(sinceMs)
    }
    if (query.agentId) {
      clauses.push('wn.assignee_agent_id = ?')
      sqlParams.push(query.agentId)
    }
    if (query.roomId) {
      clauses.push('wn.room_id = ?')
      sqlParams.push(query.roomId)
    }

    const rows = this.database.db
      .prepare(
        `SELECT
           wn.id,
           wn.room_id,
           wn.assignee_agent_id,
           wn.status,
           wn.driver_snapshot_json,
           wn.usage_json,
           wn.started_at,
           wn.ended_at,
           wn.created_at,
           COALESCE(a.name, wn.assignee_agent_id) AS agent_name,
           COALESCE(a.driver_kind, 'unknown') AS driver_kind,
           COALESCE(a.driver_config_json, '{}') AS agent_driver_config_json,
           COALESCE(r.title, wn.room_id) AS room_title,
           COALESCE(r.strategy_id, 'single') AS strategy_id
         FROM work_nodes wn
         LEFT JOIN agents a ON a.id = wn.assignee_agent_id
         LEFT JOIN rooms r ON r.id = wn.room_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY wn.created_at DESC`
      )
      .all(...sqlParams) as unknown as RawUsageNodeRow[]

    const totalsAcc = createAcc()
    const timeAcc = buildContiguousBuckets(window, now)
    const agentAcc = new Map<string, { agentId: string; agentName: string; driverKind: string; acc: BucketAcc }>()
    const modelAcc = new Map<string, BucketAcc>()
    const roomAcc = new Map<string, { roomId: string; roomTitle: string; strategyId: string; acc: BucketAcc }>()
    const recentRuns: UsageRecentRun[] = []

    for (const row of rows) {
      const usage = safeJson(row.usage_json) as TurnUsage
      const snapshot = safeJson(row.driver_snapshot_json)
      const driverCfg = safeJson(row.agent_driver_config_json)
      const model =
        (typeof usage.model === 'string' && usage.model.trim()) ||
        (typeof snapshot.model === 'string' && snapshot.model.trim()) ||
        (typeof driverCfg.model === 'string' && driverCfg.model.trim()) ||
        row.driver_kind ||
        'unknown'

      if (query.model && model !== query.model) continue

      const inputTokens = num(usage.inputTokens)
      const outputTokens = num(usage.outputTokens)
      const cacheReadTokens = num(usage.cacheReadTokens)
      const cacheCreationTokens = num(usage.cacheCreationTokens)
      const thinkingTokens = num(usage.thinkingTokens)
      const totalTokens = inputTokens + outputTokens
      const costUsd = num(usage.costUsd)
      const fallbackDuration =
        row.started_at && row.ended_at ? Math.max(0, row.ended_at - row.started_at) : 0
      const durationMs = num(usage.durationMs) || fallbackDuration
      const ttftMs = num(usage.ttftMs)

      const sample = {
        status: row.status,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        thinkingTokens,
        totalTokens,
        costUsd,
        durationMs,
        ttftMs
      }

      addSample(totalsAcc, sample)

      const bucketKey = formatBucketKey(row.created_at, window)
      let tb = timeAcc.get(bucketKey)
      if (!tb) {
        tb = createAcc()
        timeAcc.set(bucketKey, tb)
      }
      addSample(tb, sample)

      let ag = agentAcc.get(row.assignee_agent_id)
      if (!ag) {
        ag = { agentId: row.assignee_agent_id, agentName: row.agent_name, driverKind: row.driver_kind, acc: createAcc() }
        agentAcc.set(row.assignee_agent_id, ag)
      }
      addSample(ag.acc, sample)

      let md = modelAcc.get(model)
      if (!md) {
        md = createAcc()
        modelAcc.set(model, md)
      }
      addSample(md, sample)

      let rm = roomAcc.get(row.room_id)
      if (!rm) {
        rm = { roomId: row.room_id, roomTitle: row.room_title, strategyId: row.strategy_id, acc: createAcc() }
        roomAcc.set(row.room_id, rm)
      }
      addSample(rm.acc, sample)

      if (recentRuns.length < 30) {
        recentRuns.push({
          nodeId: row.id,
          roomId: row.room_id,
          roomTitle: row.room_title,
          agentId: row.assignee_agent_id,
          agentName: row.agent_name,
          model,
          status: row.status,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          thinkingTokens,
          totalTokens,
          costUsd: Number(costUsd.toFixed(6)),
          durationMs: Math.round(durationMs),
          ttftMs: Math.round(ttftMs),
          createdAt: row.created_at
        })
      }
    }

    const sortFn = (a: UsageBucket, b: UsageBucket) =>
      b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.runs - a.runs

    const byDay: UsageTimeBucket[] = [...timeAcc.entries()]
      .sort(([a], [b]) => (window === 'all' ? a.localeCompare(b) : 0))
      .map(([bucket, acc]) => ({ bucket, ...finalizeAcc(acc) }))

    const byAgent: UsageByAgent[] = [...agentAcc.values()]
      .map((entry) => ({
        agentId: entry.agentId,
        agentName: entry.agentName,
        driverKind: entry.driverKind,
        ...finalizeAcc(entry.acc)
      }))
      .sort(sortFn)

    const byModel: UsageByModel[] = [...modelAcc.entries()]
      .map(([model, acc]) => ({
        model,
        ...finalizeAcc(acc)
      }))
      .sort(sortFn)

    const byRoom: UsageByRoom[] = [...roomAcc.values()]
      .map((entry) => ({
        roomId: entry.roomId,
        roomTitle: entry.roomTitle,
        strategyId: entry.strategyId,
        ...finalizeAcc(entry.acc)
      }))
      .sort(sortFn)
      .slice(0, 25)

    return {
      window,
      sinceMs,
      generatedAt: now,
      totals: finalizeAcc(totalsAcc),
      byDay,
      byAgent,
      byModel,
      byRoom,
      recentRuns
    }
  }
}
