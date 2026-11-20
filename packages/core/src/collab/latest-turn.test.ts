import { describe, expect, it } from 'vitest'
import { pickLatestRetryableNode, type WorkNode } from '@myagents/protocol'
import { AgentService } from '../runtime/agent-service'
import { AgentEnvironmentIsolator } from '../runtime/environment-isolator'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from '../workspace/workspace-service'
import { CollabEngine } from './collab-engine'

function makeNode(overrides: Partial<WorkNode> & { id: string }): WorkNode {
  return {
    roomId: 'room-1',
    rootNodeId: overrides.id,
    parentNodeId: null,
    supersedesNodeId: null,
    transferredToNodeId: null,
    requestMsgId: null,
    assigneeMemberId: 'member-1',
    assigneeAgentId: 'agent-1',
    kind: 'turn',
    status: 'completed',
    blockingReason: null,
    superstep: null,
    instruction: 'test',
    expectedResult: null,
    workspaceMode: 'read-only',
    workspaceId: null,
    resources: [],
    resultText: null,
    resultJson: null,
    usage: null,
    errorText: null,
    attempt: 1,
    depth: 0,
    createdAt: 1000,
    startedAt: 1000,
    endedAt: 1001,
    updatedAt: 1001,
    ...overrides
  }
}

describe('pickLatestRetryableNode', () => {
  it('returns undefined when an older node failed but a newer turn completed', () => {
    const oldFailed = makeNode({
      id: 'n1',
      requestMsgId: 'm1',
      status: 'failed',
      errorText: 'codex timeout',
      createdAt: 1000,
      updatedAt: 1500
    })
    const newCompleted = makeNode({
      id: 'n2',
      requestMsgId: 'm2',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 2500
    })

    expect(pickLatestRetryableNode([newCompleted, oldFailed])).toBeUndefined()
  })

  it('returns the failed node when the latest single turn failed', () => {
    const olderCompleted = makeNode({
      id: 'n1',
      requestMsgId: 'm1',
      status: 'completed',
      createdAt: 1000,
      updatedAt: 1500
    })
    const latestFailed = makeNode({
      id: 'n2',
      requestMsgId: 'm2',
      status: 'failed',
      errorText: 'driver error',
      createdAt: 2000,
      updatedAt: 2500
    })

    expect(pickLatestRetryableNode([latestFailed, olderCompleted])?.id).toBe('n2')
  })

  it('returns a failed sibling within the same latest parallel request or roundtable superstep', () => {
    const parallelFailed = makeNode({
      id: 'p1',
      requestMsgId: 'msg-parallel',
      status: 'failed',
      errorText: 'worker error',
      createdAt: 2000,
      updatedAt: 2400
    })
    const parallelDone = makeNode({
      id: 'p2',
      requestMsgId: 'msg-parallel',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 2600
    })
    expect(pickLatestRetryableNode([parallelDone, parallelFailed])?.id).toBe('p1')

    const rtFailed = makeNode({
      id: 'r1',
      superstep: 2,
      status: 'failed',
      errorText: 'roundtable error',
      createdAt: 3000,
      updatedAt: 3200
    })
    const rtDone = makeNode({
      id: 'r2',
      superstep: 2,
      status: 'completed',
      createdAt: 3000,
      updatedAt: 3500
    })
    expect(pickLatestRetryableNode([rtDone, rtFailed])?.id).toBe('r1')
  })

  it('ignores a failed node superseded by a completed replacement node', () => {
    const supersededFailed = makeNode({
      id: 'n1',
      requestMsgId: 'm1',
      status: 'failed',
      errorText: 'old failure',
      createdAt: 1000,
      updatedAt: 1500
    })
    const replacementCompleted = makeNode({
      id: 'n2',
      requestMsgId: 'm1',
      supersedesNodeId: 'n1',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 2500
    })

    expect(pickLatestRetryableNode([replacementCompleted, supersededFailed])).toBeUndefined()
  })

  it('returns an older retried node if its updatedAt is newest and it failed again', () => {
    const retriedOldNode = makeNode({
      id: 'n1',
      requestMsgId: 'm1',
      status: 'failed',
      attempt: 2,
      errorText: 'retry failed',
      createdAt: 1000,
      updatedAt: 4000
    })
    const earlierCompleted = makeNode({
      id: 'n2',
      requestMsgId: 'm2',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 2500
    })

    expect(pickLatestRetryableNode([earlierCompleted, retriedOldNode])?.id).toBe('n1')
  })
})

describe('CollabEngine.getRoom hasFailedNode', () => {
  function setupEngine() {
    const database = new CoreDatabase(':memory:')
    const workspaces = new WorkspaceService(database)
    const agents = new AgentService(database, workspaces)
    const isolator = new AgentEnvironmentIsolator()
    const daemon = {} as any
    const engine = new CollabEngine(database, agents, workspaces, isolator, daemon, {
      roomUpdated: () => {},
      roomDeleted: () => {},
      messageCreated: () => {},
      streamDelta: () => {},
      workNodeUpdated: () => {}
    })

    const now = 1000
    database.db
      .prepare(
        `INSERT INTO workspaces (id, kind, name, root_path, is_git, owner_type, owner_id, readonly_refs_json, created_at, updated_at)
         VALUES ('ws-1', 'project', 'Test WS', '/tmp/test-ws', 0, 'global', NULL, '[]', ?, ?)`
      )
      .run(now, now)
    database.db
      .prepare(
        `INSERT INTO agents (id, name, bio, avatar_json, system_prompt, driver_kind, provider_id, driver_config_json, default_workspace_id, permission_mode, isolation_mode, created_at, updated_at)
         VALUES ('ag-1', 'Agent1', '', '{}', '', 'codex', NULL, '{}', 'ws-1', 'read-only', 'standard', ?, ?)`
      )
      .run(now, now)
    database.db
      .prepare(
        `INSERT INTO rooms (id, title, purpose, strategy_id, primary_workspace_id, created_at, updated_at)
         VALUES ('room-1', 'Room 1', '', 'open-channel', 'ws-1', ?, ?)`
      )
      .run(now, now)
    database.db
      .prepare(
        `INSERT INTO room_members (id, room_id, agent_id, display_name, role_kind, position, joined_at)
         VALUES ('mem-1', 'room-1', 'ag-1', 'Agent1', 'lead', 0, ?)`
      )
      .run(now)

    return { database, engine }
  }

  function insertMessage(database: CoreDatabase, id: string, seq: number) {
    database.db
      .prepare(
        `INSERT INTO room_messages (id, room_id, seq, visible_seq, author_kind, author_id, author_name, kind, content, created_at)
         VALUES (?, 'room-1', ?, ?, 'human', 'admin', 'admin', 'chat', 'hi', ?)`
      )
      .run(id, seq, seq, 1000 + seq)
  }

  function insertWorkNode(
    database: CoreDatabase,
    opts: {
      id: string
      rootNodeId?: string
      supersedesNodeId?: string | null
      requestMsgId?: string | null
      status: string
      createdAt: number
      updatedAt: number
    }
  ) {
    database.db
      .prepare(
        `INSERT INTO work_nodes (
           id, room_id, root_node_id, supersedes_node_id, request_msg_id, assignee_member_id, assignee_agent_id,
           kind, status, instruction, workspace_mode, created_at, updated_at
         ) VALUES (?, 'room-1', ?, ?, ?, 'mem-1', 'ag-1', 'turn', ?, 'do it', 'read-only', ?, ?)`
      )
      .run(
        opts.id,
        opts.rootNodeId ?? opts.id,
        opts.supersedesNodeId ?? null,
        opts.requestMsgId ?? null,
        opts.status,
        opts.createdAt,
        opts.updatedAt
      )
  }

  it('clears hasFailedNode once a newer turn completes', () => {
    const { database, engine } = setupEngine()
    insertMessage(database, 'msg-1', 1)
    insertMessage(database, 'msg-2', 2)
    insertWorkNode(database, { id: 'wn-1', requestMsgId: 'msg-1', status: 'failed', createdAt: 1000, updatedAt: 1500 })
    expect(engine.getRoom('room-1').hasFailedNode).toBe(true)

    insertWorkNode(database, { id: 'wn-2', requestMsgId: 'msg-2', status: 'completed', createdAt: 2000, updatedAt: 2500 })
    expect(engine.getRoom('room-1').hasFailedNode).toBe(false)
    database.close()
  })

  it('keeps hasFailedNode true when a parallel sibling in the latest batch failed', () => {
    const { database, engine } = setupEngine()
    insertMessage(database, 'msg-1', 1)
    insertWorkNode(database, { id: 'wn-1', requestMsgId: 'msg-1', status: 'failed', createdAt: 2000, updatedAt: 2200 })
    insertWorkNode(database, { id: 'wn-2', requestMsgId: 'msg-1', status: 'completed', createdAt: 2000, updatedAt: 2500 })

    expect(engine.getRoom('room-1').hasFailedNode).toBe(true)
    database.close()
  })

  it('ignores a superseded failed node replaced by a completed node', () => {
    const { database, engine } = setupEngine()
    insertMessage(database, 'msg-1', 1)
    insertWorkNode(database, { id: 'wn-1', requestMsgId: 'msg-1', status: 'failed', createdAt: 1000, updatedAt: 1500 })
    insertWorkNode(database, {
      id: 'wn-2',
      requestMsgId: 'msg-1',
      supersedesNodeId: 'wn-1',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 2500
    })

    expect(engine.getRoom('room-1').hasFailedNode).toBe(false)
    database.close()
  })
})
