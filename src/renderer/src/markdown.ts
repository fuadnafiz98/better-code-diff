export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'emphasis'; text: string }

export type MarkdownBlock =
  | { kind: 'paragraph'; content: MarkdownInline[] }
  | { kind: 'heading'; level: number; content: MarkdownInline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { kind: 'quote'; content: MarkdownInline[] }

const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/
// Shared with the incremental scanner below so the two can never disagree about
// where a fenced block starts and ends.
const FENCE_OPEN = /^```(\w*)\s*$/
const FENCE_CLOSE = /^```\s*$/

export function parseInline(text: string): MarkdownInline[] {
  if (text === '') return []
  const parts = text.split(INLINE_PATTERN).filter((part) => part !== '')
  const inlines: MarkdownInline[] = []
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      inlines.push({ kind: 'code', text: part.slice(1, -1) })
    } else if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      inlines.push({ kind: 'strong', text: part.slice(2, -2) })
    } else if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      inlines.push({ kind: 'emphasis', text: part.slice(1, -1) })
    } else {
      inlines.push({ kind: 'text', text: part })
    }
  }
  return inlines
}

// Streaming answers arrive mid-token, so an unterminated fence still has to render
// as a code block rather than swallowing the rest of the answer.
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.split('\n')
  let paragraph: string[] = []
  let listItems: string[] = []
  let listOrdered = false

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = (): void => {
    if (listItems.length === 0) return
    blocks.push({ kind: 'list', ordered: listOrdered, items: listItems.map(parseInline) })
    listItems = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = FENCE_OPEN.exec(line)
    if (fence != null) {
      flushParagraph()
      flushList()
      const language = fence[1] === '' ? null : fence[1] ?? null
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      blocks.push({ kind: 'code', language, text: codeLines.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading != null) {
      flushParagraph()
      flushList()
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        content: parseInline(heading[2] ?? '')
      })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote != null) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'quote', content: parseInline(quote[1] ?? '') })
      continue
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (unordered != null || ordered != null) {
      flushParagraph()
      const itemText = (unordered?.[1] ?? ordered?.[1] ?? '')
      const nextOrdered = ordered != null
      if (listItems.length > 0 && nextOrdered !== listOrdered) flushList()
      listOrdered = nextOrdered
      listItems.push(itemText)
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }

  flushParagraph()
  flushList()
  return blocks
}

export interface StreamingMarkdown {
  /** The source these blocks describe, so the next chunk can prove it is an append. */
  source: string
  /** How much of `source` is already converted into `settled`. */
  settledLength: number
  settled: MarkdownBlock[]
  /** What the UI renders: everything settled, plus the still-growing tail. */
  blocks: MarkdownBlock[]
}

export const EMPTY_STREAMING_MARKDOWN: StreamingMarkdown = {
  source: '',
  settledLength: 0,
  settled: [],
  blocks: []
}

// A blank line outside a fence is where parseMarkdown flushes, so everything
// before the last one can never change as more text arrives. Returns the offset
// that prefix ends at.
function settledBoundary(source: string, from: number): number {
  let boundary = from
  let inFence = false
  let lineStart = from
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart)
    // A line with no terminator is still arriving, so it cannot settle anything.
    if (lineEnd === -1) break
    const line = source.slice(lineStart, lineEnd)
    if (!inFence && FENCE_OPEN.test(line)) inFence = true
    else if (inFence && FENCE_CLOSE.test(line)) inFence = false
    else if (!inFence && line.trim() === '') boundary = lineEnd + 1
    lineStart = lineEnd + 1
  }
  return boundary
}

// Re-parsing the whole answer on every streamed chunk is quadratic: a 20 KB
// answer arriving in 600 chunks parses ~6.1M characters. Only the unsettled tail
// has to be re-parsed, which makes the total linear in the answer length.
export function advanceStreamingMarkdown(previous: StreamingMarkdown, source: string): StreamingMarkdown {
  // Truncating a very long answer from the front breaks the append invariant, so
  // that case starts over rather than reusing a prefix that no longer exists.
  const appended = source.startsWith(previous.source)
  const settled = appended ? previous.settled : []
  const settledLength = appended ? previous.settledLength : 0

  const boundary = settledBoundary(source, settledLength)
  const nextSettled = boundary > settledLength
    ? [...settled, ...parseMarkdown(source.slice(settledLength, boundary))]
    : settled
  const tail = source.slice(boundary)

  return {
    source,
    settledLength: boundary,
    settled: nextSettled,
    blocks: tail === '' ? nextSettled : [...nextSettled, ...parseMarkdown(tail)]
  }
}

// Streaming re-parses the whole answer on every chunk, so blocks and inline runs
// need identities derived from their content instead of their position.
export function keyForInline(inline: MarkdownInline, seen: Map<string, number>): string {
  const base = `${inline.kind}:${inline.text.slice(0, 24)}`
  const count = (seen.get(base) ?? 0) + 1
  seen.set(base, count)
  return `${base}#${count}`
}

export function keyForBlock(block: MarkdownBlock, seen: Map<string, number>): string {
  const sample = block.kind === 'code'
    ? block.text.slice(0, 24)
    : block.kind === 'list'
      // Deliberately excludes items.length: a list streams in item by item, so a
      // length in the key would change on every chunk and remount the whole list.
      ? `${block.ordered ? 'ol' : 'ul'}:${block.items[0]?.[0]?.text.slice(0, 24) ?? ''}`
      : block.content[0]?.text.slice(0, 24) ?? ''
  const base = `${block.kind}:${sample}`
  const count = (seen.get(base) ?? 0) + 1
  seen.set(base, count)
  return `${base}#${count}`
}
