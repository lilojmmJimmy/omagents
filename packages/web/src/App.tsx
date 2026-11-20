import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  BarChart3,
  Bot,
  Clock,
  Folder,
  Inbox,
  LogOut,
  MessageSquare,
  PanelRight,
  Plus,
  Puzzle,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react'
import type { WorkspaceMode } from '@myagents/protocol'
import { rpc } from './api/rpc-client'
import { AgentsView } from './components/AgentsView'
import { AnalyticsView } from './components/AnalyticsView'
import { ChatView } from './components/ChatView'
import { ExtensionsView } from './components/ExtensionsView'
import { InboxView } from './components/InboxView'
import { JobsView } from './components/JobsView'
import { LoginView } from './components/LoginView'
import { SettingsView } from './components/SettingsView'
import { WorkspaceDock } from './components/WorkspaceDock'
import { WorkspacesView } from './components/WorkspacesView'
import { useAppStore } from './store/app-store'

function NewChatModal({ onClose }: { onClose: () => void }) {
  const agents = useAppStore((s) => s.agents)
  const workspaces = useAppStore((s) => s.workspaces)
  const refreshAll = useAppStore((s) => s.refreshAll)
  const selectRoom = useAppStore((s) => s.selectRoom)

  const [mode, setMode] = useState<'single' | 'open-channel' | 'roundtable'>('single')
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>(() => agents.slice(0, 2).map((a) => a.id))
  const [leadAgentId, setLeadAgentId] = useState(agents[0]?.id ?? '')
  const [defaultWorkspaceMode, setDefaultWorkspaceMode] = useState<WorkspaceMode>('shared-rw')
  const [maxRounds, setMaxRounds] = useState(2)
  const [blindFirstRound, setBlindFirstRound] = useState(true)
  const [anonymous, setAnonymous] = useState(false)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [workspaceId, setWorkspaceId] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selectedAgent = agents.find((a) => a.id === agentId) ?? agents[0]

  const toggleMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      if (next.length > 0 && !next.includes(leadAgentId)) {
        setLeadAgentId(next[0]!)
      }
      return next
    })
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'single') {
      if (!selectedAgent) {
        setError('Please create an Agent first')
        return
      }
      try {
        const room = await rpc.call<{ id: string }>('rooms.create', {
          title: title.trim() || undefined,
          strategyId: 'single',
          primaryWorkspaceId: workspaceId || selectedAgent.defaultWorkspaceId,
          members: [{ agentId: selectedAgent.id, displayName: selectedAgent.name }]
        })
        await refreshAll()
        await selectRoom(room.id)
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create room')
      }
      return
    }

    const chosenAgents = agents.filter((a) => selectedIds.includes(a.id))
    if (chosenAgents.length < 2) {
      setError(mode === 'roundtable' ? 'Please select at least 2 agents for a roundtable' : 'Please select at least 2 agents for a group channel')
      return
    }
    const leadId = chosenAgents.some((a) => a.id === leadAgentId) ? leadAgentId : chosenAgents[0]!.id
    try {
      const room = await rpc.call<{ id: string }>('rooms.create', {
        title: title.trim() || undefined,
        strategyId: mode,
        strategyConfig:
          mode === 'roundtable'
            ? {
                defaultWorkspaceMode,
                maxRounds,
                blindFirstRound,
                anonymous,
                autoAdvance
              }
            : { defaultWorkspaceMode },
        primaryWorkspaceId: workspaceId || undefined,
        members: chosenAgents.map((a) => ({
          agentId: a.id,
          displayName: a.name,
          roleKind: a.id === leadId ? (mode === 'roundtable' ? 'chair' : 'lead') : 'member'
        }))
      })
      await refreshAll()
      await selectRoom(room.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md bg-white rounded-xl border border-[#e5e5e5] p-5 space-y-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">New Room</h3>
          <button type="button" onClick={onClose} className="text-[#777] hover:text-[#111] cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Mode toggle */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-[#f3f3f3] rounded-lg text-xs">
          <button
            type="button"
            onClick={() => setMode('single')}
            className={`py-1.5 rounded-md font-medium cursor-pointer ${
              mode === 'single' ? 'bg-white text-[#111] shadow-xs' : 'text-[#666]'
            }`}
          >
            1v1 Direct
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('open-channel')
              setDefaultWorkspaceMode('shared-rw')
            }}
            className={`py-1.5 rounded-md font-medium cursor-pointer ${
              mode === 'open-channel' ? 'bg-white text-[#111] shadow-xs' : 'text-[#666]'
            }`}
          >
            Open Channel
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('roundtable')
              setDefaultWorkspaceMode('read-only')
            }}
            className={`py-1.5 rounded-md font-medium cursor-pointer ${
              mode === 'roundtable' ? 'bg-white text-[#111] shadow-xs' : 'text-[#666]'
            }`}
          >
            Roundtable
          </button>
        </div>

        <div className="space-y-3 text-xs">
          {mode === 'single' ? (
            <div>
              <label className="block text-[#555] mb-1">Select Agent *</label>
              <select
                value={selectedAgent?.id ?? ''}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full px-2.5 py-2 text-sm border border-[#dcdcdc] rounded-lg bg-white"
              >
                {agents.length === 0 && <option value="">Create an Agent in the Agents tab first</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.driverKind})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-[#555]">Select Fixed Members (no ad-hoc subagents) *</label>
              <div className="max-h-40 overflow-y-auto border border-[#dcdcdc] rounded-lg divide-y divide-[#efefef]">
                {agents.length === 0 ? (
                  <div className="p-3 text-[#888]">Create at least 2 Agents in the Agents tab first</div>
                ) : (
                  agents.map((a) => {
                    const checked = selectedIds.includes(a.id)
                    const isLead = checked && leadAgentId === a.id
                    return (
                      <div key={a.id} className="flex items-center justify-between px-2.5 py-1.5 hover:bg-[#fafafa]">
                        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMember(a.id)}
                          />
                          <span className="truncate font-medium text-[#111]">{a.name}</span>
                          <span className="text-[10px] font-mono text-[#888]">{a.driverKind}</span>
                        </label>
                        {checked && (
                          <button
                            type="button"
                            onClick={() => setLeadAgentId(a.id)}
                            className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer ${
                              isLead ? 'bg-[#c2542d] text-white' : 'bg-[#f0f0f0] text-[#666] hover:bg-[#e5e5e5]'
                            }`}
                          >
                            {isLead
                              ? mode === 'roundtable'
                                ? 'Lead Chair'
                                : 'Lead'
                              : mode === 'roundtable'
                                ? 'Set Chair'
                                : 'Set Lead'}
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {mode === 'roundtable' && (
                <div className="p-2.5 bg-[#fafafa] border border-[#e6e6e6] rounded-lg space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#555]">Max discussion rounds</span>
                    <select
                      value={maxRounds}
                      onChange={(e) => setMaxRounds(Number(e.target.value))}
                      className="px-2 py-1 text-xs border border-[#dcdcdc] rounded bg-white"
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} rounds
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-[#444]">
                    <input
                      type="checkbox"
                      checked={blindFirstRound}
                      onChange={(e) => setBlindFirstRound(e.target.checked)}
                    />
                    <span>Round 1 blind answers (Super-step Barrier atomic reveal)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-[#444]">
                    <input
                      type="checkbox"
                      checked={anonymous}
                      onChange={(e) => setAnonymous(e.target.checked)}
                    />
                    <span>Anonymous peer review (mask speakers as Member A/B)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-[#444]">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    <span>Auto-advance rounds and summarize after each barrier</span>
                  </label>
                </div>
              )}

              <div>
                <label className="block text-[#555] mb-1">Default Workspace Mode</label>
                <select
                  value={defaultWorkspaceMode}
                  onChange={(e) => setDefaultWorkspaceMode(e.target.value as WorkspaceMode)}
                  className="w-full px-2.5 py-2 text-sm border border-[#dcdcdc] rounded-lg bg-white"
                >
                  <option value="shared-rw">shared-rw — Shared workspace with serialized write lock</option>
                  <option value="worktree">worktree — Isolated Git worktree per task in parallel</option>
                  <option value="read-only">read-only — Concurrent read-only analysis</option>
                </select>
              </div>
            </div>
          )}

          <div>
            <label className="block text-[#555] mb-1">Workspace</label>
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="w-full px-2.5 py-2 text-sm border border-[#dcdcdc] rounded-lg bg-white"
            >
              <option value="">
                {mode === 'single'
                  ? "Use this agent's private workspace (default)"
                  : mode === 'roundtable'
                    ? 'Auto-create read-only roundtable workspace (default)'
                    : 'Auto-create shared channel workspace (default)'}
              </option>
              {workspaces
                .filter((w) => w.kind === 'project')
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    [Project] {w.name} {w.isGit ? '(Git)' : ''} — {w.rootPath}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-[#555] mb-1">Room Title (optional)</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode === 'single'
                  ? 'Leave blank to auto-name from first message'
                  : mode === 'roundtable'
                    ? 'e.g. Architecture Decision Roundtable'
                    : 'e.g. Core Module Engineering Channel'
              }
              className="w-full px-2.5 py-2 text-sm border border-[#dcdcdc] rounded-lg"
            />
          </div>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs border border-[#dcdcdc] rounded-lg cursor-pointer">
            Cancel
          </button>
          <button type="submit" disabled={agents.length === 0} className="px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg disabled:opacity-40 cursor-pointer">
            {mode === 'single' ? 'Create Chat' : mode === 'roundtable' ? 'Create Roundtable' : 'Create Channel'}
          </button>
        </div>
      </form>
    </div>
  )
}

const DEFAULT_ASIDE_WIDTH = 240
const MIN_ASIDE_WIDTH = 180
const MAX_ASIDE_WIDTH = 480

const DEFAULT_DOCK_WIDTH = 440
const MIN_DOCK_WIDTH = 280
const MAX_DOCK_WIDTH = 960
const MIN_MAIN_WIDTH = 320

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? Number(raw) : NaN
    if (Number.isFinite(parsed)) return Math.min(max, Math.max(min, parsed))
  } catch {
    // ignore storage errors
  }
  return fallback
}

export function App() {
  const authChecked = useAppStore((s) => s.authChecked)
  const authenticated = useAppStore((s) => s.authenticated)
  const username = useAppStore((s) => s.username)
  const defaultPasswordWarning = useAppStore((s) => s.defaultPasswordWarning)
  const wsConnected = useAppStore((s) => s.wsConnected)
  const navPage = useAppStore((s) => s.navPage)
  const dockOpen = useAppStore((s) => s.dockOpen)
  const rooms = useAppStore((s) => s.rooms)
  const inboxItems = useAppStore((s) => s.inboxItems)
  const selectedRoomId = useAppStore((s) => s.selectedRoomId)
  const inboxNewCount = inboxItems.filter((i) => i.status === 'new').length

  const bootstrapAuth = useAppStore((s) => s.bootstrapAuth)
  const logout = useAppStore((s) => s.logout)
  const setNavPage = useAppStore((s) => s.setNavPage)
  const setDockOpen = useAppStore((s) => s.setDockOpen)
  const selectRoom = useAppStore((s) => s.selectRoom)
  const deleteRoom = useAppStore((s) => s.deleteRoom)

  const [newChatOpen, setNewChatOpen] = useState(false)
  const [asideWidth, setAsideWidth] = useState(() =>
    readStoredWidth('myagents.asideWidth', DEFAULT_ASIDE_WIDTH, MIN_ASIDE_WIDTH, MAX_ASIDE_WIDTH)
  )
  const [dockWidth, setDockWidth] = useState(() =>
    readStoredWidth('myagents.dockWidth', DEFAULT_DOCK_WIDTH, MIN_DOCK_WIDTH, MAX_DOCK_WIDTH)
  )
  const [resizingPane, setResizingPane] = useState<'aside' | 'dock' | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void bootstrapAuth()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('myagents.asideWidth', String(Math.round(asideWidth)))
    } catch {
      // ignore
    }
  }, [asideWidth])

  useEffect(() => {
    try {
      localStorage.setItem('myagents.dockWidth', String(Math.round(dockWidth)))
    } catch {
      // ignore
    }
  }, [dockWidth])

  const startResize = (pane: 'aside' | 'dock', e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startAside = asideWidth
    const startDock = dockWidth
    const showDock = navPage === 'chat' && dockOpen
    setResizingPane(pane)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const totalWidth = layoutRef.current?.clientWidth ?? window.innerWidth
      const dx = ev.clientX - startX
      if (pane === 'aside') {
        const reserved = MIN_MAIN_WIDTH + (showDock ? startDock + 12 : 6)
        const maxAllowed = Math.max(MIN_ASIDE_WIDTH, Math.min(MAX_ASIDE_WIDTH, totalWidth - reserved))
        setAsideWidth(Math.min(maxAllowed, Math.max(MIN_ASIDE_WIDTH, startAside + dx)))
      } else {
        const reserved = MIN_MAIN_WIDTH + startAside + 12
        const maxAllowed = Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, totalWidth - reserved))
        setDockWidth(Math.min(maxAllowed, Math.max(MIN_DOCK_WIDTH, startDock - dx)))
      }
    }

    const onUp = () => {
      setResizingPane(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!authChecked) {
    return <div className="h-full flex items-center justify-center text-xs text-[#888]">Loading...</div>
  }

  if (!authenticated) {
    return <LoginView />
  }

  return (
    <div className="h-full flex flex-col">
      {defaultPasswordWarning && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-xs text-amber-800 flex items-center justify-between">
          <span>The server is bound to a non-local interface with default credentials (admin/admin). Please change the password in Settings.</span>
          <button type="button" onClick={() => setNavPage('settings')} className="underline font-medium cursor-pointer">
            Change Password
          </button>
        </div>
      )}

      <div ref={layoutRef} className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Sidebar */}
        <aside
          style={{ width: asideWidth }}
          className="bg-[#f8f8f8] flex flex-col shrink-0 min-w-0"
        >
          <div className="h-12 px-3.5 border-b border-[#eaeaea] flex items-center justify-between">
            <span className="font-semibold text-sm tracking-tight">MyAgents</span>
            <div className="flex items-center gap-1.5">
              <span title={wsConnected ? 'Connected to Core' : 'Disconnected'}>
                {wsConnected ? <Wifi size={13} className="text-green-600" /> : <WifiOff size={13} className="text-red-500" />}
              </span>
              <button
                type="button"
                onClick={() => setNewChatOpen(true)}
                className="p-1 bg-[#c2542d] text-white rounded-md hover:bg-[#ad4723] cursor-pointer"
                title="New room"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Primary Nav */}
          <nav className="p-2 space-y-0.5 border-b border-[#eaeaea] text-xs">
            {([
              ['chat', 'Chats', MessageSquare],
              ['inbox', 'Inbox', Inbox],
              ['agents', 'Agents', Bot],
              ['extensions', 'Extensions', Puzzle],
              ['jobs', 'Jobs & Cron', Clock],
              ['analytics', 'Usage & Cost', BarChart3],
              ['workspaces', 'Workspaces', Folder],
              ['settings', 'Settings', Settings]
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setNavPage(key)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer ${
                  navPage === key ? 'bg-white shadow-xs text-[#111] font-medium' : 'text-[#555] hover:bg-[#efefef]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon size={14} />
                  <span>{label}</span>
                </span>
                {key === 'inbox' && inboxNewCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#c2542d] text-white font-medium">
                    {inboxNewCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Rooms list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            <div className="px-2 py-1 text-[11px] text-[#999]">Recent Rooms</div>
            {rooms.length === 0 ? (
              <div className="px-2 py-4 text-xs text-[#999]">No rooms yet</div>
            ) : (
              rooms.map((r) => (
                <div
                  key={r.id}
                  onClick={() => void selectRoom(r.id)}
                  className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${
                    navPage === 'chat' && selectedRoomId === r.id
                      ? 'bg-white shadow-xs text-[#111] font-medium'
                      : 'text-[#444] hover:bg-[#efefef]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        (r.activeNodeCount ?? 0) > 0
                          ? 'bg-[#c2542d] animate-pulse'
                          : r.state === 'paused'
                            ? 'bg-amber-400'
                            : r.hasFailedNode
                              ? 'bg-red-500'
                              : 'bg-[#ccc]'
                      }`}
                    />
                    <span className="truncate">{r.title}</span>
                    {r.strategyId !== 'single' && (
                      <span className="text-[10px] px-1 py-0.2 rounded bg-[#eaeaea] text-[#666] shrink-0">
                        {r.strategyId === 'roundtable' ? `Table · ${r.members.length}` : `Group · ${r.members.length}`}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Delete room "${r.title}"?`)) void deleteRoom(r.id)
                    }}
                    className="hidden group-hover:block text-[#888] hover:text-red-600 shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="p-2.5 border-t border-[#eaeaea] flex items-center justify-between text-xs text-[#666]">
            <span>{username}</span>
            <div className="flex items-center gap-1">
              {navPage === 'chat' && !dockOpen && (
                <button
                  type="button"
                  onClick={() => setDockOpen(true)}
                  className="p-1 hover:bg-[#eaeaea] rounded cursor-pointer"
                  title="Open workspace dock"
                >
                  <PanelRight size={14} />
                </button>
              )}
              <button type="button" onClick={() => void logout()} className="p-1 hover:bg-[#eaeaea] rounded cursor-pointer" title="Sign out">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        {/* Resize Handle: aside <-> main */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize left sidebar (double-click to reset)"
          onMouseDown={(e) => startResize('aside', e)}
          onDoubleClick={() => setAsideWidth(DEFAULT_ASIDE_WIDTH)}
          className={`w-1.5 shrink-0 cursor-col-resize relative group select-none ${
            resizingPane === 'aside' ? 'bg-[#c2542d]/30' : 'hover:bg-[#c2542d]/20'
          }`}
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-[#e8e8e8] group-hover:bg-[#c2542d]/60" />
        </div>

        {/* Main Stage */}
        <main className="flex-1 min-w-[320px]">
          {navPage === 'chat' && <ChatView onOpenNewChat={() => setNewChatOpen(true)} />}
          {navPage === 'inbox' && <InboxView />}
          {navPage === 'agents' && <AgentsView />}
          {navPage === 'extensions' && <ExtensionsView />}
          {navPage === 'jobs' && <JobsView />}
          {navPage === 'analytics' && <AnalyticsView />}
          {navPage === 'workspaces' && <WorkspacesView />}
          {navPage === 'settings' && <SettingsView />}
        </main>

        {/* Right Collapsible Workspace Dock */}
        {navPage === 'chat' && dockOpen && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize right dock (double-click to reset)"
              onMouseDown={(e) => startResize('dock', e)}
              onDoubleClick={() => setDockWidth(DEFAULT_DOCK_WIDTH)}
              className={`w-1.5 shrink-0 cursor-col-resize relative group select-none ${
                resizingPane === 'dock' ? 'bg-[#c2542d]/30' : 'hover:bg-[#c2542d]/20'
              }`}
            >
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-[#e8e8e8] group-hover:bg-[#c2542d]/60" />
            </div>
            <div style={{ width: dockWidth }} className="shrink-0 min-w-0">
              <WorkspaceDock />
            </div>
          </>
        )}
      </div>

      {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
    </div>
  )
}
