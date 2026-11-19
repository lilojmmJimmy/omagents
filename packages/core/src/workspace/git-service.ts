import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitDiffFile, GitStatusInfo } from '@myagents/protocol'

const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

export async function probeGitRepo(dir: string): Promise<{ isGit: boolean; gitCommonDir: string | null; branch: string | null; head: string | null }> {
  try {
    const topLevel = path.resolve((await runGit(dir, ['rev-parse', '--show-toplevel'])).trim())
    // Guard against stray .git placed at filesystem/drive root (e.g. C:\.git)
    if (!topLevel || path.dirname(topLevel) === topLevel) {
      return { isGit: false, gitCommonDir: null, branch: null, head: null }
    }
    const common = (await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    let branch: string | null = null
    let head: string | null = null
    try {
      branch = (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null
    } catch {
      // empty repo without commits
    }
    try {
      head = (await runGit(dir, ['rev-parse', 'HEAD'])).trim() || null
    } catch {
      // empty repo
    }
    return { isGit: true, gitCommonDir: common || null, branch, head }
  } catch {
    return { isGit: false, gitCommonDir: null, branch: null, head: null }
  }
}

export class GitService {
  async status(rootPath: string): Promise<GitStatusInfo> {
    const probe = await probeGitRepo(rootPath)
    if (!probe.isGit) return { isGit: false, branch: null, files: [] }

    let out = ''
    try {
      out = await runGit(rootPath, ['status', '--porcelain=v1', '-uall'])
    } catch {
      return { isGit: true, branch: probe.branch, files: [] }
    }
    const files: GitStatusInfo['files'] = []
    for (const rawLine of out.split(/\r?\n/)) {
      if (!rawLine) continue
      const x = rawLine[0] ?? ' '
      const y = rawLine[1] ?? ' '
      const filePath = rawLine.slice(3).trim()
      if (!filePath) continue
      const code = `${x}${y}`.trim() || 'M'
      files.push({
        path: filePath,
        status: code,
        staged: x !== ' ' && x !== '?'
      })
    }
    return { isGit: true, branch: probe.branch, files }
  }

  async diff(rootPath: string, filePath?: string, baseCommit?: string): Promise<GitDiffFile[]> {
    const probe = await probeGitRepo(rootPath)
    if (!probe.isGit) return []

    const results: GitDiffFile[] = []
    const statusInfo = await this.status(rootPath)
    const targets = filePath
      ? statusInfo.files.filter((f) => f.path === filePath)
      : statusInfo.files

    for (const item of targets.slice(0, 100)) {
      if (item.status === '??') {
        // Untracked file diff using --no-index
        let patch = ''
        try {
          await execFileAsync('git', ['diff', '--no-index', '--', '/dev/null', item.path], {
            cwd: rootPath,
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true
          })
        } catch (err: unknown) {
          const e = err as { stdout?: string }
          patch = e.stdout ?? ''
        }
        const additions = patch.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
        results.push({ path: item.path, status: 'untracked', additions, deletions: 0, patch: patch.slice(0, 120_000) })
        continue
      }

      const args = baseCommit
        ? ['diff', baseCommit, '--', item.path]
        : ['diff', 'HEAD', '--', item.path]
      let patch = ''
      try {
        patch = await runGit(rootPath, args)
      } catch {
        // Fallback when HEAD doesn't exist yet
        try {
          patch = await runGit(rootPath, ['diff', '--', item.path])
        } catch {
          patch = ''
        }
      }
      const lines = patch.split(/\r?\n/)
      const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
      const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
      const status: GitDiffFile['status'] = item.status.includes('D')
        ? 'deleted'
        : item.status.includes('A')
          ? 'added'
          : item.status.includes('R')
            ? 'renamed'
            : 'modified'
      results.push({ path: item.path, status, additions, deletions, patch: patch.slice(0, 120_000) })
    }
    return results
  }
}
