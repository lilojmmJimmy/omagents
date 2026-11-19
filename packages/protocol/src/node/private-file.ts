import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function writePrivateFileSync(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, { mode: 0o600, encoding: 'utf8' })
  renameSync(tmp, filePath)
}
