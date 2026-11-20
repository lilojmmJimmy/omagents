import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UsageAnalyticsService } from './usage-service'
import { AgentService } from '../runtime/agent-service'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from '../workspace/workspace-service'

let tmpDir: string
const prevHome = process.env.MYAGENTS_HOME

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-usage-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('UsageAnalyticsService (T-302)', () => {
  it('aggregates tokens, costs, latency, rooms, models, agents, and time windows accurately', () => {
    const db = new CoreDatabase(':memory:')
    const workspaces = new WorkspaceService(db)
    const agents = new AgentService(db, workspaces)
    const analytics = new UsageAnalyticsService(db)

    const a1 = agents.create({
      name: 'CodexWorker',
      bio: '',
      systemPrompt: '',
      driverKind: 'codex',
      providerId: null,
      driverConfig: { model: 'gpt-5-codex' },
      permissionMode: 'workspace-write',
      isolationMode: 'standard',
      skillIds: [],
      mcpServerIds: []
    })
    const a2 = agents.create({
      name: 'ClaudeReviewer',
      bio: '',
      systemPrompt: '',
      driverKind: 'claude',
      providerId: null,
      driverConfig: { model: 'claude-sonnet-4' },
      permissionMode: 'workspace-write',
      isolationMode: 'standard',
      skillIds: [],
      mcpServerIds: []
    })

    const now = new Date(2026, 10, 20, 14, 0, 0).getTime()
    const insertRoom = db.db.prepare(
      `INSERT INTO rooms (id, title, purpose, strategy_id, primary_workspace_id, deleted_at, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?)`
    )
    const insertMember = db.db.prepare(
      `INSERT INTO room_members (id, room_id, agent_id, display_name, role_kind, position, joined_at)
       VALUES (?, ?, ?, ?, 'member', 0, ?)`
    )
    const insertNode = db.db.prepare(
      `INSERT INTO work_nodes (
         id, room_id, root_node_id, assignee_member_id, assignee_agent_id, kind, status,
         instruction, usage_json, started_at, ended_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'turn', ?, 'run', ?, ?, ?, ?, ?)`
    )

    insertRoom.run('room-1', 'Alpha Feature', 'open-channel', a1.defaultWorkspaceId, null, now, now)
    insertRoom.run('room-2', 'Beta Review', 'single', a2.defaultWorkspaceId, null, now, now)
    insertRoom.run('room-del', 'Deleted Room', 'single', a1.defaultWorkspaceId, now, now, now)

    insertMember.run('mem-1', 'room-1', a1.id, a1.name, now)
    insertMember.run('mem-2', 'room-1', a2.id, a2.name, now)
    insertMember.run('mem-3', 'room-2', a2.id, a2.name, now)
    insertMember.run('mem-del', 'room-del', a1.id, a1.name, now)

    // 1. 2h ago (included in 24h, 7d, 30d, all)
    const t2h = now - 2 * 3_600_000
    insertNode.run(
      'n1',
      'room-1',
      'n1',
      'mem-1',
      a1.id,
      'completed',
      JSON.stringify({ model: 'gpt-5-codex', inputTokens: 1000, outputTokens: 500, costUsd: 0.02, durationMs: 2000, ttftMs: 400 }),
      t2h,
      t2h + 2000,
      t2h,
      t2h
    )

    // 2. 3d ago failed (excluded from 24h, included in 7d/30d/all)
    const t3d = now - 3 * 86_400_000
    insertNode.run(
      'n2',
      'room-2',
      'n2',
      'mem-3',
      a2.id,
      'failed',
      JSON.stringify({ model: 'claude-sonnet-4', inputTokens: 2000, outputTokens: 100, costUsd: 0.05, ttftMs: 600 }),
      t3d,
      t3d + 4000,
      t3d,
      t3d
    )

    // 3. 20d ago (excluded from 24h & 7d, included in 30d & all)
    const t20d = now - 20 * 86_400_000
    insertNode.run(
      'n3',
      'room-1',
      'n3',
      'mem-2',
      a2.id,
      'completed',
      JSON.stringify({ model: 'claude-sonnet-4', inputTokens: 4000, outputTokens: 1000, cacheReadTokens: 500, costUsd: 0.1 }),
      t20d,
      t20d + 3000,
      t20d,
      t20d
    )

    // 4. Node inside deleted room (always excluded)
    insertNode.run(
      'n-del',
      'room-del',
      'n-del',
      'mem-del',
      a1.id,
      'completed',
      JSON.stringify({ model: 'gpt-5-codex', inputTokens: 99999, outputTokens: 99999, costUsd: 99 }),
      t2h,
      t2h + 1000,
      t2h,
      t2h
    )

    const rep24 = analytics.getReport({ window: '24h' }, now)
    expect(rep24.byDay).toHaveLength(24)
    expect(rep24.totals.runs).toBe(1)
    expect(rep24.totals.totalTokens).toBe(1500)
    expect(rep24.totals.costUsd).toBe(0.02)

    const rep7 = analytics.getReport({ window: '7d' }, now)
    expect(rep7.byDay).toHaveLength(7)
    expect(rep7.totals.runs).toBe(2)
    expect(rep7.totals.completedRuns).toBe(1)
    expect(rep7.totals.failedRuns).toBe(1)
    expect(rep7.totals.totalTokens).toBe(3600)
    expect(rep7.totals.avgDurationMs).toBe(3000)
    expect(rep7.totals.avgTtftMs).toBe(500)

    const rep30 = analytics.getReport({ window: '30d' }, now)
    expect(rep30.totals.runs).toBe(3)
    expect(rep30.totals.totalTokens).toBe(8600)
    expect(rep30.totals.cacheReadTokens).toBe(500)
    expect(rep30.totals.costUsd).toBe(0.17)
    expect(rep30.byModel.map((m) => m.model)).toEqual(['claude-sonnet-4', 'gpt-5-codex'])
    expect(rep30.byAgent[0]!.agentId).toBe(a2.id)
    expect(rep30.byRoom[0]!.roomId).toBe('room-1')
    expect(rep30.recentRuns).toHaveLength(3)

    const filteredAgent = analytics.getReport({ window: 'all', agentId: a1.id }, now)
    expect(filteredAgent.totals.runs).toBe(1)
    expect(filteredAgent.totals.costUsd).toBe(0.02)

    db.close()
  })
})
