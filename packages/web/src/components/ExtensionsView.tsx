import type { McpProbeResult, McpServer, McpTransport, SkillSourceType } from '@myagents/protocol'
import { Activity, BookOpen, Pencil, Plug, Plus, Power, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

function parseKeyValueLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (key) out[key] = val
  }
  return out
}

export function ExtensionsView() {
  const mcpServers = useAppStore((s) => s.mcpServers)
  const skills = useAppStore((s) => s.skills)
  const refreshExtensions = useAppStore((s) => s.refreshExtensions)
  const refreshAll = useAppStore((s) => s.refreshAll)

  const [tab, setTab] = useState<'mcp' | 'skills'>('mcp')

  // MCP server form state
  const [mcpFormOpen, setMcpFormOpen] = useState(false)
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null)
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgsText, setMcpArgsText] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpPairsText, setMcpPairsText] = useState('')
  const [mcpKeepExistingSecrets, setMcpKeepExistingSecrets] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, McpProbeResult>>({})

  // Skill install form state
  const [skillFormOpen, setSkillFormOpen] = useState(false)
  const [skillSourceType, setSkillSourceType] = useState<SkillSourceType>('local')
  const [skillSourceUri, setSkillSourceUri] = useState('')
  const [skillName, setSkillName] = useState('')
  const [skillRef, setSkillRef] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [skillInstalling, setSkillInstalling] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)

  const resetMcpForm = () => {
    setEditingMcpId(null)
    setMcpName('')
    setMcpTransport('stdio')
    setMcpCommand('')
    setMcpArgsText('')
    setMcpUrl('')
    setMcpPairsText('')
    setMcpKeepExistingSecrets(false)
    setMcpError(null)
    setMcpFormOpen(false)
  }

  const openEditMcp = (server: McpServer) => {
    setEditingMcpId(server.id)
    setMcpName(server.name)
    setMcpTransport(server.transport)
    setMcpCommand(server.command ?? '')
    setMcpArgsText(server.args.join('\n'))
    setMcpUrl(server.url ?? '')
    setMcpPairsText('')
    setMcpKeepExistingSecrets(server.envKeys.length > 0 || server.headerKeys.length > 0)
    setMcpError(null)
    setMcpFormOpen(true)
  }

  const handleSaveMcp = async (e: FormEvent) => {
    e.preventDefault()
    setMcpError(null)
    if (mcpName.trim().toLowerCase() === 'myagents') {
      setMcpError('Server name "myagents" is reserved for built-in collaboration tools.')
      return
    }
    try {
      const pairs = parseKeyValueLines(mcpPairsText)
      const args = mcpArgsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)

      await rpc.call('mcpServers.save', {
        ...(editingMcpId ? { id: editingMcpId } : {}),
        name: mcpName.trim(),
        transport: mcpTransport,
        ...(mcpTransport === 'stdio' ? { command: mcpCommand.trim(), args } : { url: mcpUrl.trim() }),
        ...(mcpKeepExistingSecrets && Object.keys(pairs).length === 0
          ? {}
          : mcpTransport === 'stdio'
            ? { envRefs: pairs }
            : { headerRefs: pairs })
      })
      resetMcpForm()
      await refreshExtensions()
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to save MCP server')
    }
  }

  const toggleMcpEnabled = async (server: McpServer) => {
    await rpc.call('mcpServers.save', {
      id: server.id,
      name: server.name,
      transport: server.transport,
      ...(server.transport === 'stdio'
        ? { command: server.command ?? '', args: server.args }
        : { url: server.url ?? '' }),
      enabled: !server.enabled
    })
    await refreshExtensions()
  }

  const probeMcp = async (id: string) => {
    setProbingId(id)
    try {
      const res = await rpc.call<McpProbeResult>('mcpServers.probe', { id })
      setProbeResults((prev) => ({ ...prev, [id]: res }))
    } finally {
      setProbingId(null)
    }
  }

  const deleteMcp = async (server: McpServer) => {
    if (!confirm(`Delete MCP server "${server.name}"?`)) return
    await rpc.call('mcpServers.delete', { id: server.id })
    await refreshAll()
  }

  const handleInstallSkill = async (e: FormEvent) => {
    e.preventDefault()
    setSkillError(null)
    setSkillInstalling(true)
    try {
      await rpc.call('skills.install', {
        sourceType: skillSourceType,
        sourceUri: skillSourceUri.trim(),
        ...(skillName.trim() ? { name: skillName.trim() } : {}),
        ...(skillSourceType === 'git' && skillRef.trim() ? { ref: skillRef.trim() } : {}),
        ...(skillDescription.trim() ? { description: skillDescription.trim() } : {})
      })
      setSkillSourceUri('')
      setSkillName('')
      setSkillRef('')
      setSkillDescription('')
      setSkillFormOpen(false)
      await refreshExtensions()
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : 'Failed to install skill')
    } finally {
      setSkillInstalling(false)
    }
  }

  const removeSkill = async (id: string, name: string) => {
    if (!confirm(`Remove skill "${name}"?`)) return
    await rpc.call('skills.remove', { id })
    await refreshAll()
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-[#111]">Extensions (MCP & Skills)</h1>
            <p className="text-xs text-[#666] mt-0.5">
              Register external MCP servers and reusable skills, then equip them on individual agents.
            </p>
          </div>
          <div className="flex items-center gap-1 bg-white border border-[#e5e5e5] rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setTab('mcp')}
              className={`px-3 py-1 rounded-md cursor-pointer ${
                tab === 'mcp' ? 'bg-[#c2542d] text-white font-medium' : 'text-[#555] hover:text-[#111]'
              }`}
            >
              MCP Servers ({mcpServers.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('skills')}
              className={`px-3 py-1 rounded-md cursor-pointer ${
                tab === 'skills' ? 'bg-[#c2542d] text-white font-medium' : 'text-[#555] hover:text-[#111]'
              }`}
            >
              Skills ({skills.length})
            </button>
          </div>
        </div>

        {tab === 'mcp' && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (mcpFormOpen) resetMcpForm()
                  else setMcpFormOpen(true)
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
              >
                <Plus size={14} />
                <span>{mcpFormOpen ? 'Close Form' : 'Add MCP Server'}</span>
              </button>
            </div>

            {mcpFormOpen && (
              <form onSubmit={handleSaveMcp} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Server Name * (reserved: myagents)</label>
                    <input
                      required
                      value={mcpName}
                      onChange={(e) => setMcpName(e.target.value)}
                      placeholder="e.g. github or filesystem"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Transport</label>
                    <select
                      value={mcpTransport}
                      onChange={(e) => setMcpTransport(e.target.value as McpTransport)}
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                    >
                      <option value="stdio">stdio (Local command)</option>
                      <option value="http">http (Streamable HTTP endpoint)</option>
                    </select>
                  </div>
                </div>

                {mcpTransport === 'stdio' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#555] mb-1">Command *</label>
                      <input
                        required
                        value={mcpCommand}
                        onChange={(e) => setMcpCommand(e.target.value)}
                        placeholder="e.g. npx or node"
                        className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#555] mb-1">Arguments (one per line)</label>
                      <textarea
                        rows={3}
                        value={mcpArgsText}
                        onChange={(e) => setMcpArgsText(e.target.value)}
                        placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                        className="w-full px-2.5 py-1.5 text-xs border border-[#dcdcdc] rounded-lg font-mono"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Endpoint URL *</label>
                    <input
                      required
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-[#555] mb-1">
                    {mcpTransport === 'stdio'
                      ? 'Environment Variables (KEY=VALUE or env:VAR per line)'
                      : 'HTTP Headers (Header=Value or env:VAR per line)'}
                  </label>
                  <textarea
                    rows={2}
                    value={mcpPairsText}
                    onChange={(e) => setMcpPairsText(e.target.value)}
                    placeholder={
                      mcpKeepExistingSecrets
                        ? 'Leave blank to keep existing secret references'
                        : mcpTransport === 'stdio'
                          ? 'GITHUB_TOKEN=env:GITHUB_TOKEN'
                          : 'Authorization=env:MCP_AUTH_HEADER'
                    }
                    className="w-full px-2.5 py-1.5 text-xs border border-[#dcdcdc] rounded-lg font-mono"
                  />
                </div>

                {mcpError && <div className="text-xs text-red-600">{mcpError}</div>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetMcpForm}
                    className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer"
                  >
                    {editingMcpId ? 'Update Server' : 'Save Server'}
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2.5">
              {mcpServers.length === 0 ? (
                <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
                  No external MCP servers configured yet. Click "Add MCP Server" to register one.
                </div>
              ) : (
                mcpServers.map((s) => {
                  const probe = probeResults[s.id]
                  const secretCount = s.envKeys.length + s.headerKeys.length
                  return (
                    <div key={s.id} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <Plug size={14} className={s.enabled ? 'text-[#c2542d]' : 'text-[#aaa]'} />
                            <span className="text-sm font-medium text-[#111] font-mono">{s.name}</span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">
                              {s.transport}
                            </span>
                            <span
                              className={`text-[11px] px-1.5 py-0.5 rounded ${
                                s.enabled ? 'bg-green-50 text-green-700' : 'bg-[#f2f2f2] text-[#888]'
                              }`}
                            >
                              {s.enabled ? 'enabled' : 'disabled'}
                            </span>
                            {secretCount > 0 && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                                {secretCount} secret ref(s)
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#666] font-mono truncate">
                            {s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={probingId === s.id}
                            onClick={() => void probeMcp(s.id)}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] cursor-pointer disabled:opacity-50"
                          >
                            <Activity size={12} />
                            <span>{probingId === s.id ? 'Probing...' : 'Probe'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleMcpEnabled(s)}
                            title={s.enabled ? 'Disable server' : 'Enable server'}
                            className="p-1.5 border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] text-[#555] cursor-pointer"
                          >
                            <Power size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditMcp(s)}
                            title="Edit server"
                            className="p-1.5 border border-[#dcdcdc] rounded-lg hover:bg-[#fafafa] text-[#555] cursor-pointer"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteMcp(s)}
                            title="Delete server"
                            className="p-1.5 text-[#888] hover:text-red-600 rounded-lg cursor-pointer"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {probe && (
                        <div
                          className={`text-xs rounded-lg px-3 py-2 border ${
                            probe.ok
                              ? 'bg-green-50/70 border-green-200 text-green-900'
                              : 'bg-red-50/70 border-red-200 text-red-700'
                          }`}
                        >
                          {probe.ok ? (
                            <div className="space-y-1">
                              <div>
                                Probe OK ({probe.latencyMs}ms) — {probe.tools.length} tool(s) discovered
                              </div>
                              {probe.tools.length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  {probe.tools.map((t) => (
                                    <span
                                      key={t.name}
                                      title={t.description || t.name}
                                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white border border-green-200"
                                    >
                                      {t.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div>
                              Probe failed ({probe.latencyMs}ms): {probe.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}

        {tab === 'skills' && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setSkillFormOpen(!skillFormOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] cursor-pointer"
              >
                <Plus size={14} />
                <span>{skillFormOpen ? 'Close Form' : 'Install Skill'}</span>
              </button>
            </div>

            {skillFormOpen && (
              <form onSubmit={handleInstallSkill} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Source Type</label>
                    <select
                      value={skillSourceType}
                      onChange={(e) => setSkillSourceType(e.target.value as SkillSourceType)}
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                    >
                      <option value="local">Local Directory / Markdown File</option>
                      <option value="git">Git Repository URL</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Skill Name Override (optional)</label>
                    <input
                      value={skillName}
                      onChange={(e) => setSkillName(e.target.value)}
                      placeholder="Defaults to SKILL.md frontmatter name"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[#555] mb-1">
                    {skillSourceType === 'local' ? 'Local Path *' : 'Git Repository URL *'}
                  </label>
                  <input
                    required
                    value={skillSourceUri}
                    onChange={(e) => setSkillSourceUri(e.target.value)}
                    placeholder={
                      skillSourceType === 'local'
                        ? 'e.g. G:\\skills\\code-review'
                        : 'https://github.com/org/my-skill.git'
                    }
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                  />
                </div>

                {skillSourceType === 'git' && (
                  <div>
                    <label className="block text-xs text-[#555] mb-1">Branch / Tag / Commit Ref (optional)</label>
                    <input
                      value={skillRef}
                      onChange={(e) => setSkillRef(e.target.value)}
                      placeholder="e.g. main or v1.0.0"
                      className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-[#555] mb-1">Description Override (optional)</label>
                  <input
                    value={skillDescription}
                    onChange={(e) => setSkillDescription(e.target.value)}
                    placeholder="Defaults to SKILL.md frontmatter description"
                    className="w-full px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
                  />
                </div>

                {skillError && <div className="text-xs text-red-600">{skillError}</div>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSkillFormOpen(false)}
                    className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={skillInstalling}
                    className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    {skillInstalling ? 'Installing...' : 'Install Skill'}
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2.5">
              {skills.length === 0 ? (
                <div className="bg-white border border-[#e5e5e5] rounded-xl p-8 text-center text-xs text-[#888]">
                  No skills installed yet. Click "Install Skill" to register a local or Git skill.
                </div>
              ) : (
                skills.map((sk) => (
                  <div
                    key={sk.id}
                    className="bg-white border border-[#e5e5e5] rounded-xl p-4 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <BookOpen size={14} className="text-[#c2542d]" />
                        <span className="text-sm font-medium text-[#111]">{sk.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">
                          {sk.sourceType}
                        </span>
                        {sk.pinnedCommit && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-mono">
                            {sk.pinnedCommit.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      {sk.description && <p className="text-xs text-[#666]">{sk.description}</p>}
                      <p className="text-[11px] text-[#999] font-mono truncate">{sk.localPath}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeSkill(sk.id, sk.name)}
                      title="Remove skill"
                      className="p-1.5 text-[#888] hover:text-red-600 rounded-lg cursor-pointer shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
