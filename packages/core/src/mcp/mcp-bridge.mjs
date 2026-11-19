#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    home: { type: 'string' },
    room: { type: 'string' },
    member: { type: 'string' },
    tools: { type: 'string' }
  },
  strict: false
})

const homeDir = typeof values.home === 'string' && values.home.trim() ? values.home.trim() : process.env.MYAGENTS_HOME || ''
const roomId = typeof values.room === 'string' ? values.room.trim() : ''
const memberId = typeof values.member === 'string' ? values.member.trim() : ''
const allowedSet =
  typeof values.tools === 'string' && values.tools.trim()
    ? new Set(values.tools.split(',').map((s) => s.trim()).filter(Boolean))
    : null

const toolsPath = fileURLToPath(new URL('./collab-tools.json', import.meta.url))
const allTools = JSON.parse(readFileSync(toolsPath, 'utf8'))
const activeTools = allowedSet ? allTools.filter((t) => allowedSet.has(t.name)) : allTools

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function readCoreEndpoint() {
  if (!homeDir) throw new Error('Missing --home directory for core endpoint resolution')
  const file = path.join(homeDir, 'run', 'core.json')
  const raw = readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed.port !== 'number' || typeof parsed.internalToken !== 'string') {
    throw new Error('Invalid core.json endpoint metadata')
  }
  const connectHost = !parsed.host || parsed.host === '0.0.0.0' || parsed.host === '::' ? '127.0.0.1' : parsed.host
  return {
    baseUrl: `http://${connectHost}:${parsed.port}`,
    internalToken: parsed.internalToken
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function callCoreMcp(toolName, args, toolCallId) {
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ep = readCoreEndpoint()
      const res = await fetch(`${ep.baseUrl}/api/internal/mcp/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ep.internalToken}`
        },
        body: JSON.stringify({
          roomId,
          memberId,
          toolName,
          args: args ?? {},
          toolCallId: String(toolCallId ?? `mcp-${Date.now()}`)
        })
      })
      const data = await res.json().catch(() => ({}))
      if (res.status >= 500 && attempt < 3) {
        lastErr = new Error(data?.message || `HTTP ${res.status}`)
        await sleep(300)
        continue
      }
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: data?.message || `Error HTTP ${res.status}` }],
          isError: true
        }
      }
      return {
        content: [{ type: 'text', text: String(data?.output ?? '') }],
        isError: Boolean(data?.isError || !data?.ok)
      }
    } catch (err) {
      lastErr = err
      if (attempt < 3) {
        await sleep(300)
      }
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `Failed reaching MyAgents Core MCP endpoint: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
      }
    ],
    isError: true
  }
}

async function handleLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } })
    return
  }

  // Notifications carry no id and expect no reply
  if (msg.id === undefined) {
    return
  }

  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })

  switch (msg.method) {
    case 'initialize': {
      const requestedVersion =
        msg.params && typeof msg.params.protocolVersion === 'string' && msg.params.protocolVersion
          ? msg.params.protocolVersion
          : '2024-11-05'
      reply({
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'myagents-collab', version: '0.1.0' }
      })
      return
    }
    case 'ping':
      reply({})
      return
    case 'tools/list':
      reply({
        tools: activeTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      })
      return
    case 'tools/call': {
      const p = msg.params && typeof msg.params === 'object' ? msg.params : {}
      const name = typeof p.name === 'string' ? p.name : ''
      const toolDef = activeTools.find((t) => t.name === name)
      if (!toolDef) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown or disallowed tool: ${name}` } })
        return
      }
      const result = await callCoreMcp(name, p.arguments ?? {}, msg.id)
      reply(result)
      return
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  void handleLine(line).catch((err) => {
    console.error(`[myagents-mcp-bridge] fatal line error: ${err instanceof Error ? err.message : String(err)}`)
  })
})
