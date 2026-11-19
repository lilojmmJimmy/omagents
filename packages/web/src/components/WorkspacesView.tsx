import { useState, type FormEvent } from 'react'
import { Folder, GitBranch, GitFork, Plus, Trash2 } from 'lucide-react'
import { rpc } from '../api/rpc-client'
import { useAppStore } from '../store/app-store'

export function WorkspacesView() {
  const workspaces = useAppStore((s) => s.workspaces)
  const refreshAll = useAppStore((s) => s.refreshAll)

  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionBusyId, setActionBusyId] = useState<string | null>(null)

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await rpc.call('workspaces.registerProject', { name: name.trim() || undefined, rootPath: rootPath.trim() })
      setName('')
      setRootPath('')
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const handleCreateWorktree = async (projectWorkspaceId: string) => {
    setError(null)
    setActionBusyId(projectWorkspaceId)
    try {
      await rpc.call('workspaces.createWorktree', { projectWorkspaceId, branchSlug: 'manual' })
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 Worktree 失败')
    } finally {
      setActionBusyId(null)
    }
  }

  const handleCleanWorktree = async (workspaceId: string) => {
    setError(null)
    setActionBusyId(workspaceId)
    try {
      await rpc.call('workspaces.cleanWorktree', { workspaceId, force: false })
      await refreshAll()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('uncommitted') || msg.toLowerCase().includes('dirty')) {
        if (confirm('该 Worktree 存在未提交改动，是否强制清理目录（保留 Git 分支）？')) {
          try {
            await rpc.call('workspaces.cleanWorktree', { workspaceId, force: true })
            await refreshAll()
          } catch (forceErr) {
            setError(forceErr instanceof Error ? forceErr.message : '强制清理失败')
          }
        }
      } else {
        setError(msg)
      }
    } finally {
      setActionBusyId(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#f8f8f8]">
      <div className="max-w-4xl mx-auto space-y-5">
        <div>
          <h1 className="text-base font-semibold text-[#111]">工作区（Workspaces）</h1>
          <p className="text-xs text-[#666] mt-0.5">
            登记服务器本地目录或 Git 项目仓库；支持为并行协作派发创建独立 Git Worktree 沙箱目录。
          </p>
        </div>

        <form onSubmit={handleRegister} className="bg-white border border-[#e5e5e5] rounded-xl p-4 space-y-3">
          <div className="text-xs font-medium text-[#333]">登记本地项目目录</div>
          <div className="grid grid-cols-3 gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="别名（可选，默认取目录名）"
              className="px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg"
            />
            <input
              required
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="服务器绝对路径，例如 G:\projects\my-app"
              className="col-span-2 px-2.5 py-1.5 text-sm border border-[#dcdcdc] rounded-lg font-mono"
            />
          </div>
          {error && <div className="text-xs text-red-600">{error}</div>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-[#c2542d] text-white rounded-lg hover:bg-[#ad4723] disabled:opacity-50 cursor-pointer"
            >
              <Plus size={13} />
              <span>{busy ? '登记中...' : '登记项目目录'}</span>
            </button>
          </div>
        </form>

        <div className="space-y-2.5">
          {workspaces.map((w) => (
            <div key={w.id} className="bg-white border border-[#e5e5e5] rounded-xl p-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Folder size={14} className="text-[#c2542d] shrink-0" />
                  <span className="text-sm font-medium text-[#111]">{w.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#f2f2f2] text-[#555] font-mono">{w.kind}</span>
                  {w.isGit && (
                    <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-mono">
                      <GitBranch size={11} />
                      {w.gitBranch || 'git'}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[#888] font-mono truncate">{w.rootPath}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {w.kind === 'project' && w.isGit && (
                  <button
                    type="button"
                    disabled={actionBusyId === w.id}
                    onClick={() => void handleCreateWorktree(w.id)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs border border-[#dcdcdc] hover:border-[#c2542d] rounded-lg text-[#333] cursor-pointer disabled:opacity-50"
                  >
                    <GitFork size={12} />
                    <span>新建 Worktree</span>
                  </button>
                )}
                {w.kind === 'git_worktree' && (
                  <button
                    type="button"
                    disabled={actionBusyId === w.id}
                    onClick={() => void handleCleanWorktree(w.id)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs border border-[#dcdcdc] hover:border-red-400 hover:text-red-600 rounded-lg text-[#555] cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                    <span>清理 Worktree</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
