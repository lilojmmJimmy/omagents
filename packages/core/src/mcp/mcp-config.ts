import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollabToolName } from '@myagents/protocol'
import { myagentsHome, myagentsMcpConfigPath, writePrivateFileSync } from '@myagents/protocol/node'

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
  homeDir?: string
}): { configPath: string; configHash: string } {
  const homeDir = opts.homeDir ?? myagentsHome()
  const bridgePath = resolveMcpBridgePath()
  const configPath = myagentsMcpConfigPath(opts.memberId)

  const payload = {
    mcpServers: {
      myagents: {
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
  }

  const serialized = JSON.stringify(payload, null, 2)
  writePrivateFileSync(configPath, serialized)
  const configHash = createHash('sha256').update(serialized).digest('hex').slice(0, 12)
  return { configPath, configHash }
}
