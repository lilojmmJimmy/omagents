import type { BlobPurgeResult, BlobStorageSummary } from '@myagents/protocol'
import { AlertTriangle, CheckCircle2, HardDrive, KeyRound, Plus, RefreshCw, Trash2, X, XCircle } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { apiChangePassword, rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function SettingsView() {
  const providers = useAppStore((s) => s.providers)
  const envCheck = useAppStore((s) => s.envCheck)
  const refreshAll = useAppStore((s) => s.refreshAll)

  // Provider form
  const [pName, setPName] = useState('')
  const [pBaseUrl, setPBaseUrl] = useState('https://api.openai.com/v1')
  const [pApiKey, setPApiKey] = useState('')
  const [pModel, setPModel] = useState('gpt-4o-mini')
  const [pError, setPError] = useState<string | null>(null)
  const [probeResult, setProbeResult] = useState<Record<string, string>>({})

  // Password form
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState<string | null>(null)

  // Attachment Blob Storage & Manual Cleanup (double confirmation, no scheduled GC)
  const [blobSummary, setBlobSummary] = useState<BlobStorageSummary | null>(null)
  const [blobError, setBlobError] = useState<string | null>(null)
  const [showUnrefList, setShowUnrefList] = useState(false)
  const [purgeModalOpen, setPurgeModalOpen] = useState(false)
  const [purgeConfirmed, setPurgeConfirmed] = useState(false)
  const [purging, setPurging] = useState(false)
  const [purgeResult, setPurgeResult] = useState<BlobPurgeResult | null>(null)

  const refreshBlobSummary = async () => {
    setBlobError(null)
    try {
      const summary = await rpc.call<BlobStorageSummary>('blobs.summary')
      setBlobSummary(summary)
    } catch (err) {
      setBlobError(err instanceof Error ? err.message : 'Failed to load blob storage summary')
    }
  }

  useEffect(() => {
    void refreshBlobSummary()
  }, [])

  const openPurgeModal = () => {
    setPurgeConfirmed(false)
    setPurgeModalOpen(true)
  }

  const handleConfirmPurge = async () => {
    if (!purgeConfirmed || purging) return
    setPurging(true)
    setBlobError(null)
    try {
      const res = await rpc.call<BlobPurgeResult>('blobs.purgeUnreferenced', { confirm: true })
      setPurgeResult(res)
      setPurgeModalOpen(false)
      setPurgeConfirmed(false)
      await refreshBlobSummary()
    } catch (err) {
      setBlobError(err instanceof Error ? err.message : 'Cleanup failed')
    } finally {
      setPurging(false)
    }
  }

  const handleSaveProvider = async (e: FormEvent) => {
    e.preventDefault()
    setPError(null)
    try {
      await rpc.call('providers.save', {
        name: pName,
        kind: 'openai-compat',
        baseUrl: pBaseUrl,
        apiKey: pApiKey,
        defaultModel: pModel,
        models: [pModel]
      })
      setPName('')
      setPApiKey('')
      await refreshAll()
    } catch (err) {
      setPError(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const probeProvider = async (id: string) => {
    setProbeResult((s) => ({ ...s, [id]: 'Probing...' }))
    const res = await rpc.call<{ ok: boolean; latencyMs: number; models?: string[]; error?: string }>(
      'providers.probe',
      { id }
    )
    setProbeResult((s) => ({
      ...s,
      [id]: res.ok
        ? `Connected (${res.latencyMs}ms${res.models ? `, ${res.models.length} models` : ''})`
        : `Failed: ${res.error}`
    }))
  }

  const deleteProvider = async (id: string) => {
    if (!confirm('Delete this model provider?')) return
    await rpc.call('providers.delete', { id })
    await refreshAll()
  }

  const handleChangePw = async (e: FormEvent) => {
    e.preventDefault()
    setPwMsg(null)
    try {
      await apiChangePassword(oldPw, newPw)
      setOldPw('')
      setNewPw('')
      setPwMsg('Password updated (other sessions signed out)')
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : 'Failed to update password')
    }
  }

  const refreshEnv = async () => {
    await rpc.call('system.envCheck', { refresh: true })
    await refreshAll()
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-base font-semibold text-[#111]">Settings</h1>

        {/* Environment check */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[#111]">External Runtime Diagnostics</h2>
            <button
              type="button"
              onClick={() => void refreshEnv()}
              className="flex items-center gap-1 text-xs text-[#666] hover:text-[#111] cursor-pointer"
            >
              <RefreshCw size={12} />
              <span>Re-check</span>
            </button>
          </div>
          <div className="divide-y divide-[#efefef] text-xs">
            {[envCheck?.git, ...(envCheck?.clis ?? [])].filter(Boolean).map((item) => (
              <div key={item!.kind} className="py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {item!.ready ? (
                    <CheckCircle2 size={14} className="text-green-600" />
                  ) : (
                    <XCircle size={14} className="text-red-500" />
                  )}
                  <span className="font-mono font-medium">{item!.kind}</span>
                  <span className="text-[#666]">{item!.version || item!.problem || 'Not installed'}</span>
                </div>
                <span className="font-mono text-[11px] text-[#999] truncate max-w-sm">{item!.path || '-'}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Model Providers */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-medium text-[#111]">Model Providers (for Builtin Agents)</h2>
          <form onSubmit={handleSaveProvider} className="grid grid-cols-2 gap-3 text-xs border-b border-[#efefef] pb-4">
            <input
              required
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              placeholder="Provider name, e.g. DeepSeek / OpenAI / Ollama"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <input
              required
              value={pModel}
              onChange={(e) => setPModel(e.target.value)}
              placeholder="Default model, e.g. deepseek-chat / gpt-4o-mini"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            <input
              required
              value={pBaseUrl}
              onChange={(e) => setPBaseUrl(e.target.value)}
              placeholder="Base URL, e.g. https://api.deepseek.com/v1"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            <input
              type="password"
              value={pApiKey}
              onChange={(e) => setPApiKey(e.target.value)}
              placeholder="API Key (or env:OPENAI_API_KEY)"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            {pError && <div className="col-span-2 text-red-600">{pError}</div>}
            <div className="col-span-2 flex justify-end">
              <button
                type="submit"
                className="flex items-center gap-1 px-3 py-1.5 bg-[#c2542d] text-white rounded-lg font-medium cursor-pointer"
              >
                <Plus size={13} />
                <span>Add Provider</span>
              </button>
            </div>
          </form>

          <div className="space-y-2">
            {providers.length === 0 ? (
              <div className="text-xs text-[#999] text-center py-3">No model providers configured yet</div>
            ) : (
              providers.map((p) => (
                <div
                  key={p.id}
                  className="border border-[#eee] rounded-lg p-3 flex items-center justify-between text-xs"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-medium text-[#111]">
                      {p.name} <span className="font-mono text-[#666] ml-1">({p.defaultModel})</span>
                    </div>
                    <div className="font-mono text-[11px] text-[#888] truncate">{p.baseUrl}</div>
                    {probeResult[p.id] && <div className="text-[11px] text-[#c2542d]">{probeResult[p.id]}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void probeProvider(p.id)}
                      className="px-2.5 py-1 border border-[#dcdcdc] hover:border-[#c2542d] rounded-md cursor-pointer"
                    >
                      Test Connection
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteProvider(p.id)}
                      className="p-1 text-[#888] hover:text-red-600 cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Change Password */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-[#111]">
            <KeyRound size={15} />
            <span>Change Admin Password</span>
          </div>
          <form onSubmit={handleChangePw} className="flex items-center gap-3">
            <input
              type="password"
              required
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="Current password"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <input
              type="password"
              required
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="New password (at least 4 characters)"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium bg-[#111] text-white rounded-lg cursor-pointer"
            >
              Update Password
            </button>
          </form>
          {pwMsg && <div className="text-xs text-[#c2542d]">{pwMsg}</div>}
        </section>

        {/* Attachment Blob Storage */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-[#111]">
              <HardDrive size={15} className="text-[#c2542d]" />
              <span>Attachment Blob Storage</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshBlobSummary()}
                className="flex items-center gap-1 text-xs text-[#666] hover:text-[#111] cursor-pointer"
              >
                <RefreshCw size={12} />
                <span>Refresh</span>
              </button>
              <button
                type="button"
                disabled={!blobSummary || (blobSummary.unreferencedFiles === 0 && blobSummary.outboxPendingCount === 0)}
                onClick={openPurgeModal}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-40 cursor-pointer"
              >
                <Trash2 size={12} />
                <span>Clean Up Unreferenced Blobs</span>
              </button>
            </div>
          </div>

          <p className="text-xs text-[#666]">
            Chat and inbox attachments are deduplicated by SHA-256 on disk. Unused blobs from deleted rooms or inbox
            tickets remain until you explicitly remove them here.
          </p>

          {blobError && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{blobError}</div>
          )}

          {purgeResult && (
            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              Cleanup completed: removed {purgeResult.deletedFileRecords} unreferenced file record(s) and{' '}
              {purgeResult.deletedPhysicalBlobs} physical blob(s), reclaiming {formatBytes(purgeResult.reclaimedBytes)}.
              {purgeResult.errors.length > 0 && ` Errors: ${purgeResult.errors.join('; ')}`}
            </div>
          )}

          {blobSummary && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div className="border border-[#efefef] rounded-lg p-2.5 bg-[#fafafa]">
                  <div className="text-[#777]">Total Files</div>
                  <div className="text-sm font-semibold text-[#111] mt-0.5">{blobSummary.totalFiles}</div>
                  <div className="text-[11px] text-[#888] font-mono">{formatBytes(blobSummary.totalBytes)}</div>
                </div>
                <div className="border border-[#efefef] rounded-lg p-2.5 bg-[#fafafa]">
                  <div className="text-[#777]">Referenced</div>
                  <div className="text-sm font-semibold text-emerald-700 mt-0.5">{blobSummary.referencedFiles}</div>
                  <div className="text-[11px] text-[#888] font-mono">{formatBytes(blobSummary.referencedBytes)}</div>
                </div>
                <div className="border border-[#efefef] rounded-lg p-2.5 bg-[#fafafa]">
                  <div className="text-[#777]">Unreferenced (Reclaimable)</div>
                  <div className="text-sm font-semibold text-amber-700 mt-0.5">{blobSummary.unreferencedFiles}</div>
                  <div className="text-[11px] text-[#888] font-mono">{formatBytes(blobSummary.unreferencedBytes)}</div>
                </div>
                <div className="border border-[#efefef] rounded-lg p-2.5 bg-[#fafafa]">
                  <div className="text-[#777]">Deletion Queue</div>
                  <div className="text-sm font-semibold text-[#111] mt-0.5">{blobSummary.outboxPendingCount}</div>
                  <div className="text-[11px] text-[#888]">Awaiting manual cleanup</div>
                </div>
              </div>

              {blobSummary.unreferencedItems.length > 0 && (
                <div className="text-xs">
                  <button
                    type="button"
                    onClick={() => setShowUnrefList((v) => !v)}
                    className="text-[#c2542d] hover:underline cursor-pointer"
                  >
                    {showUnrefList ? 'Hide' : 'Show'} unreferenced attachments ({blobSummary.unreferencedItems.length})
                  </button>
                  {showUnrefList && (
                    <div className="mt-2 max-h-44 overflow-y-auto border border-[#efefef] rounded-lg divide-y divide-[#f4f4f4]">
                      {blobSummary.unreferencedItems.map((item) => (
                        <div key={item.id} className="px-3 py-1.5 flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate font-medium text-[#222]">{item.filename}</span>
                          <span className="font-mono text-[#888] shrink-0">
                            {item.mime} · {formatBytes(item.sizeBytes)} · {item.sha256.slice(0, 12)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {purgeModalOpen && blobSummary && (
        <div className="fixed inset-0 bg-black/35 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-white border border-[#e5e5e5] rounded-xl p-5 space-y-4 shadow-xl text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-red-700">
                <AlertTriangle size={16} />
                <span>Confirm Unreferenced Blob Deletion</span>
              </div>
              <button
                type="button"
                onClick={() => setPurgeModalOpen(false)}
                className="text-[#777] hover:text-[#111] cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-2 text-[#444]">
              <p>
                This action will permanently remove <strong>{blobSummary.unreferencedFiles}</strong> unreferenced file
                record(s) and <strong>{blobSummary.outboxPendingCount}</strong> queued deletion entry(ies), freeing up
                to <strong className="font-mono">{formatBytes(blobSummary.unreferencedBytes)}</strong> from disk.
              </p>
              <p className="text-[#666]">
                Files still referenced by existing chat messages or inbox items will NOT be touched. Deleted blobs
                cannot be recovered.
              </p>
            </div>

            <label className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200 text-red-900 cursor-pointer">
              <input
                type="checkbox"
                checked={purgeConfirmed}
                onChange={(e) => setPurgeConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>I confirm these unreferenced files will be permanently deleted from disk.</span>
            </label>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPurgeModalOpen(false)}
                className="px-3 py-1.5 border border-[#dcdcdc] rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!purgeConfirmed || purging}
                onClick={() => void handleConfirmPurge()}
                className="px-3 py-1.5 font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-40 cursor-pointer"
              >
                {purging ? 'Deleting...' : 'Confirm Permanent Deletion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
