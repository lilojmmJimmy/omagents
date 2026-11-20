import { useEffect, useState } from 'react'
import { BarChart3, Coins, Cpu, RefreshCw, Timer, Zap } from 'lucide-react'
import type { UsageAnalyticsReport, UsageWindow } from '@myagents/protocol'
import { rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function AnalyticsView() {
  const agents = useAppStore((s) => s.agents)
  const selectRoom = useAppStore((s) => s.selectRoom)

  const [windowVal, setWindowVal] = useState<UsageWindow>('7d')
  const [agentId, setAgentId] = useState('')
  const [report, setReport] = useState<UsageAnalyticsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadReport = async (w = windowVal, aId = agentId) => {
    setLoading(true)
    setError(null)
    try {
      const data = await rpc.call<UsageAnalyticsReport>('analytics.usage', {
        window: w,
        agentId: aId || undefined
      })
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage analytics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadReport(windowVal, agentId)
  }, [windowVal, agentId])

  const maxBucketTokens = report ? Math.max(1, ...report.byDay.map((d) => d.totalTokens)) : 1
  const successRate =
    report && report.totals.runs > 0
      ? Math.round((report.totals.completedRuns / report.totals.runs) * 100)
      : 0

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-[#111] flex items-center gap-2">
              <BarChart3 size={17} className="text-[#c2542d]" />
              <span>Usage & Cost Analytics</span>
            </h1>
            <p className="text-xs text-[#666] mt-0.5">
              Aggregated token consumption, estimated spend, latency, and run volume across active rooms and agents.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center p-0.5 bg-white border border-[#e5e5e5] rounded-lg">
              {([
                ['24h', '24h'],
                ['7d', '7d'],
                ['30d', '30d'],
                ['all', 'All']
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWindowVal(key)}
                  className={`px-2.5 py-1 rounded-md cursor-pointer ${
                    windowVal === key ? 'bg-[#c2542d]/10 text-[#c2542d] font-medium' : 'text-[#555] hover:bg-[#f5f5f5]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-[#dcdcdc] rounded-lg"
            >
              <option value="">All Agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadReport()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-[#dcdcdc] hover:border-[#c2542d] rounded-lg cursor-pointer"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        {report && (
          <>
            {/* KPI Summary Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-1">
                <div className="flex items-center justify-between text-[#666]">
                  <span>Total Tokens</span>
                  <Zap size={14} className="text-[#c2542d]" />
                </div>
                <div className="text-xl font-semibold text-[#111] font-mono">
                  {formatTokens(report.totals.totalTokens)}
                </div>
                <div className="text-[11px] text-[#888] font-mono">
                  {formatTokens(report.totals.inputTokens)} in / {formatTokens(report.totals.outputTokens)} out
                  {report.totals.cacheReadTokens > 0 ? ` · ${formatTokens(report.totals.cacheReadTokens)} cache` : ''}
                </div>
              </div>

              <div className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-1">
                <div className="flex items-center justify-between text-[#666]">
                  <span>Estimated Cost</span>
                  <Coins size={14} className="text-amber-600" />
                </div>
                <div className="text-xl font-semibold text-[#111] font-mono">
                  {formatCost(report.totals.costUsd)}
                </div>
                <div className="text-[11px] text-[#888] font-mono">
                  {report.totals.thinkingTokens > 0
                    ? `Thinking: ${formatTokens(report.totals.thinkingTokens)} tok`
                    : 'Reported by provider/CLI'}
                </div>
              </div>

              <div className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-1">
                <div className="flex items-center justify-between text-[#666]">
                  <span>Agent Runs</span>
                  <Cpu size={14} className="text-indigo-600" />
                </div>
                <div className="text-xl font-semibold text-[#111] font-mono">{report.totals.runs}</div>
                <div className="text-[11px] text-[#888] font-mono">
                  {report.totals.completedRuns} completed · {report.totals.failedRuns} failed ({successRate}% pass)
                </div>
              </div>

              <div className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-1">
                <div className="flex items-center justify-between text-[#666]">
                  <span>Avg Latency</span>
                  <Timer size={14} className="text-emerald-600" />
                </div>
                <div className="text-xl font-semibold text-[#111] font-mono">
                  {formatDuration(report.totals.avgDurationMs)}
                </div>
                <div className="text-[11px] text-[#888] font-mono">
                  TTFT avg: {report.totals.avgTtftMs > 0 ? `${report.totals.avgTtftMs}ms` : 'n/a'}
                </div>
              </div>
            </div>

            {/* Time Series Chart */}
            <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-[#111]">Token Volume Trend ({report.window})</span>
                <span className="text-[#888] font-mono">Peak: {formatTokens(maxBucketTokens)} tokens</span>
              </div>
              {report.byDay.length === 0 ? (
                <div className="text-xs text-[#888] py-8 text-center">No runs recorded in this window.</div>
              ) : (
                <div className="h-36 flex items-end gap-1 pt-2 border-b border-[#efefef]">
                  {report.byDay.map((b) => {
                    const pct = b.totalTokens > 0 ? Math.max(4, Math.round((b.totalTokens / maxBucketTokens) * 100)) : 2
                    return (
                      <div key={b.bucket} className="flex-1 h-full flex flex-col justify-end items-center group relative">
                        <div
                          className={`w-full max-w-[28px] rounded-t transition-colors ${
                            b.totalTokens > 0 ? 'bg-[#c2542d]/85 group-hover:bg-[#c2542d]' : 'bg-[#ececec]'
                          }`}
                          style={{ height: `${pct}%` }}
                          title={`${b.bucket}: ${formatTokens(b.totalTokens)} tokens (${b.runs} runs, ${formatCost(b.costUsd)})`}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
              {report.byDay.length > 0 && (
                <div className="flex items-center justify-between text-[10px] text-[#888] font-mono">
                  <span>{report.byDay[0]?.bucket}</span>
                  <span>{report.byDay[report.byDay.length - 1]?.bucket}</span>
                </div>
              )}
            </section>

            {/* Breakdown Grids */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
              <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2.5">
                <h2 className="font-medium text-[#111]">By Model</h2>
                {report.byModel.length === 0 ? (
                  <div className="text-[#999] py-4 text-center">No data</div>
                ) : (
                  <div className="divide-y divide-[#f2f2f2]">
                    {report.byModel.map((m) => (
                      <div key={m.model} className="py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-mono font-medium text-[#111] truncate">{m.model}</div>
                          <div className="text-[11px] text-[#888]">
                            {m.runs} runs · {formatDuration(m.avgDurationMs)} avg
                          </div>
                        </div>
                        <div className="text-right font-mono shrink-0">
                          <div className="text-[#111]">{formatTokens(m.totalTokens)}</div>
                          <div className="text-[11px] text-[#888]">{formatCost(m.costUsd)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2.5">
                <h2 className="font-medium text-[#111]">By Agent</h2>
                {report.byAgent.length === 0 ? (
                  <div className="text-[#999] py-4 text-center">No data</div>
                ) : (
                  <div className="divide-y divide-[#f2f2f2]">
                    {report.byAgent.map((a) => (
                      <div key={a.agentId} className="py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-[#111] truncate">
                            {a.agentName} <span className="font-mono text-[11px] text-[#888]">({a.driverKind})</span>
                          </div>
                          <div className="text-[11px] text-[#888]">
                            {a.completedRuns}/{a.runs} completed
                          </div>
                        </div>
                        <div className="text-right font-mono shrink-0">
                          <div className="text-[#111]">{formatTokens(a.totalTokens)}</div>
                          <div className="text-[11px] text-[#888]">{formatCost(a.costUsd)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Top Rooms */}
            <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2.5 text-xs">
              <h2 className="font-medium text-[#111]">By Room</h2>
              {report.byRoom.length === 0 ? (
                <div className="text-[#999] py-4 text-center">No room runs recorded in this window.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#efefef] text-[#777]">
                        <th className="py-1.5 font-medium">Room</th>
                        <th className="py-1.5 font-medium">Strategy</th>
                        <th className="py-1.5 font-medium text-right">Runs</th>
                        <th className="py-1.5 font-medium text-right">Input</th>
                        <th className="py-1.5 font-medium text-right">Output</th>
                        <th className="py-1.5 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f4f4f4]">
                      {report.byRoom.map((r) => (
                        <tr key={r.roomId} className="hover:bg-[#fafafa]">
                          <td className="py-1.5 pr-2">
                            <button
                              type="button"
                              onClick={() => void selectRoom(r.roomId)}
                              className="text-[#111] hover:text-[#c2542d] font-medium truncate max-w-[260px] text-left cursor-pointer"
                            >
                              {r.roomTitle}
                            </button>
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-[#666]">{r.strategyId}</td>
                          <td className="py-1.5 text-right font-mono">{r.runs}</td>
                          <td className="py-1.5 text-right font-mono">{formatTokens(r.inputTokens)}</td>
                          <td className="py-1.5 text-right font-mono">{formatTokens(r.outputTokens)}</td>
                          <td className="py-1.5 text-right font-mono">{formatCost(r.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Recent Runs */}
            <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2.5 text-xs">
              <h2 className="font-medium text-[#111]">Recent Runs ({report.recentRuns.length})</h2>
              {report.recentRuns.length === 0 ? (
                <div className="text-[#999] py-4 text-center">No recent runs.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#efefef] text-[#777]">
                        <th className="py-1.5 font-medium">Time</th>
                        <th className="py-1.5 font-medium">Agent</th>
                        <th className="py-1.5 font-medium">Model</th>
                        <th className="py-1.5 font-medium">Status</th>
                        <th className="py-1.5 font-medium text-right">Tokens</th>
                        <th className="py-1.5 font-medium text-right">Duration</th>
                        <th className="py-1.5 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f4f4f4]">
                      {report.recentRuns.map((run) => (
                        <tr key={run.nodeId} className="hover:bg-[#fafafa]">
                          <td className="py-1.5 pr-2 text-[#777] whitespace-nowrap">
                            {new Date(run.createdAt).toLocaleString()}
                          </td>
                          <td className="py-1.5 pr-2 font-medium text-[#111]">{run.agentName}</td>
                          <td className="py-1.5 pr-2 font-mono text-[#666]">{run.model}</td>
                          <td className="py-1.5 pr-2 font-mono">{run.status}</td>
                          <td className="py-1.5 text-right font-mono">{formatTokens(run.totalTokens)}</td>
                          <td className="py-1.5 text-right font-mono">{formatDuration(run.durationMs)}</td>
                          <td className="py-1.5 text-right font-mono">{formatCost(run.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
