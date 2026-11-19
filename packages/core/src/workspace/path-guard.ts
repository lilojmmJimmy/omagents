import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { Errors } from '../errors'

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isPathOverlapping(pathA: string, pathB: string): boolean {
  const a = normalizeForCompare(pathA)
  const b = normalizeForCompare(pathB)
  const relAB = path.relative(a, b)
  const relBA = path.relative(b, a)
  return (
    relAB === '' ||
    (!relAB.startsWith(`..${path.sep}`) && relAB !== '..' && !path.isAbsolute(relAB)) ||
    (!relBA.startsWith(`..${path.sep}`) && relBA !== '..' && !path.isAbsolute(relBA))
  )
}

export function resolveContainedPath(rootDir: string, relPath = ''): string {
  const realRoot = existsSync(rootDir) ? realpathSync(rootDir) : path.resolve(rootDir)
  const cleaned = relPath.replaceAll('\\', '/').replace(/^\/+/, '')
  const candidate = path.resolve(realRoot, cleaned)

  const checkInside = (target: string): boolean => {
    const rootCmp = normalizeForCompare(realRoot)
    const targetCmp = normalizeForCompare(target)
    const rel = path.relative(rootCmp, targetCmp)
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
  }

  if (!checkInside(candidate)) {
    throw Errors.pathOutOfBounds(`Path escapes workspace boundary: ${relPath}`)
  }

  // Also check nearest existing ancestor's realpath to prevent symlink escape
  let cursor = candidate
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (existsSync(cursor)) {
    const realCursor = realpathSync(cursor)
    if (!checkInside(realCursor)) {
      throw Errors.pathOutOfBounds(`Symlink escapes workspace boundary: ${relPath}`)
    }
  }

  return candidate
}

export function toPosixRelPath(rootDir: string, absPath: string): string {
  return path.relative(rootDir, absPath).split(path.sep).join('/')
}
