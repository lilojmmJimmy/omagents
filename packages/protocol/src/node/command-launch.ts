// Adapted from Antumi (Apache License 2.0) and Orca windows-cmd-shim-resolution (MIT).
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type LaunchHost = {
  platform: NodeJS.Platform
  isFile(file: string): boolean
  isExecutable(file: string): boolean
  read(file: string): string | null
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export const nodeLaunchHost: LaunchHost = {
  platform: process.platform,
  isFile,
  isExecutable(file) {
    if (!isFile(file)) return false
    if (process.platform === 'win32') return true
    try {
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  read(file) {
    try {
      return statSync(file).size > 64 * 1024 ? null : readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
}

export type Launch = { file: string; args: string[]; env: NodeJS.ProcessEnv }

const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)

export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') return env[name]
  const lower = name.toLowerCase()
  const key = Object.keys(env).find((each) => each.toLowerCase() === lower && env[each] !== undefined)
  return key === undefined ? undefined : env[key]
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT)
    .split(';')
    .map((each) => each.trim().toLowerCase())
    .filter((each) => each.startsWith('.'))
}

export function resolveCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  host: LaunchHost = nodeLaunchHost
): string | null {
  const windows = host.platform === 'win32'
  const paths = pathOf(host.platform)
  const extensions = windows ? pathExtensions(env) : []
  const spellings =
    windows && !extensions.includes(paths.extname(command).toLowerCase())
      ? extensions.map((extension) => command + extension)
      : [command]
  if (command.includes('/') || (windows && command.includes('\\'))) {
    return spellings.map((each) => paths.resolve(cwd, each)).find((file) => host.isExecutable(file)) ?? null
  }
  const dirs = (envValue(env, 'PATH', host.platform) ?? '').split(windows ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    for (const spelling of spellings) {
      const file = paths.join(dir, spelling)
      if (host.isExecutable(file)) return file
    }
  }
  return null
}

export function commandExists(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  host: LaunchHost = nodeLaunchHost
): boolean {
  return resolveCommand(command, cwd, env, host) !== null
}

export function planLaunch(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  host: LaunchHost = nodeLaunchHost
): Launch {
  const file = resolveCommand(command, cwd, env, host)
  if (!file) throw new Error(`command-not-found: ${command}`)
  return launchFile(file, args, env, host)
}

export function launchFile(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  host: LaunchHost = nodeLaunchHost
): Launch {
  if (host.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], env }
  const launch = resolveWindowsShim(file, args, env, host)
  if (!launch) throw new Error(`command-needs-shell: ${file}`)
  return launch
}

const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`
const DP0_NODE_EXE = `"${DP0}node\\.exe"`
const dp0Path = (group: string): string => `"${DP0}(?<${group}>[^"\\r\\n]+)"`
const ECHO_OFF = String.raw`@echo off\n`
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`

const NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path('script')} +%\*$`,
  'i'
)
const BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path('script')} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path('scriptElse')} +%\*\n\)$`,
  'i'
)
const NPM_DIRECT_SHIM = new RegExp(String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path('target')} +%\*$`, 'i')
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path('target')} +%\*$`, 'i')
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/

export type WindowsShim = { kind: 'node'; script: string; nodePath?: string } | { kind: 'direct'; target: string }

const plainRelative = (spelled: string) => !UNSAFE_SHIM_PATH.test(spelled) && !path.win32.isAbsolute(spelled)

export function parseWindowsShim(contents: string): WindowsShim | null {
  const canonical = contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups
  if (prog?.script) return plainRelative(prog.script) ? { kind: 'node', script: prog.script } : null
  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !plainRelative(branched.script)) return null
    if (branched.nodePath === undefined) return { kind: 'node', script: branched.script }
    if (branched.nodePath.includes('%') || branched.nodePathElse !== `${branched.nodePath};%NODE_PATH%`) return null
    return { kind: 'node', script: branched.script, nodePath: branched.nodePath }
  }
  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target
    if (target) return plainRelative(target) ? { kind: 'direct', target } : null
  }
  return null
}

function shimNode(dir: string, env: NodeJS.ProcessEnv, host: LaunchHost): string | null {
  const sibling = path.win32.join(dir, 'node.exe')
  if (host.isFile(sibling)) return sibling
  const extensions = pathExtensions(env)
  for (const entry of (envValue(env, 'PATH', 'win32') ?? '').split(';')) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!folder || !path.win32.isAbsolute(folder)) continue
    for (const extension of extensions) {
      const candidate = path.win32.join(folder, `node${extension}`)
      if (host.isFile(candidate)) return extension === '.exe' ? candidate : null
    }
  }
  return null
}

function powershell(env: NodeJS.ProcessEnv, host: LaunchHost): string | null {
  for (const name of ['pwsh', 'powershell']) {
    const found = resolveCommand(name, '.', { ...env, PATHEXT: '.EXE' }, host)
    if (found) return found
  }
  const root = envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
  const system = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return host.isFile(system) ? system : null
}

function resolveWindowsShim(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  host: LaunchHost
): Launch | null {
  const dir = path.win32.dirname(file)
  const contents = host.read(file)
  const shim = contents === null ? null : parseWindowsShim(contents)
  if (shim?.kind === 'direct') {
    const target = path.win32.resolve(dir, shim.target)
    return /\.(exe|com)$/i.test(target) && host.isFile(target) ? { file: target, args: [...args], env } : null
  }
  if (shim?.kind === 'node') {
    const script = path.win32.resolve(dir, shim.script)
    const node = host.isFile(script) ? shimNode(dir, env, host) : null
    if (!node) return null
    if (!shim.nodePath) return { file: node, args: [script, ...args], env }
    const key = Object.keys(env).find((each) => each.toLowerCase() === 'node_path') ?? 'NODE_PATH'
    const existing = env[key]
    return {
      file: node,
      args: [script, ...args],
      env: { ...env, [key]: existing ? `${shim.nodePath};${existing}` : shim.nodePath }
    }
  }
  const siblingPs1 = file.replace(/\.(cmd|bat)$/i, '.ps1')
  if (host.isFile(siblingPs1)) {
    const ps = powershell(env, host)
    if (ps) return { file: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', siblingPs1, ...args], env }
  }
  return null
}
