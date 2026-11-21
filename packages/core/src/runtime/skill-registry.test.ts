import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { myagentsSkillsDir } from '@myagents/protocol/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from '../workspace/workspace-service'
import { AgentService } from './agent-service'
import { parseSkillMarkdown, SkillRegistryService } from './skill-registry'

let tmpDir: string
const prevHome = process.env.MYAGENTS_HOME

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-skill-reg-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SkillRegistryService', () => {
  it('parses SKILL.md frontmatter, installs local skills, computes prompt hash, and cascades removal', async () => {
    const parsed = parseSkillMarkdown(
      `---\nname: code-auditor\ndescription: Checks edge cases.\n---\n\nAlways verify inputs.`
    )
    expect(parsed).toEqual({
      name: 'code-auditor',
      description: 'Checks edge cases.',
      body: 'Always verify inputs.'
    })

    const localSkillDir = path.join(tmpDir, 'local-skill')
    mkdirSync(localSkillDir, { recursive: true })
    writeFileSync(
      path.join(localSkillDir, 'SKILL.md'),
      `---\nname: code-auditor\ndescription: Checks edge cases.\n---\n\nVerify error handling and edge cases.`,
      'utf8'
    )

    const db = new CoreDatabase(':memory:')
    const workspaces = new WorkspaceService(db)
    const agents = new AgentService(db, workspaces)
    const registry = new SkillRegistryService(db)

    const skill = await registry.install({
      sourceType: 'local',
      sourceUri: localSkillDir
    })
    expect(skill.name).toBe('code-auditor')
    expect(skill.description).toBe('Checks edge cases.')
    expect(skill.pinnedCommit).toBeNull()

    await expect(registry.install({ sourceType: 'local', sourceUri: localSkillDir })).rejects.toThrow(/already exists/)

    const section = registry.loadPromptSection([skill.id])
    expect(section.promptBlock).toContain('## Equipped Skills')
    expect(section.promptBlock).toContain('### code-auditor')
    expect(section.promptBlock).toContain('Verify error handling and edge cases.')
    expect(section.skillsHash).toMatch(/^[a-f0-9]{12}$/)

    const agent = agents.create({
      name: 'SkilledAgent',
      bio: '',
      systemPrompt: '',
      driverKind: 'codex',
      driverConfig: {},
      permissionMode: 'read-only',
      isolationMode: 'standard',
      skillIds: [skill.id],
      mcpServerIds: []
    })
    expect(agents.get(agent.id).skillIds).toEqual([skill.id])

    registry.remove(skill.id)
    expect(registry.list()).toEqual([])
    expect(agents.get(agent.id).skillIds).toEqual([])
    expect(existsSync(localSkillDir)).toBe(true)
    db.close()
  })

  it('clones git-based skills, pins commit hash, and deletes managed clone directory on remove', async () => {
    const repoDir = path.join(tmpDir, 'git-skill-src')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir })
    writeFileSync(
      path.join(repoDir, 'SKILL.md'),
      `---\nname: git-reviewer\ndescription: Reviews diffs cleanly.\n---\n\nFocus on correctness first.`,
      'utf8'
    )
    execFileSync('git', ['add', 'SKILL.md'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'init skill'], { cwd: repoDir })
    const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()

    const db = new CoreDatabase(':memory:')
    const registry = new SkillRegistryService(db)
    const installed = await registry.install({
      sourceType: 'git',
      sourceUri: repoDir
    })

    expect(installed.name).toBe('git-reviewer')
    expect(installed.pinnedCommit).toBe(expectedHead)
    expect(installed.localPath.startsWith(myagentsSkillsDir())).toBe(true)
    expect(existsSync(installed.localPath)).toBe(true)

    registry.remove(installed.id)
    expect(existsSync(installed.localPath)).toBe(false)
    db.close()
  })
})
