export interface AgentAttachment {
  path: string
  startLine: number
  endLine: number
}

export function agentAttachmentId(attachment: AgentAttachment): string {
  return `${attachment.path}:${attachment.startLine}-${attachment.endLine}`
}

export function formatAgentAttachment(attachment: AgentAttachment): string {
  const name = attachment.path.split('/').at(-1) ?? attachment.path
  return attachment.startLine === attachment.endLine
    ? `${name}:${attachment.startLine}`
    : `${name}:${attachment.startLine}-${attachment.endLine}`
}

// Re-attaching the same region is a no-op, and attaching an overlapping region of
// the same file replaces it rather than stacking near-duplicates in the composer.
export function mergeAgentAttachments(
  current: readonly AgentAttachment[],
  next: AgentAttachment
): AgentAttachment[] {
  const merged: AgentAttachment[] = []
  let absorbed = next
  for (const attachment of current) {
    const overlaps = attachment.path === absorbed.path
      && attachment.startLine <= absorbed.endLine
      && absorbed.startLine <= attachment.endLine
    if (overlaps) {
      absorbed = {
        path: absorbed.path,
        startLine: Math.min(attachment.startLine, absorbed.startLine),
        endLine: Math.max(attachment.endLine, absorbed.endLine)
      }
      continue
    }
    merged.push(attachment)
  }
  merged.push(absorbed)
  return merged
}

// The agent can read the repository itself, so a reference is cheaper and more
// accurate than pasting the lines into the prompt.
export function describeAgentAttachments(
  attachments: readonly AgentAttachment[],
  prompt: string
): string {
  if (attachments.length === 0) return prompt
  const references = attachments
    .map((attachment) => attachment.startLine === attachment.endLine
      ? `${attachment.path} line ${attachment.startLine}`
      : `${attachment.path} lines ${attachment.startLine}-${attachment.endLine}`)
    .join('\n')
  return `Focus on this selection:\n${references}\n\n${prompt}`
}
