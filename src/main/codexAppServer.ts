import { spawn, type ChildProcess } from 'node:child_process'

import {
  CODEX_METHODS,
  interpretCodexNotification,
  readCodexRateLimit,
  type CodexRateLimit
} from './codexProtocol.js'
import type { AgentStreamChunk } from './agentRequest.js'

// `codex exec --json` never emits token deltas — an agent message arrives whole
// when the turn ends, which is why Codex looked broken and then slow. The
// app-server speaks JSON-RPC over stdio and pushes `item/agentMessage/delta`,
// so this is the only transport that can stream.
const CODEX_STARTUP_TIMEOUT_MS = 30_000
const CODEX_TURN_TIMEOUT_MS = 300_000

interface PendingRequest {
  resolve(result: Record<string, unknown>): void
  reject(error: Error): void
}

export interface CodexTurnHandlers {
  onChunk(chunk: AgentStreamChunk): void
  onRateLimit?(limit: CodexRateLimit): void
}

export class CodexAppServer {
  #child: ChildProcess | null = null
  #pending = new Map<number, PendingRequest>()
  #handlers: CodexTurnHandlers | null = null
  #nextId = 0
  #buffer = ''
  #cwd: string | null = null
  #threadId: string | null = null
  #currentTurnId: string | null = null
  // `turn/start` replies as soon as the turn is *created*, long before any text
  // arrives, so the turn is only finished when turn/completed or turn/failed lands.
  #turnCompletion: { resolve(): void; reject(error: Error): void } | null = null

  // The server loads the user's MCP servers on start, which takes seconds, so one
  // process is reused for every turn in the same working directory.
  async #ensureStarted(cwd: string, executable: string): Promise<void> {
    if (this.#child != null && this.#cwd === cwd && this.#child.exitCode == null) return
    this.#killChild()
    this.#cwd = cwd

    const child = spawn(executable, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#readStdout(chunk))
    child.stdin?.on('error', () => {})
    child.on('exit', () => {
      for (const request of this.#pending.values()) {
        request.reject(new Error('Codex stopped before answering.'))
      }
      this.#pending.clear()
      this.#finishTurn(new Error('Codex stopped before answering.'))
      this.#child = null
      this.#threadId = null
    })

    await this.#request(CODEX_METHODS.initialize, {
      clientInfo: { name: 'horus', title: 'Horus', version: '0.1.0' }
    }, CODEX_STARTUP_TIMEOUT_MS)
  }

  #readStdout(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      newline = this.#buffer.indexOf('\n')
      if (line.trim() === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    // Set HORUS_CODEX_DEBUG=1 to trace the JSON-RPC traffic; the
    // protocol is experimental and its method names have moved before.
    if (process.env.HORUS_CODEX_DEBUG === '1') {
      process.stderr.write(`codex ← ${JSON.stringify(message).slice(0, 300)}\n`)
    }
    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params }
      // Remember the live turn so Stop can interrupt precisely this one.
      if (message.method === 'turn/started') {
        const turn = (message.params as { turn?: { id?: unknown } } | undefined)?.turn
        if (typeof turn?.id === 'string') this.#currentTurnId = turn.id
      }
      if (message.method === 'turn/completed') this.#finishTurn(null)
      if (message.method === 'turn/failed') this.#finishTurn(null)
      const limit = readCodexRateLimit(notification)
      if (limit != null) this.#handlers?.onRateLimit?.(limit)
      const chunk = interpretCodexNotification(notification)
      if (chunk != null) this.#handlers?.onChunk(chunk)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.#pending.get(message.id)
    if (request == null) return
    this.#pending.delete(message.id)
    if (message.error != null) {
      const error = message.error as { message?: unknown }
      request.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex rejected the request.'))
      return
    }
    request.resolve((message.result ?? {}) as Record<string, unknown>)
  }

  #finishTurn(error: Error | null): void {
    const completion = this.#turnCompletion
    if (completion == null) return
    this.#turnCompletion = null
    if (error == null) completion.resolve()
    else completion.reject(error)
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const child = this.#child
    if (child == null) return Promise.reject(new Error('Codex is not running.'))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Codex did not respond to ${method}.`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async ask(options: {
    executable: string
    cwd: string
    prompt: string
    resumeThreadId?: string
    handlers: CodexTurnHandlers
  }): Promise<void> {
    const { executable, cwd, prompt, resumeThreadId, handlers } = options
    // Registered after the server is up: starting it tears down any previous
    // child, and that teardown clears the handler slot.
    await this.#ensureStarted(cwd, executable)
    this.#handlers = handlers

    if (this.#threadId == null) {
      // read-only keeps the same promise the panel makes: Codex may look, not write.
      const started = resumeThreadId == null
        ? await this.#request(CODEX_METHODS.threadStart, { cwd, sandbox: 'read-only' }, CODEX_STARTUP_TIMEOUT_MS)
        : await this.#request(CODEX_METHODS.threadResume, { threadId: resumeThreadId }, CODEX_STARTUP_TIMEOUT_MS)
      const thread = started.thread as { id?: unknown } | undefined
      // The id lives at result.thread.id, not result.threadId.
      const threadId = typeof thread?.id === 'string' ? thread.id : null
      if (threadId == null) throw new Error('Codex did not return a thread.')
      this.#threadId = threadId
      handlers.onChunk({ kind: 'session', sessionId: threadId })
    }

    const completed = new Promise<void>((resolve, reject) => {
      this.#turnCompletion = { resolve, reject }
    })
    const timeout = setTimeout(
      () => this.#finishTurn(new Error('Codex took too long to answer.')),
      CODEX_TURN_TIMEOUT_MS
    )
    try {
      await this.#request(CODEX_METHODS.turnStart, {
        threadId: this.#threadId,
        input: [{ type: 'text', text: prompt }]
      }, CODEX_STARTUP_TIMEOUT_MS)
      await completed
    } finally {
      clearTimeout(timeout)
      this.#turnCompletion = null
    }
  }

  interrupt(): void {
    // Resolving rather than rejecting: a user-requested stop is not a failure.
    this.#finishTurn(null)
    if (this.#child == null || this.#threadId == null) return
    const params: Record<string, unknown> = { threadId: this.#threadId }
    if (this.#currentTurnId != null) params.turnId = this.#currentTurnId
    void this.#request(CODEX_METHODS.turnInterrupt, params, 5_000).catch(() => {})
  }

  #killChild(): void {
    this.#finishTurn(new Error('Codex was stopped.'))
    this.#threadId = null
    this.#currentTurnId = null
    this.#buffer = ''
    const child = this.#child
    this.#child = null
    child?.kill()
  }

  stop(): void {
    this.#killChild()
    this.#handlers = null
  }
}
