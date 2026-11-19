import { isPathOverlapping } from '../workspace/path-guard'

export interface ResourceClaim {
  key: string // 'member:<id>' | 'ws_read:<absPath>' | 'ws_write:<absPath>' | 'res:<name>'
  mode: 'read' | 'write'
  path?: string // populated for ws_read / ws_write
}

export function buildNodeClaims(opts: {
  memberId: string
  workspacePath: string | null
  workspaceMode: 'read-only' | 'shared-rw' | 'worktree'
  isWorktreeDir?: boolean
  extraResources: string[]
}): ResourceClaim[] {
  const claims: ResourceClaim[] = [{ key: `member:${opts.memberId}`, mode: 'write' }]
  if (opts.workspacePath) {
    if (opts.workspaceMode === 'read-only') {
      claims.push({ key: `ws_read:${opts.workspacePath}`, mode: 'read', path: opts.workspacePath })
    } else if (opts.workspaceMode === 'shared-rw' || opts.isWorktreeDir) {
      // Unprovisioned worktree nodes will get an isolated branch directory outside the parent repo,
      // so they must not hold ws_write on the parent repo before or during parallel worktree runs.
      claims.push({ key: `ws_write:${opts.workspacePath}`, mode: 'write', path: opts.workspacePath })
    }
  }
  for (const res of opts.extraResources) {
    if (!res || res === 'none') continue
    if (res.startsWith('workspace:')) {
      const p = res.slice('workspace:'.length)
      claims.push({ key: `ws_write:${p}`, mode: 'write', path: p })
    } else {
      claims.push({ key: `res:${res}`, mode: 'write' })
    }
  }
  return claims
}

function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (a.mode === 'read' && b.mode === 'read') return false
  if (a.path && b.path) {
    return isPathOverlapping(a.path, b.path)
  }
  return a.key === b.key
}

// Writer-Preferring RWLock with path containment overlap detection
export class ResourceLockManager {
  private readonly held = new Map<string, ResourceClaim[]>() // nodeId -> claims

  canAcquire(claims: ResourceClaim[], waitingAheadWriters: ResourceClaim[][] = []): boolean {
    for (const [, activeClaims] of this.held) {
      for (const req of claims) {
        for (const active of activeClaims) {
          if (claimsConflict(req, active)) return false
        }
      }
    }
    // Writer-preferring: if an earlier queued writer waits on an overlapping path, block new readers
    for (const req of claims) {
      if (req.mode !== 'read') continue
      for (const writerClaims of waitingAheadWriters) {
        for (const wc of writerClaims) {
          if (wc.mode === 'write' && claimsConflict(req, wc)) return false
        }
      }
    }
    return true
  }

  acquire(nodeId: string, claims: ResourceClaim[]): void {
    this.held.set(nodeId, claims)
  }

  release(nodeId: string): void {
    this.held.delete(nodeId)
  }

  has(nodeId: string): boolean {
    return this.held.has(nodeId)
  }

  clear(): void {
    this.held.clear()
  }
}
