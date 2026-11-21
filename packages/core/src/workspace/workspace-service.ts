import { randomUUID } from 'node:crypto'
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { FileEntry, Workspace } from '@myagents/protocol'
import { myagentsAgentWorkspacePath, myagentsRoomWorkspacePath, myagentsWorktreesDir } from '@myagents/protocol/node'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import { probeGitRepo } from './git-service'
import { resolveContainedPath, toPosixRelPath } from './path-guard'
import { gitAddWorktree, gitRemoveWorktree, RepoMutex, sanitizeSlug } from './worktree-service'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', '.vite', 'dist', '__pycache__', '.venv'])
const MAX_READ_BYTES = 2 * 1024 * 1024

interface WorkspaceRow {
  id: string
  kind: Workspace['kind']
  name: string
  root_path: string
  is_git: number
  git_common_dir: string | null
  git_branch: string | null
  base_commit: string | null
  parent_workspace_id: string | null
  owner_type: Workspace['ownerType']
  owner_id: string | null
  readonly_refs_json: string
  cleaned_at: number | null
  created_at: number
  updated_at: number
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    rootPath: row.root_path,
    isGit: Boolean(row.is_git),
    gitCommonDir: row.git_common_dir,
    gitBranch: row.git_branch,
    baseCommit: row.base_commit,
    parentWorkspaceId: row.parent_workspace_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    readonlyRefs: JSON.parse(row.readonly_refs_json || '[]') as string[],
    cleanedAt: row.cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class WorkspaceService {
  private readonly repoMutex = new RepoMutex()

  constructor(private readonly database: CoreDatabase) {}

  list(kind?: Workspace['kind']): Workspace[] {
    const rows = kind
      ? (this.database.db
          .prepare('SELECT * FROM workspaces WHERE kind = ? AND cleaned_at IS NULL ORDER BY updated_at DESC')
          .all(kind) as unknown as WorkspaceRow[])
      : (this.database.db
          .prepare('SELECT * FROM workspaces WHERE cleaned_at IS NULL ORDER BY updated_at DESC')
          .all() as unknown as WorkspaceRow[])
    return rows.map(mapWorkspace)
  }

  get(id: string): Workspace {
    const row = this.database.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as unknown as
      | WorkspaceRow
      | undefined
    if (!row) throw Errors.notFound(`Workspace not found: ${id}`)
    return mapWorkspace(row)
  }

  createAgentPrivateWorkspace(agentId: string, agentName: string): Workspace {
    const rootPath = path.resolve(myagentsAgentWorkspacePath(agentId))
    mkdirSync(path.join(rootPath, 'notes'), { recursive: true })
    mkdirSync(path.join(rootPath, 'artifacts'), { recursive: true })
    const readmePath = path.join(rootPath, 'README.md')
    if (!existsSync(readmePath)) {
      writeFileSync(
        readmePath,
        `# ${agentName} Workspace\n\nPrivate persistent workspace for agent **${agentName}**.\n`,
        'utf8'
      )
    }

    const id = randomUUID()
    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO workspaces (id, kind, name, root_path, is_git, owner_type, owner_id, readonly_refs_json, created_at, updated_at)
         VALUES (?, 'agent_private', ?, ?, 0, 'agent', ?, '[]', ?, ?)`
      )
      .run(id, `${agentName} (Private)`, rootPath, agentId, now, now)
    return this.get(id)
  }

  async registerProject(input: { name?: string; rootPath: string; readonlyRefPaths?: string[] }): Promise<Workspace> {
    const resolved = path.resolve(input.rootPath.trim())
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw Errors.invalidParams(`Directory does not exist: ${resolved}`)
    }
    // Reject filesystem root
    if (path.dirname(resolved) === resolved) {
      throw Errors.pathOutOfBounds('Cannot register filesystem root as a workspace')
    }

    const existing = this.database.db
      .prepare('SELECT * FROM workspaces WHERE root_path = ?')
      .get(resolved) as unknown as WorkspaceRow | undefined
    if (existing) {
      const probe = await probeGitRepo(resolved)
      const now = Date.now()
      this.database.db
        .prepare(
          'UPDATE workspaces SET name = ?, is_git = ?, git_common_dir = ?, git_branch = ?, cleaned_at = NULL, updated_at = ? WHERE id = ?'
        )
        .run(
          input.name?.trim() || existing.name,
          Number(probe.isGit),
          probe.gitCommonDir,
          probe.branch,
          now,
          existing.id
        )
      return this.get(existing.id)
    }

    const probe = await probeGitRepo(resolved)
    const id = randomUUID()
    const now = Date.now()
    const name = input.name?.trim() || path.basename(resolved)
    this.database.db
      .prepare(
        `INSERT INTO workspaces (id, kind, name, root_path, is_git, git_common_dir, git_branch, base_commit, owner_type, readonly_refs_json, created_at, updated_at)
         VALUES (?, 'project', ?, ?, ?, ?, ?, ?, 'global', ?, ?, ?)`
      )
      .run(
        id,
        name,
        resolved,
        Number(probe.isGit),
        probe.gitCommonDir,
        probe.branch,
        probe.head,
        JSON.stringify(input.readonlyRefPaths ?? []),
        now,
        now
      )
    return this.get(id)
  }

  createRoomSharedWorkspace(roomId: string, roomTitle: string): Workspace {
    const rootPath = path.resolve(myagentsRoomWorkspacePath(roomId))
    mkdirSync(path.join(rootPath, 'shared'), { recursive: true })
    const readmePath = path.join(rootPath, 'README.md')
    if (!existsSync(readmePath)) {
      writeFileSync(
        readmePath,
        `# ${roomTitle || 'Collab Room'} Shared Workspace\n\nShared workspace for multi-agent collaboration room.\n`,
        'utf8'
      )
    }

    const id = randomUUID()
    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO workspaces (id, kind, name, root_path, is_git, owner_type, owner_id, readonly_refs_json, created_at, updated_at)
         VALUES (?, 'shared', ?, ?, 0, 'room', ?, '[]', ?, ?)`
      )
      .run(id, `${roomTitle || 'Room'} (Shared)`, rootPath, roomId, now, now)
    return this.get(id)
  }

  async createWorktree(opts: {
    projectWorkspaceId: string
    baseRef?: string
    branchSlug?: string
    ownerType?: Workspace['ownerType']
    ownerId?: string | null
  }): Promise<Workspace> {
    const parent = this.get(opts.projectWorkspaceId)
    if (!parent.isGit || !parent.gitCommonDir) {
      throw Errors.invalidParams(`Workspace "${parent.name}" is not a Git repository`)
    }
    const shortId = randomUUID().slice(0, 8)
    const slug = sanitizeSlug(opts.branchSlug || 'task')
    const repoFolder = sanitizeSlug(parent.name, 'repo')
    const destPath = path.resolve(path.join(myagentsWorktreesDir(), shortId, repoFolder))
    const branchName = `myagents/${slug}-${shortId}`

    const { baseCommit } = await gitAddWorktree({
      repoMutex: this.repoMutex,
      gitCommonDir: parent.gitCommonDir,
      repoCwd: parent.rootPath,
      destPath,
      branchName,
      baseRef: opts.baseRef
    })

    const id = randomUUID()
    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO workspaces (
           id, kind, name, root_path, is_git, git_common_dir, git_branch, base_commit,
           parent_workspace_id, owner_type, owner_id, readonly_refs_json, created_at, updated_at
         ) VALUES (?, 'git_worktree', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        `${parent.name} [${shortId}]`,
        destPath,
        parent.gitCommonDir,
        branchName,
        baseCommit,
        parent.parentWorkspaceId ?? parent.id,
        opts.ownerType ?? 'work_node',
        opts.ownerId ?? null,
        JSON.stringify(parent.readonlyRefs ?? []),
        now,
        now
      )
    return this.get(id)
  }

  async cleanWorktree(workspaceId: string, force = false): Promise<{ ok: true; branchPreserved: string | null }> {
    const ws = this.get(workspaceId)
    if (ws.kind !== 'git_worktree') {
      throw Errors.invalidParams(`Workspace "${ws.name}" is not a git_worktree`)
    }
    const activeRow = this.database.db
      .prepare(
        "SELECT COUNT(*) AS c FROM work_nodes WHERE workspace_id = ? AND status NOT IN ('completed','failed','cancelled')"
      )
      .get(workspaceId) as { c: number }
    if ((activeRow?.c ?? 0) > 0) {
      throw Errors.conflict('worktree_in_use', 'Worktree is still used by active work nodes')
    }

    if (ws.gitCommonDir) {
      await gitRemoveWorktree({
        repoMutex: this.repoMutex,
        gitCommonDir: ws.gitCommonDir,
        worktreePath: ws.rootPath,
        force
      })
    } else if (existsSync(ws.rootPath)) {
      rmSync(ws.rootPath, { recursive: true, force: true })
    }

    const now = Date.now()
    this.database.db
      .prepare('UPDATE workspaces SET cleaned_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, workspaceId)
    return { ok: true, branchPreserved: ws.gitBranch }
  }

  listTree(workspaceId: string, relDir = '', maxDepth = 1): FileEntry[] {
    const ws = this.get(workspaceId)
    const absDir = resolveContainedPath(ws.rootPath, relDir)
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
      throw Errors.notFound(`Directory not found: ${relDir || '/'}`)
    }

    const walk = (dir: string, depth: number): FileEntry[] => {
      const entries = readdirSync(dir, { withFileTypes: true })
      const out: FileEntry[] = []
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        let st: Stats
        try {
          st = statSync(full)
        } catch {
          continue
        }
        const rel = toPosixRelPath(ws.rootPath, full)
        const kind = st.isDirectory() ? 'dir' : 'file'
        out.push({ name: entry.name, path: rel, kind, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
        if (kind === 'dir' && depth < maxDepth) {
          out.push(...walk(full, depth + 1))
        }
      }
      return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    }

    return walk(absDir, 1)
  }

  readFile(
    workspaceId: string,
    relPath: string
  ): { content: string; encoding: 'utf8' | 'base64'; size: number; mtimeMs: number; binary: boolean } {
    const ws = this.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, relPath)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw Errors.notFound(`File not found: ${relPath}`)
    }
    const st = statSync(abs)
    if (st.size > MAX_READ_BYTES) {
      throw Errors.invalidParams(`File too large to preview (${st.size} bytes, limit ${MAX_READ_BYTES})`)
    }
    const buf = readFileSync(abs)
    // Simple binary detection: NUL byte in first 8KB
    const sample = buf.subarray(0, Math.min(buf.length, 8192))
    const binary = sample.includes(0)
    return {
      content: binary ? buf.toString('base64') : buf.toString('utf8'),
      encoding: binary ? 'base64' : 'utf8',
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      binary
    }
  }

  writeFile(
    workspaceId: string,
    relPath: string,
    content: string,
    expectedMtimeMs?: number
  ): { ok: true; mtimeMs: number } {
    const ws = this.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, relPath)
    if (expectedMtimeMs !== undefined && existsSync(abs)) {
      const currentMtime = Math.floor(statSync(abs).mtimeMs)
      if (Math.abs(currentMtime - expectedMtimeMs) > 5) {
        throw Errors.conflict('mtime_conflict', 'File was modified on disk since you opened it')
      }
    }
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    const nextMtime = Math.floor(statSync(abs).mtimeMs)
    return { ok: true, mtimeMs: nextMtime }
  }

  writeBinaryFile(
    workspaceId: string,
    relPath: string,
    data: Buffer
  ): { ok: true; path: string; size: number; mtimeMs: number } {
    const ws = this.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, relPath)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    const st = statSync(abs)
    return { ok: true, path: toPosixRelPath(ws.rootPath, abs), size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
  }

  mkdir(workspaceId: string, relPath: string): { ok: true } {
    const ws = this.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, relPath)
    mkdirSync(abs, { recursive: true })
    return { ok: true }
  }

  rename(workspaceId: string, relPath: string, newRelPath: string): { ok: true } {
    const ws = this.get(workspaceId)
    const from = resolveContainedPath(ws.rootPath, relPath)
    const to = resolveContainedPath(ws.rootPath, newRelPath)
    if (!existsSync(from)) throw Errors.notFound(`Path not found: ${relPath}`)
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(from, to)
    return { ok: true }
  }

  remove(workspaceId: string, relPath: string): { ok: true } {
    const ws = this.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, relPath)
    if (abs === path.resolve(ws.rootPath)) {
      throw Errors.pathOutOfBounds('Cannot delete workspace root directory')
    }
    if (!existsSync(abs)) throw Errors.notFound(`Path not found: ${relPath}`)
    rmSync(abs, { recursive: true, force: true })
    return { ok: true }
  }

  grep(
    workspaceId: string,
    pattern: string,
    relDir = '',
    limit = 50
  ): Array<{ path: string; line: number; text: string }> {
    const ws = this.get(workspaceId)
    const absDir = resolveContainedPath(ws.rootPath, relDir)
    const regex = new RegExp(pattern, 'i')
    const hits: Array<{ path: string; line: number; text: string }> = []

    const walk = (dir: string) => {
      if (hits.length >= limit) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (hits.length >= limit) return
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          try {
            const st = statSync(full)
            if (st.size > 512 * 1024) continue
            const buf = readFileSync(full)
            if (buf.subarray(0, 1024).includes(0)) continue
            const lines = buf.toString('utf8').split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i]!)) {
                hits.push({ path: toPosixRelPath(ws.rootPath, full), line: i + 1, text: lines[i]!.slice(0, 240) })
                if (hits.length >= limit) return
              }
            }
          } catch {
            // skip unreadable
          }
        }
      }
    }
    walk(absDir)
    return hits
  }
}
