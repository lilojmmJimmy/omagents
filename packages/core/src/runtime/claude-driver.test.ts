import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClaudeSessionFilePath } from './claude-driver'

describe('resolveClaudeSessionFilePath', () => {
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tmpDir: string | null = null

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      tmpDir = null
    }
  })

  it('returns null when nativeSessionId is null', () => {
    expect(resolveClaudeSessionFilePath('/tmp/work', null)).toBeNull()
  })

  it('resolves existing Claude session jsonl path under CLAUDE_CONFIG_DIR/projects', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-claude-path-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    const wsRoot = path.join(tmpDir, 'my workspace (v1)')
    const encoded = path.resolve(wsRoot).replace(/[^a-zA-Z0-9-]/g, '-')
    const sessionId = '24ba7310-c4df-488e-b19b-006a88412460'
    const projectDir = path.join(tmpDir, 'projects', encoded)
    mkdirSync(projectDir, { recursive: true })
    const expected = path.join(projectDir, `${sessionId}.jsonl`)
    writeFileSync(expected, '{"type":"user"}\n', 'utf8')

    expect(resolveClaudeSessionFilePath(wsRoot, sessionId)).toBe(expected)
  })
})
