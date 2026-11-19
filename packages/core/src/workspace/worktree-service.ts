import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { Errors } from '../errors'

const execFileAsync = promisify(execFile)

export class RepoMutex {
  private readonly chains = new Map<string, Promise<unknown>>()

  async withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(repoKey).toLowerCase()
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(key, next)
    next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
    return await next
  }
}

export function sanitizeSlug(raw: string, fallback = 'task'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return cleaned || fallback
}

async function execGit(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

export async function gitAddWorktree(opts: {
  repoMutex: RepoMutex
  gitCommonDir: string
  repoCwd: string
  destPath: string
  branchName: string
  baseRef?: string
}): Promise<{ baseCommit: string }> {
  return await opts.repoMutex.withRepoLock(opts.gitCommonDir, async () => {
    const ref = opts.baseRef?.trim() || 'HEAD'
    try {
      await execGit(opts.repoCwd, ['rev-parse', '--verify', ref])
    } catch {
      throw Errors.conflict(
        'empty_git_repo',
        `Cannot create git worktree from ref "${ref}" (ensure repository has at least one commit)`
      )
    }

    mkdirSync(path.dirname(opts.destPath), { recursive: true })
    await execGit(opts.repoCwd, ['worktree', 'add', '-b', opts.branchName, opts.destPath, ref])
    const baseCommit = (await execGit(opts.destPath, ['rev-parse', 'HEAD'])).trim()
    return { baseCommit }
  })
}

export async function gitRemoveWorktree(opts: {
  repoMutex: RepoMutex
  gitCommonDir: string
  worktreePath: string
  force: boolean
}): Promise<void> {
  if (existsSync(opts.worktreePath) && !opts.force) {
    try {
      const dirtyOut = await execGit(opts.worktreePath, ['status', '--porcelain=v1'])
      if (dirtyOut.trim().length > 0) {
        throw Errors.conflict(
          'worktree_dirty',
          'Worktree has uncommitted changes; commit or pass force=true to remove it'
        )
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err
    }
  }

  // Run git worktree remove against the common git dir parent so removing the directory itself works cleanly
  const mainRepoCwd = path.dirname(opts.gitCommonDir)
  await opts.repoMutex.withRepoLock(opts.gitCommonDir, async () => {
    if (existsSync(opts.worktreePath)) {
      const args = ['worktree', 'remove']
      if (opts.force) args.push('--force')
      args.push(opts.worktreePath)
      try {
        await execGit(mainRepoCwd, args)
      } catch (err) {
        if (!opts.force) throw err
        rmSync(opts.worktreePath, { recursive: true, force: true })
      }
    }
    try {
      await execGit(mainRepoCwd, ['worktree', 'prune'])
    } catch {
      // ignore prune warning
    }
  })
}
