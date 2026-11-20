import type { CollabToolName, RoomDetail, RoomMember, RoomMessage, WorkNode } from '@myagents/protocol'

const MAX_CONTEXT_CHARS = 48_000

export interface BuiltTurnContext {
  systemContextPrompt?: string
  instructionPrompt: string
  contextHistoryMessages: RoomMessage[]
}

function getMemberDisplayLabel(
  member: RoomMember,
  anonymous: boolean,
  aliasById: Map<string, string>
): string {
  return anonymous ? (aliasById.get(member.id) ?? 'Member') : member.displayName
}

function formatMessageLine(
  msg: RoomMessage,
  labelById: Map<string, string>,
  anonymous: boolean,
  activeMembers: RoomMember[]
): string {
  let author =
    msg.authorKind === 'agent'
      ? (labelById.get(msg.authorId) ?? msg.authorName)
      : msg.authorName
  let content = msg.content
  if (anonymous) {
    if (msg.authorKind === 'agent' && labelById.has(msg.authorId)) {
      author = labelById.get(msg.authorId)!
    }
    for (const m of activeMembers) {
      const alias = labelById.get(m.id)
      if (!alias || !m.displayName) continue
      const escaped = m.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      content = content.replace(new RegExp(`@${escaped}`, 'gi'), `@${alias}`)
    }
  }
  const privTag = msg.visibilityScope === 'private' ? ' [PRIVATE]' : ''
  const replyTag = msg.replyToMsgId ? ' (replying)' : ''
  const attTag =
    msg.attachments && msg.attachments.length > 0
      ? ` [Attachments: ${msg.attachments.map((a) => `${a.filename} (${a.sizeBytes}B)`).join(', ')}]`
      : ''
  return `#m${msg.seq} [${author}${privTag}]${replyTag}: ${content}${attTag}`
}

export function buildTurnContext(opts: {
  room: RoomDetail
  member: RoomMember
  node: WorkNode
  visibleMessages: RoomMessage[]
  pendingDeliveryText?: string | null
  isIncremental: boolean
  lastDeliveredSeq: number
  allowedCollabTools: readonly CollabToolName[]
}): BuiltTurnContext {
  const { room, member, node, visibleMessages, pendingDeliveryText, isIncremental, lastDeliveredSeq, allowedCollabTools } = opts
  const isMultiAgent = room.strategyId !== 'single'

  // Single-agent rooms without deliveries keep lightweight clean prompts
  if (!isMultiAgent && !pendingDeliveryText && allowedCollabTools.length === 0) {
    return {
      instructionPrompt: node.instruction,
      contextHistoryMessages: visibleMessages
    }
  }

  const anonymous = room.strategyId === 'roundtable' && Boolean(room.strategyConfig?.anonymous)
  const activeMembers = [...room.members.filter((m) => m.removedAt === null)].sort((a, b) => a.position - b.position)
  const labelById = new Map<string, string>()
  activeMembers.forEach((m, idx) => {
    labelById.set(m.id, anonymous ? `Member ${String.fromCharCode(65 + (idx % 26))}${idx >= 26 ? idx - 25 : ''}` : m.displayName)
  })

  const selfLabel = getMemberDisplayLabel(member, anonymous, labelById)
  const roomHeading = anonymous ? 'Anonymous Roundtable' : `"${room.title}"`

  const sysLines: string[] = [
    `# Collaboration Room: ${roomHeading} (strategy: ${room.strategyId})`,
    `You are seated as **@${selfLabel}** (role: ${member.roleKind}, memberId: ${member.id}).`,
    member.rolePrompt?.trim() ? `Seat role instructions: ${member.rolePrompt.trim()}` : '',
    '',
    '## Fixed Room Roster (No Ad-Hoc Subagents Allowed)',
    ...activeMembers.map(
      (m) =>
        `- @${labelById.get(m.id) ?? m.displayName} (role=${m.roleKind}, driver=${m.driverKind ?? 'agent'}${anonymous ? '' : `, memberId=${m.id}`})${m.id === member.id ? ' <-- YOU' : ''}`
    ),
    '',
    'CRITICAL CONSTRAINT: This room has a FIXED roster. NEVER spawn ad-hoc subagents or invoke built-in Agent/Task tools. Always collaborate with the teammates listed above via collab_* tools.',
    allowedCollabTools.length > 0
      ? `Available collaboration tools: ${allowedCollabTools.join(', ')}. Use #m<seq> (e.g. #m12) when referencing messages in collab_reply.`
      : ''
  ].filter((l) => l !== '')

  if (room.sharedMemories.length > 0) {
    sysLines.push('', '## Room Shared Memories')
    for (const mem of room.sharedMemories) {
      sysLines.push(`- [${mem.id.slice(0, 8)}] ${mem.text}`)
    }
  }

  // Partition visible history within character budget (newest preserved)
  const linesToRender: string[] = []
  let charBudget = MAX_CONTEXT_CHARS
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const m = visibleMessages[i]!
    const formatted = formatMessageLine(m, labelById, anonymous, activeMembers)
    if (charBudget - formatted.length < 0 && linesToRender.length > 0) break
    linesToRender.unshift(formatted)
    charBudget -= formatted.length + 1
  }

  if (!isIncremental && linesToRender.length > 0) {
    sysLines.push('', '## Visible Room Transcript (recent)', ...linesToRender)
  }

  const instParts: string[] = []
  if (isIncremental) {
    const unread = visibleMessages.filter((m) =>
      m.visibilityScope === 'public'
        ? m.visibleSeq > lastDeliveredSeq
        : m.visibleTo.includes(member.id) && m.seq > lastDeliveredSeq
    )
    if (unread.length > 0) {
      instParts.push(
        '[New Visible Room Messages Since Your Last Turn]',
        ...unread.map((m) => formatMessageLine(m, labelById, anonymous, activeMembers)),
        ''
      )
    }
  }

  if (pendingDeliveryText?.trim()) {
    instParts.push('[Child Task Deliverables]', pendingDeliveryText.trim(), '')
  }

  if (node.kind === 'member_reply') {
    instParts.push(
      '[Reply Turn Constraint: You are responding to a direct teammate question. Answer clearly using your tools or collab_publish, and do NOT call collab_dispatch or collab_reply.]',
      ''
    )
  } else if (node.kind === 'round_post') {
    instParts.push(
      `[Roundtable Discussion (Superstep ${node.superstep ?? 1}): Present your independent analysis cleanly. Do NOT call collab_dispatch or collab_reply. Optionally call collab_publish with verdict ('hold' | 'changed' | 'approve' | 'revise').]`,
      ''
    )
  } else if (node.kind === 'summary') {
    instParts.push(
      '[Roundtable Chair Summary: Synthesize all visible discussion rounds, call out areas of consensus and disagreement, and output the recommended action plan. You may call collab_publish with verdict="done" or respond directly.]',
      ''
    )
  }

  instParts.push(`[Current Task (${node.kind}, workNodeId=${node.id})]\n${node.instruction}`)
  if (node.expectedResult?.trim()) {
    instParts.push(`Expected deliverable: ${node.expectedResult.trim()}`)
  }

  return {
    systemContextPrompt: sysLines.join('\n'),
    instructionPrompt: instParts.join('\n'),
    contextHistoryMessages: anonymous ? [] : visibleMessages
  }
}
