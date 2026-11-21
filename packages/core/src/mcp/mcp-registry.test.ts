import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { McpServerSaveInput, type Workspace } from '@myagents/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DaemonClient } from '../daemon-client'
import { AgentService } from '../runtime/agent-service'
import { BuiltinDriver } from '../runtime/builtin-driver'
import type { TurnInput } from '../runtime/driver'
import { ProviderService } from '../runtime/provider-service'
import { BasicRedactor, DefaultSecretProvider, NoopApprovalGate } from '../security/hooks'
import { CoreDatabase } from '../storage/database'
import { GitService } from '../workspace/git-service'
import { WorkspaceService } from '../workspace/workspace-service'
import { writeRoomMemberMcpConfig } from './mcp-config'
import { McpRegistryService } from './mcp-registry'

let tmpDir: string
let echoServerScript: string
let httpMcpServer: http.Server
let httpMcpPort: number
let mockOpenAiServer: http.Server
let mockOpenAiPort: number
let seenHttpAuthHeader: string | undefined
const prevHome = process.env.MYAGENTS_HOME

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-mcp-reg-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })

  echoServerScript = path.join(tmpDir, 'echo-mcp.mjs')
  writeFileSync(
    echoServerScript,
    `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const msg = JSON.parse(trimmed)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'echo_ping',
          description: 'Echoes text back',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        }]
      }
    })
  } else if (msg.method === 'tools/call') {
    const text = String(msg.params?.arguments?.text ?? '')
    const token = process.env.TEST_SECRET_ENV || ''
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'ECHO:' + text + (token ? ':' + token : '') }], isError: false }
    })
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
})
`,
    'utf8'
  )

  await new Promise<void>((resolve) => {
    httpMcpServer = http.createServer((req, res) => {
      seenHttpAuthHeader = req.headers.authorization
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const msg = JSON.parse(body || '{}') as { id?: unknown; method?: string }
        if (msg.id === undefined) {
          res.writeHead(202, { 'Mcp-Session-Id': 'sess-http-1' })
          res.end()
          return
        }
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-http-1' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'http-mcp', version: '1.0.0' }
              }
            })
          )
          return
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'http_status', description: 'Returns HTTP MCP status' }] }
            })
          )
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
    httpMcpServer.listen(0, '127.0.0.1', () => {
      httpMcpPort = (httpMcpServer.address() as { port: number }).port
      resolve()
    })
  })

  await new Promise<void>((resolve) => {
    mockOpenAiServer = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const body = JSON.parse(raw) as {
            tools?: Array<{ function: { name: string } }>
            messages: Array<{ role: string; content: string | null }>
          }
          const toolNames = (body.tools ?? []).map((t) => t.function.name)
          const toolMsg = body.messages.find((m) => m.role === 'tool')
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          if (!toolMsg && toolNames.includes('mcp__echo__echo_ping')) {
            res.write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_ext_1',
                          type: 'function',
                          function: {
                            name: 'mcp__echo__echo_ping',
                            arguments: JSON.stringify({ text: 'hello' })
                          }
                        }
                      ]
                    }
                  }
                ]
              })}\n\n`
            )
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          const finalMsg = toolMsg ? `TOOL_RESULT=${toolMsg.content}` : `TOOLS=${toolNames.join(',')}`
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: finalMsg } }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    mockOpenAiServer.listen(0, '127.0.0.1', () => {
      mockOpenAiPort = (mockOpenAiServer.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(() => {
  httpMcpServer?.close()
  mockOpenAiServer?.close()
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('McpRegistryService & External MCP Integration', () => {
  it('supports CRUD, rejects reserved name, masks secret refs, and cleans up agent references on delete', () => {
    const db = new CoreDatabase(':memory:')
    const workspaces = new WorkspaceService(db)
    const agents = new AgentService(db, workspaces)
    const providers = new ProviderService(db, new DefaultSecretProvider())
    const registry = new McpRegistryService(db, new DefaultSecretProvider())

    expect(() => McpServerSaveInput.parse({ name: 'myagents', transport: 'stdio', command: 'node' })).toThrow(
      /reserved/
    )

    const provider = providers.save({
      name: 'mock-p',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockOpenAiPort}/v1`,
      defaultModel: 'mock-1',
      models: ['mock-1']
    })

    const saved = registry.save(
      McpServerSaveInput.parse({
        name: 'echo',
        transport: 'stdio',
        command: process.execPath,
        args: [echoServerScript],
        envRefs: { API_TOKEN: 'super-secret-value-12345' }
      })
    )

    expect(saved.envKeys).toEqual(['API_TOKEN'])
    expect(JSON.stringify(saved)).not.toContain('super-secret-value-12345')

    // Updating without envRefs preserves existing secret references
    const updated = registry.save(
      McpServerSaveInput.parse({
        id: saved.id,
        name: 'echo',
        transport: 'stdio',
        command: process.execPath,
        args: [echoServerScript],
        enabled: true
      })
    )
    expect(updated.envKeys).toEqual(['API_TOKEN'])

    const agent = agents.create({
      name: 'McpAgent',
      bio: '',
      systemPrompt: '',
      driverKind: 'builtin',
      providerId: provider.id,
      driverConfig: {},
      permissionMode: 'read-only',
      isolationMode: 'standard',
      skillIds: [],
      mcpServerIds: [saved.id]
    })
    expect(agents.get(agent.id).mcpServerIds).toEqual([saved.id])

    registry.delete(saved.id)
    expect(registry.list()).toEqual([])
    expect(agents.get(agent.id).mcpServerIds).toEqual([])
    db.close()
  })

  it('probes stdio and http MCP servers and merges room MCP config cleanly', async () => {
    const db = new CoreDatabase(':memory:')
    const registry = new McpRegistryService(db, new DefaultSecretProvider())

    const stdioServer = registry.save(
      McpServerSaveInput.parse({
        name: 'echo_stdio',
        transport: 'stdio',
        command: process.execPath,
        args: [echoServerScript]
      })
    )
    const stdioProbe = await registry.probe(stdioServer.id)
    expect(stdioProbe.ok).toBe(true)
    expect(stdioProbe.tools.map((t) => t.name)).toEqual(['echo_ping'])

    const httpServer = registry.save(
      McpServerSaveInput.parse({
        name: 'http_probe',
        transport: 'http',
        url: `http://127.0.0.1:${httpMcpPort}/mcp`,
        headerRefs: { Authorization: 'Bearer token-xyz' }
      })
    )
    const httpProbe = await registry.probe(httpServer.id)
    expect(httpProbe.ok).toBe(true)
    expect(httpProbe.tools.map((t) => t.name)).toEqual(['http_status'])
    expect(seenHttpAuthHeader).toBe('Bearer token-xyz')

    const resolved = await registry.resolveForAgent([stdioServer.id, httpServer.id])
    const merged = writeRoomMemberMcpConfig({
      roomId: 'r-merge',
      memberId: 'm-merge',
      allowedTools: ['collab_history'],
      externalServers: resolved,
      homeDir: process.env.MYAGENTS_HOME
    })
    const parsedMerged = JSON.parse(readFileSync(merged.configPath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(parsedMerged.mcpServers)).toEqual(['myagents', 'echo_stdio', 'http_probe'])
    expect(parsedMerged.mcpServers.http_probe?.type).toBe('http')

    const extOnly = writeRoomMemberMcpConfig({
      roomId: 'r-single',
      memberId: 'm-single',
      allowedTools: [],
      externalServers: resolved,
      homeDir: process.env.MYAGENTS_HOME
    })
    const parsedExtOnly = JSON.parse(readFileSync(extOnly.configPath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(parsedExtOnly.mcpServers)).toEqual(['echo_stdio', 'http_probe'])
    db.close()
  })

  it('BuiltinDriver invokes external stdio MCP tools, scrubs secrets, and blocks external MCP in lockdown', async () => {
    const db = new CoreDatabase(':memory:')
    const secrets = new DefaultSecretProvider()
    const redactor = new BasicRedactor()
    const registry = new McpRegistryService(db, secrets, redactor)
    const workspaces = new WorkspaceService(db)
    const providers = new ProviderService(db, secrets)
    const agents = new AgentService(db, workspaces)

    const provider = providers.save({
      name: 'mock-openai',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockOpenAiPort}/v1`,
      defaultModel: 'mock-1',
      models: ['mock-1']
    })

    const echo = registry.save(
      McpServerSaveInput.parse({
        name: 'echo',
        transport: 'stdio',
        command: process.execPath,
        args: [echoServerScript],
        envRefs: { TEST_SECRET_ENV: 'SECRET_XYZ_999' }
      })
    )

    const agent = agents.create({
      name: 'BuiltinMcpWorker',
      bio: '',
      systemPrompt: '',
      driverKind: 'builtin',
      providerId: provider.id,
      driverConfig: {},
      permissionMode: 'read-only',
      isolationMode: 'standard',
      skillIds: [],
      mcpServerIds: [echo.id]
    })
    const ws: Workspace = workspaces.get(agent.defaultWorkspaceId)
    const externalMcpServers = await registry.resolveForAgent(agent.mcpServerIds)
    const driver = new BuiltinDriver(
      providers,
      workspaces,
      new GitService(),
      {} as DaemonClient,
      new NoopApprovalGate(),
      redactor
    )

    const baseInput: TurnInput = {
      session: {
        id: 's-1',
        roomId: 'r-1',
        roomMemberId: 'm-1',
        agentId: agent.id,
        driverKind: 'builtin',
        daemonSessionId: null,
        nativeSessionId: null,
        configHash: null,
        lastDeliveredSeq: 0,
        lastConsumedOffset: 0
      },
      agent,
      roomId: 'r-1',
      workNodeId: 'wn-1',
      attempt: 1,
      workspace: ws,
      workspaceMode: 'read-only',
      isolation: {
        level: 'fenced-ro',
        cleanEnv: true,
        blockSubagents: true,
        writableDirs: [],
        readonlyDirs: [ws.rootPath],
        readableFiles: [],
        disallowedTools: [],
        allowedTools: []
      },
      configHash: 'cfg-1',
      instruction: 'Call echo_ping',
      externalMcpServers,
      historyMessages: [],
      abortSignal: new AbortController().signal,
      emit: () => {},
      onSessionUpdate: () => {}
    }

    const out = await driver.runTurn(baseInput)
    expect(out.finalText).toBe('TOOL_RESULT=ECHO:hello:•••')

    const lockdownOut = await driver.runTurn({
      ...baseInput,
      isolation: { ...baseInput.isolation, level: 'lockdown' }
    })
    expect(lockdownOut.finalText).toBe('TOOLS=')
    db.close()
  })
})
