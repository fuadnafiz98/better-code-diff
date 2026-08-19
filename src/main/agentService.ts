import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fileConstants } from 'node:fs'

import { CodexAppServer } from './codexAppServer.js'
import {
  AGENT_READ_ONLY_TOOLS,
  createAgentTextReader,
  interpretAgentLine,
  parseAgentAskRequest,
  type AgentAskRequest
} from './agentRequest.js'

const CLAUDE_CANDIDATES = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
] as const
const CODEX_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'] as const
const MAX_AGENT_RUNTIME_MS = 300_000

export interface AgentEvent {
  id: string
  kind: 'text' | 'session' | 'done' | 'error' | 'activity'
  text?: string
  sessionId?: string
}

async function resolveExecutable(candidates: readonly string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      await access(candidate, fileConstants.X_OK)
      return candidate
    } catch {
      // Try the next known install location.
    }
  }
  return fallback
}

function claudeArgs(request: AgentAskRequest): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--allowed-tools', ...AGENT_READ_ONLY_TOOLS,
    // Resuming forks the transcript so an interactive session the user has open
    // is never mutated by a question asked from this app.
    ...(request.resumeSessionId == null ? [] : ['--resume', request.resumeSessionId, '--fork-session'])
  ]
}

export class AgentService {
  #active = new Map<string, ReturnType<typeof spawn>>()
  // Reused across turns: starting the app-server also starts the user's MCP
  // servers, which costs seconds.
  #codex = new CodexAppServer()
  #codexRequests = new Set<string>()

  cancel(id: unknown): void {
    if (typeof id !== 'string') return
    if (this.#codexRequests.delete(id)) {
      this.#codex.interrupt()
      return
    }
    const child = this.#active.get(id)
    if (child == null) return
    this.#active.delete(id)
    child.kill()
  }

  cancelAll(): void {
    for (const id of [...this.#active.keys()]) this.cancel(id)
    this.#codexRequests.clear()
    this.#codex.stop()
  }

  // Codex streams only through the app-server's JSON-RPC notifications; its
  // `exec --json` transport has no token deltas at all.
  async #askCodex(
    request: AgentAskRequest,
    executable: string,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    this.#codexRequests.add(request.id)
    const readText = createAgentTextReader()
    const prompt = request.context === ''
      ? request.prompt
      : `${request.prompt}\n\n${request.context}`
    let failure: string | null = null
    try {
      await this.#codex.ask({
        executable,
        cwd,
        prompt,
        ...(request.resumeSessionId == null ? {} : { resumeThreadId: request.resumeSessionId }),
        handlers: {
          onChunk: (chunk) => {
            if (!this.#codexRequests.has(request.id)) return
            if (chunk.kind === 'session' && chunk.sessionId != null) {
              emit({ id: request.id, kind: 'session', sessionId: chunk.sessionId })
              return
            }
            if (chunk.kind === 'activity' && chunk.text != null) {
              emit({ id: request.id, kind: 'activity', text: chunk.text })
              return
            }
            if (chunk.kind === 'result' && chunk.failed === true) {
              failure = chunk.text == null || chunk.text === '' ? 'Codex could not finish the turn.' : chunk.text
              return
            }
            const text = readText(chunk)
            if (text != null) emit({ id: request.id, kind: 'text', text })
          },
          onRateLimit: (limit) => {
            // Worth saying out loud: a nearly spent window is the usual reason a
            // turn crawls or refuses.
            if (limit.usedPercent >= 90) {
              emit({
                id: request.id,
                kind: 'activity',
                text: `Codex plan usage at ${Math.round(limit.usedPercent)}% of its window`
              })
            }
          }
        }
      })
    } finally {
      this.#codexRequests.delete(request.id)
    }
    if (failure != null) {
      emit({ id: request.id, kind: 'error', text: failure })
      return
    }
    emit({ id: request.id, kind: 'done' })
  }

  async ask(
    requestValue: unknown,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const request = await parseAgentAskRequest(requestValue)
    if (this.#active.has(request.id)) throw new Error('This question is already running.')

    const executable = request.provider === 'claude'
      ? await resolveExecutable(CLAUDE_CANDIDATES, 'claude')
      : await resolveExecutable(CODEX_CANDIDATES, 'codex')

    if (request.provider === 'codex') {
      await this.#askCodex(request, executable, cwd, emit)
      return
    }

    const args = claudeArgs(request)

    await new Promise<void>((resolve) => {
      const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      this.#active.set(request.id, child)

      let pending = ''
      let errorOutput = ''
      let settled = false
      const readText = createAgentTextReader()
      const finish = (event: AgentEvent): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.#active.delete(request.id)
        emit(event)
        resolve()
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish({ id: request.id, kind: 'error', text: 'The agent took too long to answer.' })
      }, MAX_AGENT_RUNTIME_MS)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        pending += chunk
        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex)
          pending = pending.slice(newlineIndex + 1)
          const interpreted = interpretAgentLine(line)
          if (interpreted != null) {
            if (interpreted.kind === 'session' && interpreted.sessionId != null) {
              emit({ id: request.id, kind: 'session', sessionId: interpreted.sessionId })
            } else if (interpreted.kind === 'activity' && interpreted.text != null) {
              emit({ id: request.id, kind: 'activity', text: interpreted.text })
            } else {
              const text = readText(interpreted)
              if (text != null) emit({ id: request.id, kind: 'text', text })
            }
          }
          newlineIndex = pending.indexOf('\n')
        }
      })

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        errorOutput = `${errorOutput}${chunk}`.slice(-4_096)
      })

      child.on('error', (error) => {
        finish({
          id: request.id,
          kind: 'error',
          text: `${request.provider === 'claude' ? 'Claude Code' : 'Codex'} could not be started. ${error.message}`
        })
      })

      child.on('close', (code, signal) => {
        const trailing = interpretAgentLine(pending)
        if (trailing?.kind === 'text' && trailing.text != null) {
          emit({ id: request.id, kind: 'text', text: trailing.text })
        }
        if (signal != null) {
          finish({ id: request.id, kind: 'error', text: 'The answer was stopped before it finished.' })
          return
        }
        if (code != null && code !== 0) {
          finish({
            id: request.id,
            kind: 'error',
            text: errorOutput.trim() || `The agent exited with code ${code}.`
          })
          return
        }
        finish({ id: request.id, kind: 'done' })
      })

      const stdinPayload = request.context === ''
        ? request.prompt
        : `${request.prompt}\n\n${request.context}`
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdinPayload)
    })
  }
}
