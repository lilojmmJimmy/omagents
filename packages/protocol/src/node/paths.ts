import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function myagentsHome(): string {
  return path.resolve(process.env.MYAGENTS_HOME || path.join(os.homedir(), '.myagents'))
}

export function myagentsDataDir(): string {
  return path.join(myagentsHome(), 'data')
}

export function myagentsDbPath(): string {
  return path.join(myagentsDataDir(), 'myagents.db')
}

export function myagentsBlobsDir(): string {
  return path.join(myagentsHome(), 'blobs')
}

export function myagentsWorkspacesDir(): string {
  return path.join(myagentsHome(), 'workspaces')
}

export function myagentsAgentWorkspacePath(agentId: string): string {
  return path.join(myagentsWorkspacesDir(), 'agents', agentId)
}

export function myagentsRoomWorkspacePath(roomId: string): string {
  return path.join(myagentsWorkspacesDir(), 'rooms', roomId)
}

export function myagentsWorktreesDir(): string {
  return path.join(myagentsHome(), 'worktrees')
}

export function myagentsAgentHomesDir(): string {
  return path.join(myagentsHome(), 'agent-homes')
}

export function myagentsAgentHomePath(profileKey: string): string {
  return path.join(myagentsAgentHomesDir(), profileKey)
}

export function myagentsRunDir(): string {
  return path.join(myagentsHome(), 'run')
}

export function myagentsMcpConfigPath(memberId: string): string {
  return path.join(myagentsRunDir(), `mcp-${memberId}.json`)
}

export function coreEndpointPath(): string {
  return path.join(myagentsRunDir(), 'core.json')
}

export function daemonEndpointPath(): string {
  if (process.platform === 'win32') {
    // Key pipe name by home directory hash so multiple instances (dev/test/prod) never collide.
    const tag = createHash('sha256').update(myagentsHome().toLowerCase()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\myagents-daemon-${tag}`
  }
  return path.join(myagentsRunDir(), 'daemon.sock')
}
