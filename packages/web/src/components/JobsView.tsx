import { useState, type FormEvent } from 'react'
import { Clock, Database, Play, Plus, Power, RotateCcw, Trash2 } from 'lucide-react'
import type { BackgroundJobType, ScheduledJob } from '@myagents/protocol'
import { rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

const CRON_PRESETS = [
  { label: 'Every 5m', expr: '*/5 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 02:00', expr: '0 2 * * *' },
  { label: 'Mon 09:00', expr: '0 9 * * 1' }
] as const

function statusBadgeClass(status: string): string {
  if (status === 'completed') return 'bg-green-50 text-green-700'
  if (status === 'failed') return 'bg-red-50 text-red-700'
  if (status === 'running') return 'bg-amber-50 text-amber-800'
  return 'bg-[#f2f2f2] text-[#555]'
}

export function JobsView() {
  const schedules = useAppStore((s) => s.schedules)
  const jobs = useAppStore((s) => s.jobs)
  const agents = useAppStore((s) => s.agents)
  const workspaces = useAppStore((s) => s.workspaces)
  const pluginInstances = useAppStore((s) => s.pluginInstances)
  const refreshJobs = useAppStore((s) => s.refreshJobs)

  const [tab, setTab] = useState<'schedules' | 'history'>('schedules')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [cronExpr, setCronExpr] = useState('0 * * * *')
  const [jobType, setJobType] = useState<BackgroundJobType>('routine_tick')
  const [agentId, setAgentId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [allowWrite, setAllowWrite] = useState(false)
  const [instanceId, setInstanceId] = useState('')
  const [retentionCount, setRetentionCount] = useState(7)
  const [error, setError] = useState<string | null>(null)
  const [backupNotice, setBackupNotice] = useState<string | null>(null)

  const handleSaveSchedule = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      let payload: Record<string, unknown> = {}
      if (jobType === 'routine_tick') {
        payload = {
          ...(agentId ? { agentId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          prompt: prompt.trim() || 'Run scheduled routine check.',
          allowWrite
        }
      } else if (jobType === 'sync_source') {
        payload = instanceId ? { instanceId } : {}
      } else if (jobType === 'backup_snapshot') {
        payload = { retentionCount }
      }

      await rpc.call('schedules.save', {
        name: name.trim(),
        jobType,
        cronExpr: cronExpr.trim(),
        payload
      })
      setName('')
      setPrompt('')
      setAllowWrite(false)
      setCreating(false)
      await refreshJobs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule')
    }
  }

  const toggleSchedule = async (s: ScheduledJob) => {
    await rpc.call('schedules.save', {
      id: s.id,
      name: s.name,
      jobType: s.jobType,
      cronExpr: s.cronExpr,
      payload: s.payload,
      enabled: !s.enabled
    })
    await refreshJobs()
  }

  const runScheduleNow = async (id: string) => {
    await rpc.call('schedules.triggerNow', { id })
    await refreshJobs()
  }

  const deleteSchedule = async (s: ScheduledJob) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    await rpc.call('schedules.delete', { id: s.id })
    await refreshJobs()
  }

  const runBackupNow = async () => {
    setBackupNotice(null)
    const job = await rpc.call<{ id: string }>('jobs.enqueue', {
      jobType: 'backup_snapshot',
      payload: { retentionCount: 7 }
    })
    setBackupNotice(`Enqueued backup snapshot job ${job.id.slice(0, 8)}`)
    await refreshJobs()
  }

  const retryJob = async (id: string) => {
    await rpc.call('jobs.retry', { id })
    await refreshJobs()
  }

  const deleteJob = async (id: string) => {
    await rpc.call('jobs.delete', { id })
    await refreshJobs()
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-[#111]">Background Jobs & Cron Schedules</h1>
            <p className="text-xs text-[#666] mt-0.5">
              Automate routine agent ticks, plugin inbox sync, and SQLite WAL consistency snapshots.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runBackupNow()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] cursor-pointer"
            >
              <Database size={13} />
              <span>Backup Now</span>
            </button>
            <div className="flex items-center gap-1 bg-white border border-[#e5e5e5] rounded-lg p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTab('schedules')}
                className={`px-3 py-1 rounded-md cursor-pointer ${
                  tab === 'schedules' ? 'bg-[#c2542d] text-white font-medium' : 'text-[#555] hover:text-[#111]'
                }`}
              >
                Cron Schedules ({schedules.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('history')}
                className={`px-3 py-1 rounded-md cursor-pointer ${
                  tab === 'history' ? 'bg-[#c2542d] text-white font-medium' : 'text-[#555] hover:text-[#111]'
                }`}
              >
                Job History ({jobs.length})
              </button>
            </div>
          </div>
        </div>

        {backupNotice && (
          <div className="bg-white border border-[#e5e5e5] rounded-lg px-3 py-2 text-xs text-[#555]">
            {backupNotice}
          </div>
        )}

        {tab === 'schedules' && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setCreating(!creating)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
              >
                <Plus size={14} />
                <span>{creating ? 'Close Form' : 'New Schedule'}</span>
              </button>
            </div>

            {creating && (
              <form onSubmit={handleSaveSchedule} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Schedule Name *</label>
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Nightly Repo Audit"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Job Type</label>
                    <select
                      value={jobType}
                      onChange={(e) => setJobType(e.target.value as BackgroundJobType)}
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                    >
                      <option value="routine_tick">routine_tick (Agent Routine Prompt)</option>
                      <option value="sync_source">sync_source (Inbox Plugin Sync)</option>
                      <option value="backup_snapshot">backup_snapshot (SQLite WAL Snapshot)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-[#555]">5-Field Cron Expression *</label>
                    <div className="flex items-center gap-1">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => setCronExpr(p.expr)}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] hover:bg-[#e5e5e5] text-[#555] cursor-pointer"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    required
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder="min hour dom mon dow (e.g. 0 * * * *)"
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                  />
                </div>

                {jobType === 'routine_tick' && (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-[#555] mb-1">Target Agent</label>
                        <select
                          value={agentId}
                          onChange={(e) => setAgentId(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                        >
                          <option value="">First active agent</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.driverKind})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[#555] mb-1">Target Workspace</label>
                        <select
                          value={workspaceId}
                          onChange={(e) => setWorkspaceId(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                        >
                          <option value="">Agent private workspace</option>
                          {workspaces.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-[#555] mb-1">Routine Prompt *</label>
                      <textarea
                        rows={2}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Summarize recent workspace status and flag pending issues."
                        className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                      />
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs text-[#555] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowWrite}
                        onChange={(e) => setAllowWrite(e.target.checked)}
                      />
                      <span>Allow write access (unchecked defaults to read-only)</span>
                    </label>
                  </div>
                )}

                {jobType === 'sync_source' && (
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Plugin Instance</label>
                    <select
                      value={instanceId}
                      onChange={(e) => setInstanceId(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                    >
                      <option value="">All enabled pull plugins</option>
                      {pluginInstances.map((inst) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name} ({inst.pluginId})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {jobType === 'backup_snapshot' && (
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Snapshot Retention Count</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={retentionCount}
                      onChange={(e) => setRetentionCount(Number(e.target.value) || 7)}
                      className="w-40 px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                    />
                  </div>
                )}

                {error && <div className="text-xs text-red-600">{error}</div>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer"
                  >
                    Save Schedule
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2.5">
              {schedules.length === 0 ? (
                <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
                  No cron schedules created yet. Click "New Schedule" to add one.
                </div>
              ) : (
                schedules.map((s) => (
                  <div key={s.id} className="bg-white border border-[#e5e5e5] rounded-xl p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className={s.enabled ? 'text-[#c2542d]' : 'text-[#aaa]'} />
                        <span className="text-sm font-medium text-[#111]">{s.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">
                          {s.cronExpr}
                        </span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">
                          {s.jobType}
                        </span>
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded ${
                            s.enabled ? 'bg-green-50 text-green-700' : 'bg-[#f2f2f2] text-[#888]'
                          }`}
                        >
                          {s.enabled ? 'enabled' : 'paused'}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#777]">
                        Next run: {new Date(s.nextRunAt).toLocaleString()}
                        {s.lastRunAt ? ` | Last run: ${new Date(s.lastRunAt).toLocaleString()}` : ''}
                      </p>
                      {s.lastError && <p className="text-xs text-red-600 truncate">Last error: {s.lastError}</p>}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void runScheduleNow(s.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] cursor-pointer"
                      >
                        <Play size={12} />
                        <span>Run Now</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleSchedule(s)}
                        title={s.enabled ? 'Disable schedule' : 'Enable schedule'}
                        className="p-1.5 border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] text-[#555] cursor-pointer"
                      >
                        <Power size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteSchedule(s)}
                        title="Delete schedule"
                        className="p-1.5 text-[#888] hover:text-red-600 rounded-lg cursor-pointer"
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

        {tab === 'history' && (
          <div className="space-y-2.5">
            {jobs.length === 0 ? (
              <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
                No background jobs recorded yet.
              </div>
            ) : (
              jobs.map((j) => (
                <div key={j.id} className="bg-white border border-[#e5e5e5] rounded-xl p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[#111] font-mono">{j.jobType}</span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${statusBadgeClass(j.status)}`}>
                        {j.status}
                      </span>
                      {j.retryCount > 0 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
                          retries: {j.retryCount}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#777] font-mono truncate">
                      {new Date(j.createdAt).toLocaleString()} | payload: {JSON.stringify(j.payload)}
                    </p>
                    {j.errorText && <p className="text-xs text-red-600 truncate">{j.errorText}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {j.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => void retryJob(j.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] cursor-pointer"
                      >
                        <RotateCcw size={12} />
                        <span>Retry</span>
                      </button>
                    )}
                    {j.status !== 'running' && (
                      <button
                        type="button"
                        onClick={() => void deleteJob(j.id)}
                        title="Delete job"
                        className="p-1.5 text-[#888] hover:text-red-600 rounded-lg cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
