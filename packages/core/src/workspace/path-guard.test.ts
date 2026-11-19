import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isPathOverlapping, resolveContainedPath } from './path-guard'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'myagents-path-test-'))
writeFileSync(path.join(tmpRoot, 'hello.txt'), 'ok', 'utf8')

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('workspace path guard', () => {
  it('resolves valid paths inside workspace', () => {
    const p = resolveContainedPath(tmpRoot, 'hello.txt')
    expect(p.endsWith('hello.txt')).toBe(true)
  })

  it('rejects parent directory traversal', () => {
    expect(() => resolveContainedPath(tmpRoot, '../outside.txt')).toThrow(/escapes workspace boundary/)
    expect(() => resolveContainedPath(tmpRoot, 'a/../../outside.txt')).toThrow(/escapes workspace boundary/)
  })

  it('detects overlapping paths', () => {
    expect(isPathOverlapping(tmpRoot, path.join(tmpRoot, 'sub', 'dir'))).toBe(true)
    expect(isPathOverlapping(path.join(tmpRoot, 'a'), path.join(tmpRoot, 'b'))).toBe(false)
  })
})
