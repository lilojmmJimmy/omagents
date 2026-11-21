import { describe, expect, it } from 'vitest'
import { buildNodeClaims, ResourceLockManager } from './rw-lock'

describe('ResourceLockManager (Writer-Preferring RWLock)', () => {
  it('allows concurrent readers on the same workspace for different members', () => {
    const locks = new ResourceLockManager()
    const c1 = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/repo/app',
      workspaceMode: 'read-only',
      extraResources: []
    })
    const c2 = buildNodeClaims({
      memberId: 'm2',
      workspacePath: '/repo/app',
      workspaceMode: 'read-only',
      extraResources: []
    })

    expect(locks.canAcquire(c1)).toBe(true)
    locks.acquire('n1', c1)
    expect(locks.canAcquire(c2)).toBe(true)
  })

  it('enforces strict single-seat serialization for same memberId', () => {
    const locks = new ResourceLockManager()
    const c1 = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/repo/app',
      workspaceMode: 'read-only',
      extraResources: []
    })
    const c2 = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/repo/other',
      workspaceMode: 'read-only',
      extraResources: []
    })

    locks.acquire('n1', c1)
    expect(locks.canAcquire(c2)).toBe(false)
    locks.release('n1')
    expect(locks.canAcquire(c2)).toBe(true)
  })

  it('blocks overlapping ancestor/child workspace writes and prevents writer starvation', () => {
    const locks = new ResourceLockManager()
    const reader1 = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/repo/app/src',
      workspaceMode: 'read-only',
      extraResources: []
    })
    const writer = buildNodeClaims({
      memberId: 'm2',
      workspacePath: '/repo/app',
      workspaceMode: 'shared-rw',
      extraResources: []
    })
    const reader2 = buildNodeClaims({
      memberId: 'm3',
      workspacePath: '/repo/app/docs',
      workspaceMode: 'read-only',
      extraResources: []
    })

    locks.acquire('n1', reader1)
    // Writer cannot acquire while reader holds overlapping subpath
    expect(locks.canAcquire(writer)).toBe(false)
    // New reader is blocked when writer is waiting ahead (writer-preferring)
    expect(locks.canAcquire(reader2, [writer])).toBe(false)

    // Once reader1 releases, writer acquires
    locks.release('n1')
    expect(locks.canAcquire(writer)).toBe(true)
    locks.acquire('n2', writer)
    expect(locks.canAcquire(reader2)).toBe(false)
  })

  it('allows parallel worktree nodes on the same parent repo before provisioning, while locking provisioned worktree paths', () => {
    const locks = new ResourceLockManager()
    const wt1Pending = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/repo/app',
      workspaceMode: 'worktree',
      isWorktreeDir: false,
      extraResources: []
    })
    const wt2Pending = buildNodeClaims({
      memberId: 'm2',
      workspacePath: '/repo/app',
      workspaceMode: 'worktree',
      isWorktreeDir: false,
      extraResources: []
    })

    locks.acquire('n1', wt1Pending)
    expect(locks.canAcquire(wt2Pending)).toBe(true)

    const wt1Active = buildNodeClaims({
      memberId: 'm1',
      workspacePath: '/home/worktrees/aaaa1111/app',
      workspaceMode: 'worktree',
      isWorktreeDir: true,
      extraResources: []
    })
    const sameWtReader = buildNodeClaims({
      memberId: 'm3',
      workspacePath: '/home/worktrees/aaaa1111/app',
      workspaceMode: 'read-only',
      isWorktreeDir: true,
      extraResources: []
    })
    locks.acquire('n1', wt1Active)
    expect(locks.canAcquire(sameWtReader)).toBe(false)
  })
})
