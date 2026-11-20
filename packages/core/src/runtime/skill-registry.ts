import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Skill, SkillInstallInput } from '@myagents/protocol'
import { myagentsSkillsDir, planLaunch } from '@myagents/protocol/node'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import { resolveContainedPath } from '../workspace/path-guard'

const execFileAsync = promisify(execFile)
const MAX_SKILL_CHARS = 12_000
const MAX_TOTAL_SKILLS_CHARS = 32_000

interface SkillRow {
  id: string
  name: string
  source_type: Skill['sourceType']
  source_uri: string
  pinned_commit: string | null
  local_path: string
  description: string
  created_at: number
  updated_at: number
}

function mapSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceUri: row.source_uri,
    pinnedCommit: row.pinned_commit,
    localPath: row.local_path,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function parseSkillMarkdown(raw: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) {
    return { body: raw.trim() }
  }
  const frontmatter = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  let name: string | undefined
  let description: string | undefined

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    const val = kv[2]!.trim().replace(/^["'](.*)["']$/, '$1')
    if (key === 'name' && val) name = val
    else if (key === 'description' && val) description = val
  }

  return { name, description, body }
}

function findSkillMarkdownFile(targetPath: string): string | null {
  if (!existsSync(targetPath)) return null
  const st = statSync(targetPath)
  if (st.isFile()) {
    return /\.md$/i.test(targetPath) ? targetPath : null
  }
  if (!st.isDirectory()) return null

  for (const candidate of ['SKILL.md', 'skill.md', 'README.md']) {
    const p = path.join(targetPath, candidate)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  const mdFile = readdirSync(targetPath).find((entry) => /\.md$/i.test(entry) && statSync(path.join(targetPath, entry)).isFile())
  return mdFile ? path.join(targetPath, mdFile) : null
}

function assertSafeGitSource(sourceUri: string): string {
  const trimmed = sourceUri.trim()
  if (!trimmed || trimmed.startsWith('-')) {
    throw Errors.invalidParams('Invalid git repository source URI')
  }
  const hasAllowedScheme = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/i.test(trimmed)
  if (hasAllowedScheme) return trimmed
  const resolved = path.resolve(trimmed)
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return resolved
  }
  throw Errors.invalidParams('Git skill source must be https://, http://, ssh://, git@, file://, or an existing local directory')
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const launch = planLaunch('git', args, cwd, process.env)
  const { stdout } = await execFileAsync(launch.file, launch.args, {
    cwd,
    env: launch.env,
    timeout: 60_000,
    windowsHide: true
  })
  return stdout.trim()
}

export class SkillRegistryService {
  constructor(private readonly database: CoreDatabase) {}

  list(): Skill[] {
    const rows = this.database.db
      .prepare('SELECT * FROM skills ORDER BY created_at DESC')
      .all() as unknown as SkillRow[]
    return rows.map(mapSkill)
  }

  get(id: string): Skill {
    const row = this.database.db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .get(id) as unknown as SkillRow | undefined
    if (!row) throw Errors.notFound(`Skill not found: ${id}`)
    return mapSkill(row)
  }

  async install(input: SkillInstallInput): Promise<Skill> {
    const id = randomUUID()
    let localPath = ''
    let pinnedCommit: string | null = null
    let clonedDirToCleanup: string | null = null

    try {
      if (input.sourceType === 'local') {
        const resolved = path.resolve(input.sourceUri.trim())
        if (!existsSync(resolved)) {
          throw Errors.invalidParams(`Local skill path does not exist: ${resolved}`)
        }
        localPath = resolved
      } else {
        const gitSource = assertSafeGitSource(input.sourceUri)
        if (input.ref?.trim().startsWith('-')) {
          throw Errors.invalidParams('Invalid git ref')
        }
        const skillsRoot = myagentsSkillsDir()
        mkdirSync(skillsRoot, { recursive: true, mode: 0o700 })
        const destDir = path.join(skillsRoot, id)
        clonedDirToCleanup = destDir
        await runGit(['clone', '--depth', '1', '--', gitSource, destDir], skillsRoot)
        if (input.ref?.trim()) {
          await runGit(['fetch', '--depth', '1', 'origin', input.ref.trim()], destDir)
          await runGit(['checkout', 'FETCH_HEAD'], destDir)
        }
        pinnedCommit = await runGit(['rev-parse', 'HEAD'], destDir)
        localPath = destDir
      }

      const mdPath = findSkillMarkdownFile(localPath)
      if (!mdPath) {
        throw Errors.invalidParams(`No SKILL.md or markdown file found in ${localPath}`)
      }
      const parsed = parseSkillMarkdown(readFileSync(mdPath, 'utf8'))
      const derivedName = (
        input.name?.trim() ||
        parsed.name ||
        path.basename(localPath, path.extname(localPath))
      ).slice(0, 80)
      if (!derivedName) {
        throw Errors.invalidParams('Unable to determine skill name')
      }

      const dup = this.database.db
        .prepare('SELECT id FROM skills WHERE LOWER(name) = LOWER(?)')
        .get(derivedName)
      if (dup) {
        throw Errors.conflict('name_taken', `Skill name already exists: ${derivedName}`)
      }

      const description = (input.description?.trim() || parsed.description || '').slice(0, 1000)
      const now = Date.now()
      this.database.db
        .prepare(
          `INSERT INTO skills (id, name, source_type, source_uri, pinned_commit, local_path, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          derivedName,
          input.sourceType,
          input.sourceUri.trim(),
          pinnedCommit,
          localPath,
          description,
          now,
          now
        )

      clonedDirToCleanup = null
      return this.get(id)
    } finally {
      if (clonedDirToCleanup && existsSync(clonedDirToCleanup)) {
        rmSync(clonedDirToCleanup, { recursive: true, force: true })
      }
    }
  }

  remove(id: string): void {
    const existing = this.get(id)
    this.database.transaction(() => {
      const info = this.database.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
      if (info.changes === 0) throw Errors.notFound(`Skill not found: ${id}`)

      const agentRows = this.database.db
        .prepare('SELECT id, skill_ids_json FROM agents')
        .all() as Array<{ id: string; skill_ids_json: string }>
      const now = Date.now()
      for (const agent of agentRows) {
        const ids = JSON.parse(agent.skill_ids_json || '[]') as string[]
        if (ids.includes(id)) {
          const next = ids.filter((x) => x !== id)
          this.database.db
            .prepare('UPDATE agents SET skill_ids_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(next), now, agent.id)
        }
      }
    })

    if (existing.sourceType === 'git') {
      const skillsRoot = myagentsSkillsDir()
      if (existsSync(skillsRoot)) {
        const rel = path.relative(skillsRoot, existing.localPath)
        const contained = resolveContainedPath(skillsRoot, rel)
        if (existsSync(contained)) {
          rmSync(contained, { recursive: true, force: true })
        }
      }
    }
  }

  loadPromptSection(skillIds: readonly string[]): { promptBlock: string; skillsHash: string } {
    const uniqueIds = [...new Set(skillIds.map((id) => id.trim()).filter(Boolean))]
    if (uniqueIds.length === 0) {
      return { promptBlock: '', skillsHash: '' }
    }

    const sections: string[] = []
    let remaining = MAX_TOTAL_SKILLS_CHARS
    for (const id of uniqueIds) {
      const row = this.database.db
        .prepare('SELECT * FROM skills WHERE id = ?')
        .get(id) as unknown as SkillRow | undefined
      if (!row) continue
      const mdPath = findSkillMarkdownFile(row.local_path)
      if (!mdPath) continue
      let body = ''
      try {
        body = parseSkillMarkdown(readFileSync(mdPath, 'utf8')).body
      } catch {
        continue
      }
      if (!body) continue
      const clipped = body.slice(0, Math.min(MAX_SKILL_CHARS, remaining))
      if (!clipped) break
      const header = row.description ? `### ${row.name}\n${row.description}` : `### ${row.name}`
      sections.push(`${header}\n\n${clipped}`)
      remaining -= clipped.length
      if (remaining <= 0) break
    }

    if (sections.length === 0) {
      return { promptBlock: '', skillsHash: '' }
    }

    const promptBlock = `## Equipped Skills\n\n${sections.join('\n\n---\n\n')}`
    const skillsHash = createHash('sha256').update(promptBlock).digest('hex').slice(0, 12)
    return { promptBlock, skillsHash }
  }
}
