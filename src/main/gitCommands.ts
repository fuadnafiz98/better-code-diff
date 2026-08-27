import { execFile, spawn } from 'node:child_process'

export const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
export const COMMAND_ABORTED_MESSAGE = 'The command was cancelled before it finished.'

export interface CommandResult {
  stdout: Buffer
  stderr: Buffer
}

export function splitNullDelimited(buffer: Buffer): string[] {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export interface GitObjectRead {
  contents: Buffer | null
  oid: string
  type: string
  size: number
  missing: boolean
  oversized: boolean
}

const MAX_CAT_FILE_HEADER_BYTES = 4_096
const GIT_OBJECT_READER_IDLE_MS = 60_000
const GIT_OBJECT_READ_TIMEOUT_MS = 30_000
const MISSING_GIT_OBJECT: GitObjectRead = {
  contents: null,
  oid: '',
  type: 'missing',
  size: 0,
  missing: true,
  oversized: false
}

interface PendingGitObjectRead {
  object: string
  resolve(value: GitObjectRead): void
  reject(error: Error): void
}

/**
 * One long-lived `git cat-file --batch` per repository instead of one per blob.
 * Measured on this repository, 60 HEAD blobs cost 1113 ms through a spawn per
 * read and 39 ms through a single batch process — the fork/exec of git, not the
 * object lookup, was the whole cost.
 *
 * `--batch` answers `<oid> <type> <size>\n<contents>\n`, so the reader is a
 * strict FIFO: every request consumes exactly one record. A record is therefore
 * never abandoned part-read — an oversized blob is drained and discarded rather
 * than killing the child, because killing mid-record would hand the next
 * request the wrong file's bytes.
 */
export class GitObjectReader {
  #root: string
  #child: ReturnType<typeof spawn> | null = null
  #queue: PendingGitObjectRead[] = []
  #buffer: Buffer = Buffer.alloc(0)
  #pendingBody: { received: number; expected: number; chunks: Buffer[] | null; header: GitObjectRead } | null = null
  #stderr = ''
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #readTimer: ReturnType<typeof setTimeout> | null = null
  #spawns = 0

  constructor(root: string) {
    this.#root = root
  }

  get spawnCountForTests(): number {
    return this.#spawns
  }

  read(object: string): Promise<GitObjectRead> {
    if (object.includes('\n')) return Promise.reject(new Error('Git object names cannot contain newlines.'))
    return new Promise<GitObjectRead>((resolveRead, rejectRead) => {
      this.#queue.push({ object, resolve: resolveRead, reject: rejectRead })
      const child = this.#ensureChild()
      if (child == null) return
      this.#armTimers()
      child.stdin?.write(`${object}\n`)
    })
  }

  dispose(): void {
    this.#failAll(new Error('The repository was closed while reading a Git object.'))
    this.#clearTimers()
    const child = this.#child
    this.#child = null
    this.#buffer = Buffer.alloc(0)
    this.#pendingBody = null
    child?.kill()
  }

  #ensureChild(): ReturnType<typeof spawn> | null {
    if (this.#child != null) return this.#child
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['-C', this.#root, 'cat-file', '--batch'], { windowsHide: true })
    } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)))
      return null
    }
    this.#spawns += 1
    this.#child = child
    this.#stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
      this.#drain(child)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(-2_048)
    })
    child.stdin?.on('error', () => {})
    const abandon = (): void => {
      if (this.#child !== child) return
      this.#child = null
      this.#buffer = Buffer.alloc(0)
      this.#pendingBody = null
      this.#failAll(new Error(this.#stderr.trim() || 'git cat-file did not return the object.'))
      this.#clearTimers()
    }
    child.on('error', abandon)
    child.on('close', abandon)
    return child
  }

  // A stream that no longer lines up with the queue would answer the next
  // request with the previous file's bytes, so any parse anomaly restarts the
  // child rather than trying to resynchronise.
  #restart(child: ReturnType<typeof spawn>, error: Error): void {
    if (this.#child !== child) return
    this.#child = null
    this.#buffer = Buffer.alloc(0)
    this.#pendingBody = null
    child.kill()
    this.#failAll(error)
    this.#clearTimers()
  }

  #drain(child: ReturnType<typeof spawn>): void {
    for (;;) {
      const body = this.#pendingBody
      if (body != null) {
        const remaining = body.expected - body.received
        if (this.#buffer.length === 0) return
        const take = Math.min(remaining, this.#buffer.length)
        if (body.chunks != null) body.chunks.push(this.#buffer.subarray(0, take))
        body.received += take
        this.#buffer = this.#buffer.subarray(take)
        if (body.received < body.expected) return
        this.#pendingBody = null
        const contents = body.chunks == null
          ? null
          : Buffer.concat(body.chunks).subarray(0, body.header.size)
        this.#settle({ ...body.header, contents })
        continue
      }

      const newline = this.#buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.#buffer.length > MAX_CAT_FILE_HEADER_BYTES) {
          this.#restart(child, new Error('git cat-file returned no header.'))
        }
        return
      }
      const fields = this.#buffer.subarray(0, newline).toString('utf8').split(' ')
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (fields[1] === 'missing' || fields.length < 3) {
        this.#settle(MISSING_GIT_OBJECT)
        continue
      }
      const size = Number(fields[2])
      if (!Number.isFinite(size) || size < 0) {
        this.#restart(child, new Error('git cat-file returned an unreadable size.'))
        return
      }
      const oversized = size > MAX_DIFF_FILE_BYTES
      this.#pendingBody = {
        received: 0,
        // The record is the contents plus the newline git appends after them.
        expected: size + 1,
        chunks: oversized ? null : [],
        header: {
          contents: null,
          oid: fields[0] ?? '',
          type: fields[1] ?? '',
          size,
          missing: false,
          oversized
        }
      }
    }
  }

  #settle(value: GitObjectRead): void {
    const pending = this.#queue.shift()
    pending?.resolve(value)
    this.#armTimers()
  }

  #failAll(error: Error): void {
    const queue = this.#queue
    this.#queue = []
    for (const pending of queue) pending.reject(error)
  }

  #armTimers(): void {
    if (this.#idleTimer != null) clearTimeout(this.#idleTimer)
    if (this.#readTimer != null) clearTimeout(this.#readTimer)
    this.#idleTimer = null
    this.#readTimer = null
    if (this.#queue.length > 0) {
      this.#readTimer = setTimeout(() => {
        const child = this.#child
        if (child != null) this.#restart(child, new Error('git cat-file stopped responding.'))
      }, GIT_OBJECT_READ_TIMEOUT_MS)
      this.#readTimer.unref?.()
      return
    }
    this.#idleTimer = setTimeout(() => {
      const child = this.#child
      this.#child = null
      this.#buffer = Buffer.alloc(0)
      this.#pendingBody = null
      child?.kill()
    }, GIT_OBJECT_READER_IDLE_MS)
    this.#idleTimer.unref?.()
  }

  #clearTimers(): void {
    if (this.#idleTimer != null) clearTimeout(this.#idleTimer)
    if (this.#readTimer != null) clearTimeout(this.#readTimer)
    this.#idleTimer = null
    this.#readTimer = null
  }
}

export async function readGitObject(root: string, object: string): Promise<GitObjectRead> {
  const reader = new GitObjectReader(root)
  try {
    return await reader.read(object)
  } finally {
    reader.dispose()
  }
}

export function runCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
  allowedExitCodes: readonly number[] = [],
  input?: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    if (signal?.aborted === true) {
      rejectCommand(new Error(COMMAND_ABORTED_MESSAGE))
      return
    }
    const child = execFile(
      executable,
      [...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        signal
      },
      (error, stdout, stderr) => {
        const result = { stdout, stderr }
        if (signal?.aborted === true) {
          rejectCommand(new Error(COMMAND_ABORTED_MESSAGE))
          return
        }

        const exitCode = error == null ? 0 : Number(error.code)
        if (error && !allowedExitCodes.includes(exitCode)) {
          const message = result.stderr.toString('utf8').trim() || error.message
          rejectCommand(new Error(message))
          return
        }

        resolveCommand(result)
      }
    )
    if (input != null) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

export async function mapWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  transform: (value: Value) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = []
  results.length = values.length
  let nextIndex = 0
  const runNext = async (): Promise<void> => {
    const index = nextIndex
    nextIndex += 1
    if (index >= values.length) return
    const value = values[index]!
    results[index] = await transform(value)
    return runNext()
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runNext())
  )
  return results
}
