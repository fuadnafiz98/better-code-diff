import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'

import * as nodePty from 'node-pty'
import type { IDisposable, IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty'

import {
  IPC_CHANNELS,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSession
} from '../shared/contracts.js'

const MIN_COLUMNS = 2
const MAX_COLUMNS = 500
const MIN_ROWS = 1
const MAX_ROWS = 240
const MAX_INPUT_CHUNK = 256 * 1_024
const OUTPUT_BATCH_DELAY_MS = 8
const OUTPUT_BATCH_SIZE = 64 * 1_024

const OMITTED_CHILD_ENVIRONMENT_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'GOOGLE_API_KEY',
  'GOOGLE_DEFAULT_CLIENT_ID',
  'GOOGLE_DEFAULT_CLIENT_SECRET',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE'
])

export interface TerminalOwner {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: TerminalDataEvent | TerminalExitEvent): void
  once(event: 'destroyed', listener: () => void): unknown
}

export interface TerminalShell {
  executable: string
  args: string[]
  label: string
}

type PtyFactory = (
  executable: string,
  args: string[],
  options: IPtyForkOptions | IWindowsPtyForkOptions
) => IPty

interface ManagedTerminal {
  id: string
  owner: TerminalOwner
  process: IPty
  dataSubscription: IDisposable
  exitSubscription: IDisposable
  pendingOutput: string
  outputTimer: ReturnType<typeof setTimeout> | null
  ready: boolean
}

export function normalizeTerminalSize(columns: unknown, rows: unknown): { columns: number; rows: number } {
  if (typeof columns !== 'number' || !Number.isInteger(columns)
    || typeof rows !== 'number' || !Number.isInteger(rows)) {
    throw new Error('Terminal dimensions must be integers.')
  }
  if (columns < MIN_COLUMNS || columns > MAX_COLUMNS || rows < MIN_ROWS || rows > MAX_ROWS) {
    throw new Error('Terminal dimensions are outside the supported range.')
  }
  return { columns, rows }
}

export function resolveTerminalShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync
): TerminalShell {
  if (platform === 'win32') {
    const executable = environment.COMSPEC?.trim() || 'powershell.exe'
    return { executable, args: [], label: basename(executable) }
  }

  const configuredShell = environment.SHELL?.trim()
  const fallbacks = platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/zsh', '/bin/sh']
  const executable = configuredShell != null
    && isAbsolute(configuredShell)
    && pathExists(configuredShell)
    ? configuredShell
    : fallbacks.find(pathExists) ?? '/bin/sh'
  return { executable, args: ['-l'], label: basename(executable) }
}

export function createTerminalEnvironment(
  cwd: string,
  version: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !OMITTED_CHILD_ENVIRONMENT_KEYS.has(key)) {
      environment[key] = value
    }
  }
  environment.COLORTERM = 'truecolor'
  environment.TERM = 'xterm-256color'
  environment.TERM_PROGRAM = 'Horus'
  environment.TERM_PROGRAM_VERSION = version
  if (process.platform !== 'win32') environment.PWD = cwd
  return environment
}

export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>()
  private readonly boundOwners = new Set<number>()

  constructor(private readonly spawnPty: PtyFactory = nodePty.spawn) {}

  create(
    owner: TerminalOwner,
    cwd: string,
    columns: unknown,
    rows: unknown,
    version: string
  ): TerminalSession {
    if (!isAbsolute(cwd) || !existsSync(cwd)) {
      throw new Error('The open project does not have a valid terminal directory.')
    }
    const size = normalizeTerminalSize(columns, rows)
    const shell = resolveTerminalShell()
    this.killOwnerSessions(owner.id)

    const process = this.spawnPty(shell.executable, shell.args, {
      name: 'xterm-256color',
      cols: size.columns,
      rows: size.rows,
      cwd,
      env: createTerminalEnvironment(cwd, version)
    })
    process.pause()

    const id = randomUUID()
    const session = {
      id,
      owner,
      process,
      dataSubscription: null as unknown as IDisposable,
      exitSubscription: null as unknown as IDisposable,
      pendingOutput: '',
      outputTimer: null,
      ready: false
    } satisfies ManagedTerminal
    this.sessions.set(id, session)
    session.dataSubscription = process.onData((data) => this.queueOutput(session, data))
    session.exitSubscription = process.onExit(({ exitCode, signal }) => {
      this.flushOutput(session)
      if (!owner.isDestroyed()) {
        owner.send(IPC_CHANNELS.terminalExit, {
          sessionId: id,
          exitCode,
          ...(signal == null ? {} : { signal })
        })
      }
      this.disposeSession(session, false)
    })
    this.bindOwner(owner)

    return { id, cwd, shell: shell.label, pid: process.pid }
  }

  ready(ownerId: number, sessionId: unknown): void {
    const session = this.getOwnedSession(ownerId, sessionId)
    if (session == null || session.ready) return
    session.ready = true
    session.process.resume()
  }

  write(ownerId: number, sessionId: unknown, data: unknown): void {
    const session = this.getOwnedSession(ownerId, sessionId)
    if (session == null) return
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_CHUNK) {
      throw new Error('Terminal input is invalid or too large.')
    }
    session.process.write(data)
  }

  resize(ownerId: number, sessionId: unknown, columns: unknown, rows: unknown): void {
    const session = this.getOwnedSession(ownerId, sessionId)
    if (session == null) return
    const size = normalizeTerminalSize(columns, rows)
    if (session.process.cols === size.columns && session.process.rows === size.rows) return
    session.process.resize(size.columns, size.rows)
  }

  clear(ownerId: number, sessionId: unknown): void {
    this.getOwnedSession(ownerId, sessionId)?.process.clear()
  }

  kill(ownerId: number, sessionId: unknown): void {
    const session = this.getOwnedSession(ownerId, sessionId)
    if (session != null) this.disposeSession(session, true)
  }

  killAll(): void {
    for (const session of [...this.sessions.values()]) this.disposeSession(session, true)
  }

  private bindOwner(owner: TerminalOwner): void {
    if (this.boundOwners.has(owner.id)) return
    this.boundOwners.add(owner.id)
    owner.once('destroyed', () => {
      this.killOwnerSessions(owner.id)
      this.boundOwners.delete(owner.id)
    })
  }

  private getOwnedSession(ownerId: number, sessionId: unknown): ManagedTerminal | null {
    if (typeof sessionId !== 'string' || sessionId.length > 100) return null
    const session = this.sessions.get(sessionId)
    return session?.owner.id === ownerId ? session : null
  }

  private killOwnerSessions(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.owner.id === ownerId) this.disposeSession(session, true)
    }
  }

  private queueOutput(session: ManagedTerminal, data: string): void {
    if (!this.sessions.has(session.id) || data === '') return
    session.pendingOutput += data
    if (!session.ready) return
    if (session.pendingOutput.length >= OUTPUT_BATCH_SIZE) {
      this.flushOutput(session)
      return
    }
    if (session.outputTimer != null) return
    session.outputTimer = setTimeout(() => {
      session.outputTimer = null
      this.flushOutput(session)
    }, OUTPUT_BATCH_DELAY_MS)
  }

  private flushOutput(session: ManagedTerminal): void {
    if (!session.ready || session.pendingOutput === '') return
    const data = session.pendingOutput
    session.pendingOutput = ''
    if (!session.owner.isDestroyed()) {
      session.owner.send(IPC_CHANNELS.terminalData, { sessionId: session.id, data })
    }
  }

  private disposeSession(session: ManagedTerminal, terminate: boolean): void {
    if (!this.sessions.delete(session.id)) return
    if (session.outputTimer != null) clearTimeout(session.outputTimer)
    session.outputTimer = null
    session.dataSubscription.dispose()
    session.exitSubscription.dispose()
    if (terminate) {
      try {
        session.process.kill()
      } catch {
        // The process can exit between the ownership check and termination.
      }
    }
  }
}
