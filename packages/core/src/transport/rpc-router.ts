import {
  AGENT_DESCRIPTORS,
  AgentCreateInput,
  AgentUpdateInput,
  InboxStatus,
  ModelProviderSaveInput,
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  RoutingRuleSaveInput,
  WorkNodeControlAction,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess
} from '@myagents/protocol'
import { z } from 'zod'
import type { CollabEngine } from '../collab/collab-engine'
import type { DaemonClient } from '../daemon-client'
import { AppError, Errors } from '../errors'
import type { InboxService } from '../inbox/inbox-service'
import type { PluginManager } from '../inbox/plugin-manager'
import type { AgentService } from '../runtime/agent-service'
import type { EnvCheckService } from '../runtime/env-check'
import type { ProviderService } from '../runtime/provider-service'
import type { AuthService } from '../security/auth-service'
import type { GitService } from '../workspace/git-service'
import type { TerminalService } from '../workspace/terminal-service'
import type { WorkspaceService } from '../workspace/workspace-service'

export interface RpcDeps {
  auth: AuthService
  daemon: DaemonClient
  providers: ProviderService
  envCheck: EnvCheckService
  agents: AgentService
  workspaces: WorkspaceService
  git: GitService
  terminals: TerminalService
  collab: CollabEngine
  inbox?: InboxService
  plugins?: PluginManager
  isNonLoopback: boolean
}

export class RpcRouter {
  constructor(private readonly deps: RpcDeps) {}

  async dispatch(req: JsonRpcRequest, actorUsername: string): Promise<JsonRpcSuccess | JsonRpcError> {
    try {
      const result = await this.handleMethod(req.method, req.params ?? {}, actorUsername)
      return { jsonrpc: '2.0', id: req.id, result }
    } catch (err) {
      if (err instanceof AppError) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: err.code,
            message: err.message,
            data: { reason: err.reason, details: err.details }
          }
        }
      }
      if (err instanceof z.ZodError) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: RPC_ERROR_CODES.INVALID_PARAMS,
            message: 'Invalid parameters',
            data: { reason: 'invalid_params', details: err.flatten() }
          }
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: RPC_ERROR_CODES.INTERNAL_ERROR,
          message,
          data: { reason: 'internal_error' }
        }
      }
    }
  }

  private async handleMethod(method: string, params: unknown, actorUsername: string): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>

    switch (method) {
      // System
      case 'system.hello':
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: '0.1.0',
          features: [
            'single-chat',
            'open-channel',
            'builtin-agent',
            'claude-cli',
            'env-isolation',
            'git-worktree',
            'mcp-collab-bridge',
            'workspace-files',
            'git-diff',
            'web-terminal'
          ],
          daemonConnected: this.deps.daemon.isConnected,
          reconciling: this.deps.collab.isReconciling,
          defaultPasswordWarning: this.deps.isNonLoopback && this.deps.auth.isDefaultPassword()
        }
      case 'system.envCheck':
        return await this.deps.envCheck.check(Boolean(p.refresh))

      // Model Providers
      case 'providers.list':
        return this.deps.providers.list()
      case 'providers.save':
        return this.deps.providers.save(ModelProviderSaveInput.parse(p))
      case 'providers.delete':
        this.deps.providers.delete(z.string().min(1).parse(p.id))
        return { ok: true }
      case 'providers.probe':
        return await this.deps.providers.probe(z.string().min(1).parse(p.id))

      // Agents
      case 'agents.descriptors':
        return AGENT_DESCRIPTORS
      case 'agents.list':
        return this.deps.agents.list(Boolean(p.includeArchived))
      case 'agents.get':
        return this.deps.agents.get(z.string().min(1).parse(p.id))
      case 'agents.create':
        return this.deps.agents.create(AgentCreateInput.parse(p))
      case 'agents.update': {
        const id = z.string().min(1).parse(p.id)
        const patch = AgentUpdateInput.parse(p.patch ?? {})
        return this.deps.agents.update(id, patch)
      }
      case 'agents.archive':
        return this.deps.agents.archive(z.string().min(1).parse(p.id), z.boolean().parse(p.archived))

      // Workspaces & Files
      case 'workspaces.list':
        return this.deps.workspaces.list(typeof p.kind === 'string' ? (p.kind as any) : undefined)
      case 'workspaces.registerProject':
        return await this.deps.workspaces.registerProject(
          z.object({
            name: z.string().optional(),
            rootPath: z.string().min(1),
            readonlyRefPaths: z.array(z.string()).optional()
          }).parse(p)
        )
      case 'workspaces.createWorktree':
        return await this.deps.workspaces.createWorktree(
          z.object({
            projectWorkspaceId: z.string().min(1),
            baseRef: z.string().optional(),
            branchSlug: z.string().optional()
          }).parse(p)
        )
      case 'workspaces.cleanWorktree':
        return await this.deps.workspaces.cleanWorktree(
          z.string().min(1).parse(p.workspaceId),
          Boolean(p.force)
        )
      case 'files.tree':
        return this.deps.workspaces.listTree(
          z.string().min(1).parse(p.workspaceId),
          typeof p.dir === 'string' ? p.dir : '',
          typeof p.depth === 'number' ? Math.min(4, Math.max(1, p.depth)) : 1
        )
      case 'files.read':
        return this.deps.workspaces.readFile(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.path)
        )
      case 'files.write':
        return this.deps.workspaces.writeFile(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.path),
          z.string().parse(p.content),
          typeof p.expectedMtimeMs === 'number' ? p.expectedMtimeMs : undefined
        )
      case 'files.mkdir':
        return this.deps.workspaces.mkdir(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.path)
        )
      case 'files.rename':
        return this.deps.workspaces.rename(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.path),
          z.string().min(1).parse(p.newPath)
        )
      case 'files.remove':
        return this.deps.workspaces.remove(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.path)
        )
      case 'files.search':
        return this.deps.workspaces.grep(
          z.string().min(1).parse(p.workspaceId),
          z.string().min(1).parse(p.query),
          typeof p.dir === 'string' ? p.dir : '',
          typeof p.limit === 'number' ? Math.min(100, p.limit) : 50
        )

      // Git
      case 'git.status': {
        const ws = this.deps.workspaces.get(z.string().min(1).parse(p.workspaceId))
        return await this.deps.git.status(ws.rootPath)
      }
      case 'git.diff': {
        const ws = this.deps.workspaces.get(z.string().min(1).parse(p.workspaceId))
        const files = await this.deps.git.diff(
          ws.rootPath,
          typeof p.path === 'string' ? p.path : undefined,
          typeof p.baseCommit === 'string' ? p.baseCommit : undefined
        )
        return { files }
      }

      // Terminals
      case 'terminal.list':
        return this.deps.terminals.list(typeof p.workspaceId === 'string' ? p.workspaceId : undefined)
      case 'terminal.open': {
        const parsed = z.object({
          workspaceId: z.string().min(1),
          cols: z.number().int().min(20).max(500).default(100),
          rows: z.number().int().min(5).max(200).default(30)
        }).parse(p)
        const session = await this.deps.terminals.open(parsed.workspaceId, parsed.cols, parsed.rows)
        return { ...session, wsPath: `/ws/terminal/${session.id}` }
      }
      case 'terminal.close':
        await this.deps.terminals.close(z.string().min(1).parse(p.terminalId))
        return { ok: true }

      // Rooms & WorkNodes
      case 'rooms.strategies':
        return this.deps.collab.listStrategies()
      case 'rooms.list':
        return this.deps.collab.listRooms(Boolean(p.includeArchived))
      case 'rooms.get':
        return this.deps.collab.getRoom(z.string().min(1).parse(p.id))
      case 'rooms.create': {
        const parsed = z.object({
          title: z.string().optional(),
          purpose: z.string().optional(),
          strategyId: z.string().default('single'),
          strategyConfig: z.record(z.unknown()).optional(),
          primaryWorkspaceId: z.string().nullable().optional(),
          members: z.array(z.object({
            agentId: z.string().min(1),
            displayName: z.string().optional(),
            roleKind: z.enum(['lead', 'chair', 'member']).optional(),
            rolePrompt: z.string().optional()
          })).min(1),
          initialPrompt: z.string().optional()
        }).parse(p)
        return await this.deps.collab.createRoom(parsed)
      }
      case 'rooms.update': {
        const parsed = z.object({
          id: z.string().min(1),
          title: z.string().optional(),
          strategyConfig: z.record(z.unknown()).optional(),
          sharedMemories: z.array(
            z.object({
              id: z.string(),
              text: z.string(),
              authorId: z.string(),
              updatedAt: z.number()
            })
          ).optional()
        }).parse(p)
        return await this.deps.collab.updateRoom(parsed.id, {
          title: parsed.title,
          strategyConfig: parsed.strategyConfig,
          sharedMemories: parsed.sharedMemories
        })
      }
      case 'rooms.control': {
        const parsed = z.object({
          roomId: z.string().min(1),
          action: z.enum(['pause', 'resume', 'stop', 'next_round', 'summarize_now'])
        }).parse(p)
        return await this.deps.collab.controlRoom(parsed.roomId, parsed.action)
      }
      case 'rooms.handoff': {
        const parsed = z.object({
          sourceRoomId: z.string().min(1),
          sourceMsgId: z.string().optional(),
          targetStrategyId: z.string().default('open-channel'),
          title: z.string().optional(),
          workspaceId: z.string().nullable().optional(),
          seedText: z.string().optional(),
          members: z.array(z.object({
            agentId: z.string().min(1),
            displayName: z.string().optional(),
            roleKind: z.enum(['lead', 'chair', 'member']).optional(),
            rolePrompt: z.string().optional()
          })).min(1)
        }).parse(p)
        return await this.deps.collab.handoffRoom(parsed)
      }
      case 'rooms.delete':
        await this.deps.collab.deleteRoom(z.string().min(1).parse(p.id))
        return { ok: true }
      case 'rooms.messages':
        return this.deps.collab.listMessages(
          z.string().min(1).parse(p.roomId),
          typeof p.beforeSeq === 'number' ? p.beforeSeq : undefined,
          typeof p.limit === 'number' ? p.limit : 80
        )
      case 'rooms.sendMessage': {
        const parsed = z.object({
          roomId: z.string().min(1),
          content: z.string().min(1),
          replyToMsgId: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }).parse(p)
        const message = await this.deps.collab.sendMessage(parsed.roomId, {
          content: parsed.content,
          authorName: actorUsername,
          replyToMsgId: parsed.replyToMsgId,
          idempotencyKey: parsed.idempotencyKey
        })
        return { message }
      }
      case 'workNodes.list':
        return this.deps.collab.listWorkNodes(z.string().min(1).parse(p.roomId))
      case 'workNodes.events':
        return this.deps.collab.listNodeEvents(
          z.string().min(1).parse(p.nodeId),
          typeof p.attempt === 'number' ? p.attempt : undefined
        )
      case 'workNodes.control': {
        const parsed = z.object({
          nodeId: z.string().min(1),
          action: WorkNodeControlAction,
          targetMemberId: z.string().optional(),
          note: z.string().optional()
        }).parse(p)
        return await this.deps.collab.controlWorkNode(parsed.nodeId, parsed.action, parsed.note, parsed.targetMemberId)
      }

      // Unified Inbox, Webhooks, Routing Rules & Plugins (v0.1c)
      case 'webhooks.list': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return this.deps.inbox.listWebhooks()
      }
      case 'webhooks.create': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return this.deps.inbox.createWebhook(z.string().trim().min(1).parse(p.name))
      }
      case 'webhooks.delete': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        this.deps.inbox.deleteWebhook(z.string().min(1).parse(p.id))
        return { ok: true }
      }
      case 'routingRules.list': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return this.deps.inbox.listRules()
      }
      case 'routingRules.save': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return this.deps.inbox.saveRule(RoutingRuleSaveInput.parse(p))
      }
      case 'routingRules.delete': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        this.deps.inbox.deleteRule(z.string().min(1).parse(p.id))
        return { ok: true }
      }
      case 'inbox.list': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        const status = p.status ? InboxStatus.parse(p.status) : undefined
        return this.deps.inbox.listItems(status)
      }
      case 'inbox.get': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return this.deps.inbox.getItem(z.string().min(1).parse(p.id))
      }
      case 'inbox.createManual': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        const parsed = z.object({
          title: z.string().trim().min(1).max(300),
          content: z.string().trim().min(1),
          authorName: z.string().optional(),
          source: z.string().optional(),
          externalUrl: z.string().optional()
        }).parse(p)
        return await this.deps.inbox.createManual(parsed)
      }
      case 'inbox.assign': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        const parsed = z.object({
          itemId: z.string().min(1),
          mode: z.enum(['create_room', 'append_room']).default('create_room'),
          roomId: z.string().optional(),
          strategyId: z.string().optional(),
          agentIds: z.array(z.string()).optional(),
          workspaceId: z.string().optional(),
          allowWrite: z.boolean().optional()
        }).parse(p)
        return await this.deps.inbox.assignItem(parsed)
      }
      case 'inbox.setStatus': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        const parsed = z.object({
          itemId: z.string().min(1),
          status: InboxStatus
        }).parse(p)
        return this.deps.inbox.setStatus(parsed.itemId, parsed.status)
      }
      case 'plugins.list': {
        if (!this.deps.plugins) throw Errors.notFound('Plugin manager not configured')
        return {
          descriptors: this.deps.plugins.listDescriptors(),
          instances: this.deps.plugins.listInstances()
        }
      }
      case 'plugins.configure': {
        if (!this.deps.plugins) throw Errors.notFound('Plugin manager not configured')
        const parsed = z.object({
          id: z.string().optional(),
          pluginId: z.string().min(1),
          name: z.string().trim().min(1),
          config: z.record(z.unknown()).optional(),
          enabled: z.boolean().optional()
        }).parse(p)
        return this.deps.plugins.configureInstance(parsed)
      }
      case 'plugins.syncNow': {
        if (!this.deps.inbox) throw Errors.notFound('Inbox service not configured')
        return await this.deps.inbox.syncPluginInstance(z.string().min(1).parse(p.instanceId))
      }

      default:
        throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', `Unknown method: ${method}`)
    }
  }
}
