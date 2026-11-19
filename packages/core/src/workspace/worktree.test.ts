import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from './workspace-service'

describe('Git Worktree Isolation & RepoMutex', () => {
  const prevHome = process.env.MYAGENTS_HOME
  let tmpHome: string | null = null

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MYAGENTS_HOME
    else process.env.MYAGENTS_HOME = prevHome
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true })
      tmpHome = null
    }
  })

  function setupRepo(): { db: CoreDatabase; wsSvc: WorkspaceService; repoDir: string } {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-wt-'))
    process.env.MYAGENTS_HOME = tmpHome
    const repoDir = path.join(tmpHome, 'main-repo')
    execFileSync('git', ['init', repoDir], { windowsHide: true })
    execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: repoDir, windowsHide: true })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, windowsHide: true })
    writeFileSync(path.join(repoDir, 'README.md'), 'hello repo\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true })

    const db = new CoreDatabase(':memory:')
    const wsSvc = new WorkspaceService(db)
    return { db, wsSvc, repoDir }
  }

  it('creates parallel worktrees serialized safely by RepoMutex and cleans dirty worktrees with force while preserving git branch', async () => {
    const { db, wsSvc, repoDir } = setupRepo()
    try {
      const proj = await wsSvc.registerProject({ name: 'MainRepo', rootPath: repoDir })
      expect(proj.isGit).toBe(true)

      // Launch 2 worktree creations concurrently to exercise RepoMutex serialization
      const [wt1, wt2] = await Promise.all([
        wsSvc.createWorktree({ projectWorkspaceId: proj.id, branchSlug: 'coder-a', ownerType: 'work_node', ownerId: 'n1' }),
        wsSvc.createWorktree({ projectWorkspaceId: proj.id, branchSlug: 'coder-b', ownerType: 'work_node', ownerId: 'n2' })
      ])

      expect(wt1.kind).toBe('git_worktree')
      expect(wt2.kind).toBe('git_worktree')
      expect(wt1.rootPath).not.toBe(wt2.rootPath)
      expect(existsSync(path.join(wt1.rootPath, 'README.md'))).toBe(true)
      expect(existsSync(path.join(wt2.rootPath, 'README.md'))).toBe(true)
      expect(wt1.gitBranch).toMatch(/^myagents\/coder-a-/)

      // Make wt1 dirty with uncommitted changes and commit on branch first
      writeFileSync(path.join(wt1.rootPath, 'committed.txt'), 'kept in branch\n', 'utf8')
      execFileSync('git', ['add', 'committed.txt'], { cwd: wt1.rootPath, windowsHide: true })
      execFileSync('git', ['commit', '-m', 'wt1 work'], { cwd: wt1.rootPath, windowsHide: true })
      writeFileSync(path.join(wt1.rootPath, 'untracked.tmp'), 'dirty', 'utf8')

      // Clean without force should reject with worktree_dirty
      await expect(wsSvc.cleanWorktree(wt1.id, false)).rejects.toThrow(/uncommitted changes/i)

      // Clean with force removes worktree folder while keeping git branch & commit intact
      const cleaned1 = await wsSvc.cleanWorktree(wt1.id, true)
      expect(cleaned1.ok).toBe(true)
      expect(existsSync(wt1.rootPath)).toBe(false)

      const branches = execFileSync('git', ['branch', '--list', wt1.gitBranch!], {
        cwd: repoDir,
        encoding: 'utf8',
        windowsHide: true
      })
      expect(branches).toContain(wt1.gitBranch!)

      // Clean clean wt2 without force succeeds directly
      const cleaned2 = await wsSvc.cleanWorktree(wt2.id, false)
      expect(cleaned2.ok).toBe(true)
      expect(existsSync(wt2.rootPath)).toBe(false)
    } finally {
      db.close()
    }
  }, 20_000)
})
