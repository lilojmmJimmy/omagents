import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollabToolName } from '@myagents/protocol'
import { myagentsHome, myagentsMcpConfigPath, writePrivateFileSync } from '@myagents/protocol/node'
import type { ResolvedExternalMcpServer } from './mcp-client'

export function resolveMcpBridgePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const direct = path.join(here, 'mcp-bridge.mjs')
  if (existsSync(direct)) return direct
  // Fallback relative to core package root when bundled/tested
  return path.resolve(here, '../../src/mcp/mcp-bridge.mjs')
}

export function writeRoomMemberMcpConfig(opts: {
  roomId: string
  memberId: string
  allowedTools: readonly CollabToolName[]
  externalServers?: readonly ResolvedExternalMcpServer[]
  homeDir?: string
}): { configPath: string; configHash: string } {
  const homeDir = opts.homeDir ?? myagentsHome()
  const bridgePath = resolveMcpBridgePath()
  const configPath = myagentsMcpConfigPath(opts.memberId)

  const mcpServers: Record<string, Record<string, unknown>> = {}

  if (opts.allowedTools.length > 0) {
    mcpServers.myagents = {
      command: process.execPath,
      args: [
        bridgePath,
        '--home',
        homeDir,
        '--room',
        opts.roomId,
        '--member',
        opts.memberId,
        '--tools',
        opts.allowedTools.join(',')
      ]
    }
  }

  for (const ext of opts.externalServers ?? []) {
    if (!ext.name || ext.name.toLowerCase() === 'myagents') continue
    if (ext.transport === 'stdio' && ext.command) {
      mcpServers[ext.name] = {
        command: ext.command,
        args: ext.args ?? [],
        ...(ext.env && Object.keys(ext.env).length > 0 ? { env: ext.env } : {})
      }
    } else if (ext.transport === 'http' && ext.url) {
      mcpServers[ext.name] = {
        type: 'http',
        url: ext.url,
        ...(ext.headers && Object.keys(ext.headers).length > 0 ? { headers: ext.headers } : {})
      }
    }
  }

  const serialized = JSON.stringify({ mcpServers }, null, 2)
  writePrivateFileSync(configPath, serialized)
  const configHash = createHash('sha256').update(serialized).digest('hex').slice(0, 12)
  return { configPath, configHash }
}
