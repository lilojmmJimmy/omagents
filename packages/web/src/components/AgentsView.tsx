import { useState, type FormEvent } from 'react'
import { Bot, MessageSquare, Plus, Shield, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { Agent, DriverKind, IsolationMode, PermissionMode } from '@myagents/protocol'
import { rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

export function AgentsView() {
  const agents = useAppStore((s) => s.agents)
  const providers = useAppStore((s) => s.providers)
  const mcpServers = useAppStore((s) => s.mcpServers)
  const skills = useAppStore((s) => s.skills)
  const refreshAll = useAppStore((s) => s.refreshAll)
  const selectRoom = useAppStore((s) => s.selectRoom)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [driverKind, setDriverKind] = useState<DriverKind>('builtin')
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('workspace-write')
  const [isolationMode, setIsolationMode] = useState<IsolationMode>('standard')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [editingCapsAgentId, setEditingCapsAgentId] = useState<string | null>(null)
  const [editMcpIds, setEditMcpIds] = useState<string[]>([])
  const [editSkillIds, setEditSkillIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await rpc.call('agents.create', {
        name,
        bio,
        driverKind,
        providerId: driverKind === 'builtin' ? (providerId || providers[0]?.id || null) : null,
        driverConfig: model.trim() ? { model: model.trim() } : {},
        permissionMode,
        isolationMode,
        systemPrompt,
        mcpServerIds: selectedMcpIds,
        skillIds: selectedSkillIds
      })
      setName('')
      setBio('')
      setModel('')
      setIsolationMode('standard')
      setSystemPrompt('')
      setSelectedMcpIds([])
      setSelectedSkillIds([])
      setCreating(false)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent')
    }
  }

  const openCapabilities = (agent: Agent) => {
    if (editingCapsAgentId === agent.id) {
      setEditingCapsAgentId(null)
      return
    }
    setEditingCapsAgentId(agent.id)
    setEditMcpIds(agent.mcpServerIds)
    setEditSkillIds(agent.skillIds)
  }

  const saveCapabilities = async (agentId: string) => {
    await rpc.call('agents.update', {
      id: agentId,
      patch: {
        mcpServerIds: editMcpIds,
        skillIds: editSkillIds
      }
    })
    setEditingCapsAgentId(null)
    await refreshAll()
  }

  const startQuickChat = async (agent: Agent) => {
    const room = await rpc.call<{ id: string }>('rooms.create', {
      strategyId: 'single',
      primaryWorkspaceId: agent.defaultWorkspaceId,
      members: [{ agentId: agent.id, displayName: agent.name }]
    })
    await refreshAll()
    await selectRoom(room.id)
  }

  const archiveAgent = async (agent: Agent) => {
    if (!confirm(`确认归档 Agent「${agent.name}」？`)) return
    await rpc.call('agents.archive', { id: agent.id, archived: true })
    await refreshAll()
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-[#111]">智能体（Agents）</h1>
            <p className="text-xs text-[#666] mt-0.5">支持进程内轻量 Builtin Agent 与本机 Claude Code CLI，每个 Agent 自动分配独立私有工作区。</p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(!creating)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
          >
            <Plus size={14} />
            <span>新建 Agent</span>
          </button>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#555] mb-1">名称 *</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：轻舟助手 / Claude主程"
                  className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs text-[#555] mb-1">驱动类型</label>
                <select
                  value={driverKind}
                  onChange={(e) => setDriverKind(e.target.value as DriverKind)}
                  className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="builtin">Builtin 轻量自研 Agent（OpenAI 兼容 API）</option>
                  <option value="claude">Claude Code CLI（外部进程托管）</option>
                  <option value="codex">Codex CLI（codex exec --json）</option>
                  <option value="acp">Gemini / ACP CLI（stream-json）</option>
                </select>
              </div>
            </div>

            {driverKind === 'builtin' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#555] mb-1">模型服务商 *</label>
                  <select
                    value={providerId || providers[0]?.id || ''}
                    onChange={(e) => setProviderId(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                  >
                    {providers.length === 0 && <option value="">请先在“设置”中添加模型服务商</option>}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.defaultModel})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#555] mb-1">覆盖模型名（可选）</label>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="留空使用服务商默认模型"
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                  />
                </div>
              </div>
            )}

            {driverKind !== 'builtin' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#555] mb-1">模型名（可选）</label>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={
                      driverKind === 'claude'
                        ? '例如 sonnet / opus，留空用本机默认'
                        : driverKind === 'codex'
                          ? '例如 o4-mini，留空用本机默认'
                          : '例如 gemini-2.5-pro，留空用本机默认'
                    }
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#555] mb-1">权限模式</label>
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                  >
                    <option value="workspace-write">工作区可写</option>
                    <option value="read-only">只读模式（禁写）</option>
                    <option value="full">全权执行（注意风险）</option>
                  </select>
                </div>
              </div>
            )}

            {driverKind === 'builtin' && (
              <div>
                <label className="block text-xs text-[#555] mb-1">工作区权限</label>
                <select
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                  className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="workspace-write">工作区读写 + 命令执行</option>
                  <option value="read-only">仅只读文件/搜索</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs text-[#555] mb-1">环境隔离级别（5 层隔离架构）</label>
              <select
                value={isolationMode}
                onChange={(e) => setIsolationMode(e.target.value as IsolationMode)}
                className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
              >
                <option value="standard">standard — 标准模式（共享本机配置，只按工作区权限裁剪）</option>
                <option value="isolated-home">isolated-home — 独立配置目录 + 环境变量清洗（独立 CLAUDE_CONFIG_DIR）</option>
                <option value="lockdown">lockdown — 极严只读锁死（禁用原生写工具/Shell，仅保留只读协作原语）</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-[#555] mb-1">职责简介（可选）</label>
              <input
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="一句话描述擅长什么"
                className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs text-[#555] mb-1">系统提示词（可选）</label>
              <textarea
                rows={3}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="设定角色、输出风格与工作规范..."
                className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
              />
            </div>

            {(mcpServers.length > 0 || skills.length > 0) && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs text-[#555] mb-1">External MCP Servers</label>
                  <div className="border border-[#dcdcdc] rounded-lg p-2 max-h-28 overflow-y-auto space-y-1 text-xs">
                    {mcpServers.length === 0 ? (
                      <span className="text-[#999]">None configured</span>
                    ) : (
                      mcpServers.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedMcpIds.includes(s.id)}
                            onChange={() => setSelectedMcpIds((prev) => toggleId(prev, s.id))}
                          />
                          <span className="font-mono truncate">{s.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#555] mb-1">Equipped Skills</label>
                  <div className="border border-[#dcdcdc] rounded-lg p-2 max-h-28 overflow-y-auto space-y-1 text-xs">
                    {skills.length === 0 ? (
                      <span className="text-[#999]">None installed</span>
                    ) : (
                      skills.map((sk) => (
                        <label key={sk.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedSkillIds.includes(sk.id)}
                            onChange={() => setSelectedSkillIds((prev) => toggleId(prev, sk.id))}
                          />
                          <span className="truncate">{sk.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {error && <div className="text-xs text-red-600">{error}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer">
                取消
              </button>
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer">
                保存并创建私有工作区
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2.5">
          {agents.length === 0 ? (
            <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
              暂无 Agent，点击右上角「新建 Agent」创建你的第一个内置或 Claude Code Agent。
            </div>
          ) : (
            agents.map((a) => (
              <div key={a.id} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Bot size={15} className="text-[#c2542d]" />
                      <span className="text-sm font-medium text-[#111]">{a.name}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">{a.driverKind}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555]">{a.permissionMode}</span>
                      {a.isolationMode !== 'standard' && (
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded font-mono ${
                            a.isolationMode === 'lockdown' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-blue-50 text-blue-700'
                          }`}
                        >
                          <Shield size={10} />
                          {a.isolationMode}
                        </span>
                      )}
                      {a.mcpServerIds.length > 0 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-mono">
                          {a.mcpServerIds.length} MCP
                        </span>
                      )}
                      {a.skillIds.length > 0 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono">
                          {a.skillIds.length} skill(s)
                        </span>
                      )}
                    </div>
                    {a.bio && <p className="text-xs text-[#666]">{a.bio}</p>}
                    <p className="text-[11px] text-[#999] font-mono truncate">私有工作区：{a.defaultWorkspacePath}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openCapabilities(a)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-[#dcdcdc] text-[#444] hover:bg-[#fafafa] rounded-lg cursor-pointer"
                      title="Configure MCP servers & skills"
                    >
                      <SlidersHorizontal size={12} />
                      <span>Capabilities</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void startQuickChat(a)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-[#c2542d]/10 text-[#c2542d] hover:bg-[#c2542d]/15 rounded-lg cursor-pointer"
                    >
                      <MessageSquare size={12} />
                      <span>开聊</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void archiveAgent(a)}
                      className="p-1.5 text-[#888] hover:text-red-600 rounded-lg cursor-pointer"
                      title="归档"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {editingCapsAgentId === a.id && (
                  <div className="border-t border-[#efefef] pt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="text-[#555] font-medium mb-1">External MCP Servers</div>
                        {mcpServers.length === 0 ? (
                          <div className="text-[#999]">No MCP servers registered in Extensions.</div>
                        ) : (
                          <div className="space-y-1">
                            {mcpServers.map((s) => (
                              <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={editMcpIds.includes(s.id)}
                                  onChange={() => setEditMcpIds((prev) => toggleId(prev, s.id))}
                                />
                                <span className="font-mono">{s.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-[#555] font-medium mb-1">Equipped Skills</div>
                        {skills.length === 0 ? (
                          <div className="text-[#999]">No skills installed in Extensions.</div>
                        ) : (
                          <div className="space-y-1">
                            {skills.map((sk) => (
                              <label key={sk.id} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={editSkillIds.includes(sk.id)}
                                  onChange={() => setEditSkillIds((prev) => toggleId(prev, sk.id))}
                                />
                                <span>{sk.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingCapsAgentId(null)}
                        className="px-2.5 py-1 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveCapabilities(a.id)}
                        className="px-2.5 py-1 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer"
                      >
                        Save Capabilities
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
