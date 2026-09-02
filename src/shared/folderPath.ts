export function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash < 0 ? trimmed : trimmed.slice(slash + 1)
}

export function displayUserPath(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

export function highlightPathMatches(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  if (query === '') return [{ text, match: false }]

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const substringIndex = lowerText.indexOf(lowerQuery)
  if (substringIndex >= 0) {
    const parts: Array<{ text: string; match: boolean }> = []
    if (substringIndex > 0) parts.push({ text: text.slice(0, substringIndex), match: false })
    parts.push({ text: text.slice(substringIndex, substringIndex + query.length), match: true })
    if (substringIndex + query.length < text.length) {
      parts.push({ text: text.slice(substringIndex + query.length), match: false })
    }
    return parts
  }

  const parts: Array<{ text: string; match: boolean }> = []
  let cursor = 0
  let queryIndex = 0
  while (cursor < text.length && queryIndex < lowerQuery.length) {
    if (lowerText[cursor] === lowerQuery[queryIndex]) {
      const start = cursor
      while (
        cursor < text.length
        && queryIndex < lowerQuery.length
        && lowerText[cursor] === lowerQuery[queryIndex]
      ) {
        cursor += 1
        queryIndex += 1
      }
      parts.push({ text: text.slice(start, cursor), match: true })
      continue
    }
    const start = cursor
    cursor += 1
    while (cursor < text.length && lowerText[cursor] !== lowerQuery[queryIndex]) cursor += 1
    parts.push({ text: text.slice(start, cursor), match: false })
  }
  if (queryIndex < lowerQuery.length) return [{ text, match: false }]
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return mergeHighlightParts(parts)
}

function mergeHighlightParts(
  parts: Array<{ text: string; match: boolean }>
): Array<{ text: string; match: boolean }> {
  const merged: Array<{ text: string; match: boolean }> = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (last != null && last.match === part.match) last.text += part.text
    else merged.push({ ...part })
  }
  return merged
}
