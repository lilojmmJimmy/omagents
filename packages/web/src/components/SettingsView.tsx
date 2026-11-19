import { useState, type FormEvent } from 'react'
import { CheckCircle2, KeyRound, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { apiChangePassword, rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

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
      setPError(err instanceof Error ? err.message : '保存失败')
    }
  }

  const probeProvider = async (id: string) => {
    setProbeResult((s) => ({ ...s, [id]: '探测中...' }))
    const res = await rpc.call<{ ok: boolean; latencyMs: number; models?: string[]; error?: string }>('providers.probe', { id })
    setProbeResult((s) => ({
      ...s,
      [id]: res.ok ? `连接正常 (${res.latencyMs}ms${res.models ? `, ${res.models.length} 个模型` : ''})` : `失败: ${res.error}`
    }))
  }

  const deleteProvider = async (id: string) => {
    if (!confirm('确认删除该模型服务商？')) return
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
      setPwMsg('密码已更新（其他会话已登出）')
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : '修改失败')
    }
  }

  const refreshEnv = async () => {
    await rpc.call('system.envCheck', { refresh: true })
    await refreshAll()
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-base font-semibold text-[#111]">设置（Settings）</h1>

        {/* Environment check */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[#111]">外部运行时环境检测</h2>
            <button type="button" onClick={() => void refreshEnv()} className="flex items-center gap-1 text-xs text-[#666] hover:text-[#111] cursor-pointer">
              <RefreshCw size={12} />
              <span>重新检测</span>
            </button>
          </div>
          <div className="divide-y divide-[#efefef] text-xs">
            {[envCheck?.git, ...(envCheck?.clis ?? [])].filter(Boolean).map((item) => (
              <div key={item!.kind} className="py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {item!.ready ? <CheckCircle2 size={14} className="text-green-600" /> : <XCircle size={14} className="text-red-500" />}
                  <span className="font-mono font-medium">{item!.kind}</span>
                  <span className="text-[#666]">{item!.version || item!.problem || '未安装'}</span>
                </div>
                <span className="font-mono text-[11px] text-[#999] truncate max-w-sm">{item!.path || '-'}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Model Providers */}
        <section className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-medium text-[#111]">模型服务商（供 Builtin 轻量 Agent 使用）</h2>
          <form onSubmit={handleSaveProvider} className="grid grid-cols-2 gap-3 text-xs border-b border-[#efefef] pb-4">
            <input
              required
              value={pName}
              onChange={(e) => setPName(e.target.value)}
              placeholder="服务商名称，如 DeepSeek / OpenAI / Ollama"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <input
              required
              value={pModel}
              onChange={(e) => setPModel(e.target.value)}
              placeholder="默认模型名，如 deepseek-chat / gpt-4o-mini"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            <input
              required
              value={pBaseUrl}
              onChange={(e) => setPBaseUrl(e.target.value)}
              placeholder="Base URL，如 https://api.deepseek.com/v1"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            <input
              type="password"
              value={pApiKey}
              onChange={(e) => setPApiKey(e.target.value)}
              placeholder="API Key（或 env:OPENAI_API_KEY）"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
            {pError && <div className="col-span-2 text-red-600">{pError}</div>}
            <div className="col-span-2 flex justify-end">
              <button type="submit" className="flex items-center gap-1 px-3 py-1.5 bg-[#c2542d] text-white rounded-lg font-medium cursor-pointer">
                <Plus size={13} />
                <span>添加服务商</span>
              </button>
            </div>
          </form>

          <div className="space-y-2">
            {providers.length === 0 ? (
              <div className="text-xs text-[#999] text-center py-3">尚未配置任何模型服务商</div>
            ) : (
              providers.map((p) => (
                <div key={p.id} className="border border-[#eee] rounded-lg p-3 flex items-center justify-between text-xs">
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
                      测试连通性
                    </button>
                    <button type="button" onClick={() => void deleteProvider(p.id)} className="p-1 text-[#888] hover:text-red-600 cursor-pointer">
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
            <span>修改管理员密码</span>
          </div>
          <form onSubmit={handleChangePw} className="flex items-center gap-3">
            <input
              type="password"
              required
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="当前密码"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <input
              type="password"
              required
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="新密码（至少 4 位）"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-[#111] text-white rounded-lg cursor-pointer">
              修改密码
            </button>
          </form>
          {pwMsg && <div className="text-xs text-[#c2542d]">{pwMsg}</div>}
        </section>
      </div>
    </div>
  )
}
