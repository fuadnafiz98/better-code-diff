const DIFF_HEADER_PREFIX = 'diff --git '
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

const C_ESCAPE_BYTES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d
}

function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = []
  let plainStart = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') continue
    bytes.push(...TEXT_ENCODER.encode(value.slice(plainStart, index)))
    const escaped = value[index + 1]
    if (escaped == null) {
      bytes.push(0x5c)
      plainStart = index + 1
      continue
    }
    if (/^[0-7]$/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /^[0-7]$/.test(value[index + octal.length + 1] ?? '')) {
        octal += value[index + octal.length + 1]
      }
      bytes.push(Number.parseInt(octal, 8))
      index += octal.length
      plainStart = index + 1
      continue
    }
    const controlByte = C_ESCAPE_BYTES[escaped]
    if (controlByte == null) bytes.push(...TEXT_ENCODER.encode(escaped))
    else bytes.push(controlByte)
    index += 1
    plainStart = index + 1
  }
  bytes.push(...TEXT_ENCODER.encode(value.slice(plainStart)))
  return TEXT_DECODER.decode(Uint8Array.from(bytes))
}

function readPathToken(value: string, start: number): { value: string; next: number } | null {
  if (value[start] !== '"') {
    const end = value.indexOf(' ', start)
    return end === -1
      ? { value: value.slice(start), next: value.length }
      : { value: value.slice(start, end), next: end }
  }

  let escaped = false
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"' && !escaped) {
      return { value: decodeGitQuotedPath(value.slice(start + 1, index)), next: index + 1 }
    }
    if (character === '\\' && !escaped) escaped = true
    else escaped = false
  }
  return null
}

export function parseDiffGitHeaderPaths(header: string): {
  previousPath: string
  path: string
} | null {
  if (!header.startsWith(DIFF_HEADER_PREFIX)) return null
  const value = header.slice(DIFF_HEADER_PREFIX.length)
  const previous = readPathToken(value, 0)
  if (previous == null || value[previous.next] !== ' ') return null
  const current = readPathToken(value, previous.next + 1)
  if (current == null || current.next !== value.length
    || !previous.value.startsWith('a/') || !current.value.startsWith('b/')) return null
  return { previousPath: previous.value.slice(2), path: current.value.slice(2) }
}
