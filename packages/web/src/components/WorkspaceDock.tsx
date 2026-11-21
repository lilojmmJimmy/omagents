import type { FileEntry, GitDiffFile, GitStatusInfo, RoomMember, TerminalSession, WorkNode } from '@myagents/protocol'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  Brain,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { apiUploadWorkspaceFile, rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

function TerminalPane({ workspaceId }: { workspaceId: string }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const loadSessions = async () => {
    const list = await rpc.call<TerminalSession[]>('terminal.list', { workspaceId })
    setSessions(list)
    if (!activeId && list.length > 0) {
      const running = list.find((t) => t.status === 'running') ?? list[0]!
      setActiveId(running.id)
    }
  }

  useEffect(() => {
    setActiveId(null)
    void loadSessions()
  }, [workspaceId])

  useEffect(() => {
    if (!activeId || !containerRef.current) return
    const term = new XTerm({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#111111', foreground: '#eeeeee' },
      cursorBlink: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    xtermRef.current = term

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${encodeURIComponent(activeId)}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; data?: string; exitCode?: number; message?: string }
        if (msg.type === 'data' && msg.data) term.write(msg.data)
        else if (msg.type === 'exit') term.writeln(`\r\n[Process exited, code=${msg.exitCode}]`)
        else if (msg.type === 'error') term.writeln(`\r\n[Error: ${msg.message}]`)
      } catch {
        // ignore
      }
    }

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const onResize = () => {
      fit.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      onData.dispose()
      ws.close()
      term.dispose()
      xtermRef.current = null
      wsRef.current = null
    }
  }, [activeId])

  const openNew = async () => {
    const created = await rpc.call<TerminalSession>('terminal.open', { workspaceId, cols: 100, rows: 28 })
    await loadSessions()
    setActiveId(created.id)
  }

  const closeTerm = async (id: string) => {
    await rpc.call('terminal.close', { terminalId: id })
    if (activeId === id) setActiveId(null)
    await loadSessions()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-2 py-1.5 border-b border-[#eaeaea] flex items-center gap-1 overflow-x-auto bg-[#fafafa]">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer shrink-0 ${
              activeId === s.id ? 'bg-white border border-[#dcdcdc] text-[#111]' : 'text-[#666] hover:bg-[#efefef]'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'running' ? 'bg-green-500' : 'bg-gray-400'}`} />
            <span>{s.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void closeTerm(s.id)
              }}
              className="hover:text-red-600"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => void openNew()}
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#555] hover:bg-[#eaeaea] rounded cursor-pointer shrink-0"
        >
          <Plus size={12} />
          <span>New Terminal</span>
        </button>
      </div>
      {activeId ? (
        <div ref={containerRef} className="flex-1 bg-[#111] p-1 overflow-hidden" />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-xs text-[#888] gap-2">
          <TerminalIcon size={20} />
          <span>Click "New Terminal" to open a shell in the workspace directory (persists across core restarts)</span>
        </div>
      )}
    </div>
  )
}

const EMPTY_NODES: WorkNode[] = []
const EMPTY_MEMBERS: RoomMember[] = []

function nodeStatusBadgeClass(status: WorkNode['status']): string {
  switch (status) {
    case 'running':
    case 'starting':
      return 'bg-[#c2542d]/15 text-[#c2542d]'
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    case 'paused':
    case 'awaiting_human':
      return 'bg-amber-50 text-amber-800'
    case 'waiting_children':
    case 'waiting_deps':
    case 'waiting_lock':
      return 'bg-blue-50 text-blue-700'
    default:
      return 'bg-[#efefef] text-[#666]'
  }
}

function TasksPane() {
  const currentRoom = useAppStore((s) => s.currentRoom)
  const workNodesByRoom = useAppStore((s) => s.workNodesByRoom)
  const controlNode = useAppStore((s) => s.controlNode)
  const selectRoom = useAppStore((s) => s.selectRoom)

  const roomId = currentRoom?.id
  const nodes = roomId ? (workNodesByRoom[roomId] ?? EMPTY_NODES) : EMPTY_NODES
  const members = currentRoom?.members ?? EMPTY_MEMBERS
  const memories = currentRoom?.sharedMemories ?? []
  const memberMap = new Map(members.map((m) => [m.id, m]))

  // Build hierarchical display ordered per rootNodeId
  const childrenByParent = new Map<string, WorkNode[]>()
  const rootNodes: WorkNode[] = []
  for (const n of nodes) {
    if (!n.parentNodeId || !nodes.some((x) => x.id === n.parentNodeId)) {
      rootNodes.push(n)
    } else {
      const list = childrenByParent.get(n.parentNodeId) ?? []
      list.push(n)
      childrenByParent.set(n.parentNodeId, list)
    }
  }
  rootNodes.sort((a, b) => b.createdAt - a.createdAt)

  const renderTree = (node: WorkNode, depth: number): ReactElement[] => {
    const assignee = memberMap.get(node.assigneeMemberId)
    const isUnsettled = !['completed', 'failed', 'cancelled'].includes(node.status)
    const otherMembers = members.filter((m) => m.id !== node.assigneeMemberId && m.removedAt === null)
    const dur =
      node.usage?.durationMs ??
      (node.startedAt && node.endedAt ? Math.max(0, node.endedAt - node.startedAt) : undefined)

    const items: ReactElement[] = [
      <div
        key={node.id}
        style={{ marginLeft: `${Math.min(depth, 3) * 14}px` }}
        className="border border-[#e6e6e6] rounded-lg p-2.5 bg-white space-y-1.5 text-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span className="font-medium text-[#111]">@{assignee?.displayName ?? 'Agent'}</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#f4f4f4] text-[#666] font-mono">{node.kind}</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${nodeStatusBadgeClass(node.status)}`}>
              {node.status}
            </span>
            <span className="text-[10px] text-[#888] font-mono">{node.workspaceMode}</span>
          </div>
          <span className="text-[10px] text-[#999] font-mono shrink-0">
            #{node.attempt}
            {dur !== undefined ? ` · ${(dur / 1000).toFixed(1)}s` : ''}
          </span>
        </div>

        <p className="text-[11px] text-[#444] line-clamp-2 whitespace-pre-wrap">{node.instruction}</p>

        {node.blockingReason && (
          <div className="text-[10px] text-blue-700 font-mono">Blocked reason: {node.blockingReason}</div>
        )}
        {node.errorText && <div className="text-[10px] text-red-600 font-mono truncate">{node.errorText}</div>}

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {isUnsettled && (
            <>
              <button
                type="button"
                onClick={() => void controlNode(node.id, 'stop')}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[#dcdcdc] hover:border-amber-500 rounded text-[#444] cursor-pointer"
              >
                <Square size={10} />
                <span>Interrupt</span>
              </button>
              <button
                type="button"
                onClick={() => void controlNode(node.id, 'cancel')}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[#dcdcdc] hover:border-red-500 hover:text-red-600 rounded text-[#444] cursor-pointer"
              >
                <X size={10} />
                <span>Cancel</span>
              </button>
            </>
          )}
          {node.status === 'paused' && (
            <button
              type="button"
              onClick={() => void controlNode(node.id, 'continue')}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[#dcdcdc] hover:border-[#c2542d] rounded text-[#111] cursor-pointer"
            >
              <Play size={10} />
              <span>Resume</span>
            </button>
          )}
          {(node.status === 'failed' || node.status === 'cancelled') && (
            <button
              type="button"
              onClick={() => void controlNode(node.id, 'retry')}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] border border-[#dcdcdc] hover:border-[#c2542d] rounded text-[#111] cursor-pointer"
            >
              <RotateCcw size={10} />
              <span>Retry</span>
            </button>
          )}
          {otherMembers.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const targetMemberId = e.target.value
                if (targetMemberId) void controlNode(node.id, 'reassign', { targetMemberId })
              }}
              className="text-[11px] px-1.5 py-0.5 border border-[#dcdcdc] rounded bg-[#fafafa] text-[#555] cursor-pointer"
              title="Reassign to another member"
            >
              <option value="">Reassign to...</option>
              {otherMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  @{m.displayName}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    ]

    const children = [...(childrenByParent.get(node.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    for (const ch of children) {
      items.push(...renderTree(ch, depth + 1))
    }
    return items
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1.5 border-b border-[#efefef] bg-[#fafafa] flex items-center justify-between text-xs shrink-0">
        <span className="text-[#555]">Task Node Tree ({nodes.length})</span>
        {roomId && (
          <button
            type="button"
            onClick={() => void selectRoom(roomId)}
            className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
            title="Refresh task status"
          >
            <RefreshCw size={12} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {nodes.length === 0 ? (
          <div className="text-xs text-[#999] text-center py-6">No execution nodes yet</div>
        ) : (
          <div className="space-y-2">{rootNodes.flatMap((r) => renderTree(r, 0))}</div>
        )}

        <div className="pt-2 border-t border-[#efefef] space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#444]">
            <Brain size={12} className="text-[#c2542d]" />
            <span>Shared Room Memory ({memories.length})</span>
          </div>
          {memories.length === 0 ? (
            <div className="text-[11px] text-[#999]">
              Agents can persist cross-turn shared memory via collab_remember
            </div>
          ) : (
            <ul className="space-y-1">
              {memories.map((mem) => (
                <li
                  key={mem.id}
                  className="text-[11px] text-[#444] bg-[#fafafa] border border-[#eaeaea] rounded px-2 py-1"
                >
                  {mem.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export function WorkspaceDock() {
  const currentRoom = useAppStore((s) => s.currentRoom)
  const workspaces = useAppStore((s) => s.workspaces)
  const dockTab = useAppStore((s) => s.dockTab)
  const setDockTab = useAppStore((s) => s.setDockTab)
  const setDockOpen = useAppStore((s) => s.setDockOpen)

  const workspace = workspaces.find((w) => w.id === currentRoom?.primaryWorkspaceId) ?? workspaces[0]
  const workspaceId = workspace?.id

  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<{
    path: string
    content: string
    mtimeMs: number
    binary: boolean
  } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const [gitStatus, setGitStatus] = useState<GitStatusInfo | null>(null)
  const [diffs, setDiffs] = useState<GitDiffFile[]>([])
  const fileUploadRef = useRef<HTMLInputElement>(null)

  const loadFiles = async () => {
    if (!workspaceId) return
    try {
      const list = await rpc.call<FileEntry[]>('files.tree', { workspaceId, depth: 3 })
      setEntries(list)
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to load directory')
    }
  }

  const loadGit = async () => {
    if (!workspaceId) return
    try {
      const [st, d] = await Promise.all([
        rpc.call<GitStatusInfo>('git.status', { workspaceId }),
        rpc.call<{ files: GitDiffFile[] }>('git.diff', { workspaceId })
      ])
      setGitStatus(st)
      setDiffs(d.files)
    } catch {
      setGitStatus({ isGit: false, branch: null, files: [] })
      setDiffs([])
    }
  }

  useEffect(() => {
    setSelectedFile(null)
    setDirty(false)
    if (dockTab === 'files') void loadFiles()
    else if (dockTab === 'changes') void loadGit()
  }, [workspaceId, dockTab])

  const openFile = async (relPath: string) => {
    if (!workspaceId) return
    try {
      const res = await rpc.call<{ content: string; mtimeMs: number; binary: boolean }>('files.read', {
        workspaceId,
        path: relPath
      })
      setSelectedFile({ path: relPath, content: res.content, mtimeMs: res.mtimeMs, binary: res.binary })
      setDirty(false)
      setStatusMsg(null)
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to read file')
    }
  }

  const saveFile = async () => {
    if (!workspaceId || !selectedFile || selectedFile.binary) return
    try {
      const res = await rpc.call<{ ok: true; mtimeMs: number }>('files.write', {
        workspaceId,
        path: selectedFile.path,
        content: selectedFile.content,
        expectedMtimeMs: selectedFile.mtimeMs
      })
      setSelectedFile({ ...selectedFile, mtimeMs: res.mtimeMs })
      setDirty(false)
      setStatusMsg('Saved')
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const createNewFile = async () => {
    if (!workspaceId) return
    const rel = prompt('Enter relative path (e.g. notes/todo.md):')
    if (!rel?.trim()) return
    await rpc.call('files.write', { workspaceId, path: rel.trim(), content: '' })
    await loadFiles()
    await openFile(rel.trim())
  }

  const createNewDir = async () => {
    if (!workspaceId) return
    const rel = prompt('Enter new directory relative path:')
    if (!rel?.trim()) return
    await rpc.call('files.mkdir', { workspaceId, path: rel.trim() })
    await loadFiles()
  }

  const deletePath = async (relPath: string) => {
    if (!workspaceId || !confirm(`Delete ${relPath}?`)) return
    await rpc.call('files.remove', { workspaceId, path: relPath })
    if (selectedFile?.path === relPath) setSelectedFile(null)
    await loadFiles()
  }

  const handleUpload = async (file: File) => {
    if (!workspaceId) return
    try {
      await apiUploadWorkspaceFile(workspaceId, '', file)
      setStatusMsg(`Uploaded ${file.name}`)
      await loadFiles()
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Dock Tabs */}
      <div className="h-12 px-3 border-b border-[#ececec] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          {(
            [
              ['files', 'Files'],
              ['changes', 'Changes'],
              ['tasks', 'Tasks'],
              ['terminal', 'Terminal']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDockTab(key)}
              className={`px-2.5 py-1 text-xs rounded-md cursor-pointer ${
                dockTab === key ? 'bg-[#c2542d]/10 text-[#c2542d] font-medium' : 'text-[#666] hover:bg-[#f2f2f2]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setDockOpen(false)}
          className="p-1 text-[#777] hover:text-[#111] rounded cursor-pointer"
          title="Collapse dock"
        >
          <X size={14} />
        </button>
      </div>

      {dockTab === 'tasks' ? (
        <TasksPane />
      ) : !workspaceId ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[#999]">No workspace available</div>
      ) : dockTab === 'files' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Toolbar */}
          <div className="px-2.5 py-1.5 border-b border-[#efefef] flex items-center justify-between bg-[#fafafa] text-xs">
            <span className="text-[#555] truncate font-mono text-[11px]" title={workspace.rootPath}>
              {workspace.name}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <input
                ref={fileUploadRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleUpload(f)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => void createNewFile()}
                className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
                title="New file"
              >
                <FilePlus size={13} />
              </button>
              <button
                type="button"
                onClick={() => void createNewDir()}
                className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
                title="New folder"
              >
                <FolderPlus size={13} />
              </button>
              <button
                type="button"
                onClick={() => fileUploadRef.current?.click()}
                className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
                title="Upload file to workspace"
              >
                <Upload size={13} />
              </button>
              <button
                type="button"
                onClick={() => void loadFiles()}
                className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
                title="Refresh"
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>

          {/* Tree + Editor split */}
          <div className="flex-1 flex flex-col min-h-0">
            <div
              className={`${selectedFile ? 'h-44 border-b border-[#ececec]' : 'flex-1'} overflow-y-auto p-1.5 text-xs`}
            >
              {entries.length === 0 ? (
                <div className="text-[#999] p-3 text-center">Empty directory</div>
              ) : (
                entries.map((entry) => (
                  <div
                    key={entry.path}
                    onClick={() => entry.kind === 'file' && void openFile(entry.path)}
                    className={`group flex items-center justify-between px-2 py-1 rounded cursor-pointer ${
                      selectedFile?.path === entry.path
                        ? 'bg-[#c2542d]/10 text-[#c2542d]'
                        : 'hover:bg-[#f4f4f4] text-[#222]'
                    }`}
                    style={{ paddingLeft: `${8 + (entry.path.split('/').length - 1) * 14}px` }}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {entry.kind === 'dir' ? (
                        <Folder size={13} className="text-[#888] shrink-0" />
                      ) : (
                        <FileIcon size={13} className="text-[#888] shrink-0" />
                      )}
                      <span className="truncate font-mono text-[11px]">{entry.name}</span>
                    </div>
                    <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                      {entry.kind === 'file' && (
                        <a
                          href={`/api/workspaces/${encodeURIComponent(workspaceId)}/download?path=${encodeURIComponent(entry.path)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="p-0.5 text-[#666] hover:text-[#111]"
                          title="Download"
                        >
                          <Download size={11} />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void deletePath(entry.path)
                        }}
                        className="p-0.5 text-[#666] hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {selectedFile && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="px-2.5 py-1.5 bg-[#fafafa] border-b border-[#efefef] flex items-center justify-between text-xs">
                  <span className="font-mono text-[11px] truncate">
                    {selectedFile.path}
                    {dirty && <span className="text-[#c2542d] ml-1">*</span>}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!selectedFile.binary && (
                      <button
                        type="button"
                        disabled={!dirty}
                        onClick={() => void saveFile()}
                        className="flex items-center gap-1 px-2 py-0.5 bg-[#c2542d] text-white rounded text-[11px] disabled:opacity-40 cursor-pointer"
                      >
                        <Save size={11} />
                        <span>Save</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      className="text-[#777] hover:text-[#111] cursor-pointer"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                {statusMsg && <div className="px-2.5 py-1 text-[11px] text-[#c2542d] bg-[#c2542d]/5">{statusMsg}</div>}
                {selectedFile.binary ? (
                  <div className="flex-1 flex items-center justify-center text-xs text-[#888]">
                    Binary files cannot be edited as text
                  </div>
                ) : (
                  <textarea
                    value={selectedFile.content}
                    onChange={(e) => {
                      setSelectedFile({ ...selectedFile, content: e.target.value })
                      setDirty(true)
                    }}
                    spellCheck={false}
                    className="flex-1 w-full p-2.5 font-mono text-xs resize-none focus:outline-none leading-relaxed"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      ) : dockTab === 'changes' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-3 py-1.5 border-b border-[#efefef] bg-[#fafafa] flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-[#555]">
              <GitBranch size={13} />
              <span>{gitStatus?.isGit ? gitStatus.branch || 'HEAD' : 'Not a Git repository'}</span>
            </div>
            <button
              type="button"
              onClick={() => void loadGit()}
              className="p-1 hover:bg-[#e8e8e8] rounded cursor-pointer"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
            {!gitStatus?.isGit ? (
              <div className="text-[#999] text-center py-8">This workspace is not a Git repository</div>
            ) : diffs.length === 0 ? (
              <div className="text-[#999] text-center py-8">Working tree clean, no changes</div>
            ) : (
              diffs.map((d) => (
                <div key={d.path} className="border border-[#e6e6e6] rounded-lg overflow-hidden">
                  <div className="px-2.5 py-1.5 bg-[#fafafa] border-b border-[#eee] flex items-center justify-between font-mono text-[11px]">
                    <span className="truncate">{d.path}</span>
                    <span className="shrink-0 space-x-1.5">
                      <span className="text-green-700">+{d.additions}</span>
                      <span className="text-red-600">-{d.deletions}</span>
                    </span>
                  </div>
                  <pre className="p-2 overflow-x-auto text-[11px] leading-snug bg-white max-h-72">
                    {d.patch || '(No text diff)'}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <TerminalPane workspaceId={workspaceId} />
        </div>
      )}
    </div>
  )
}
