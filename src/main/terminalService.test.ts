import { describe, expect, test } from 'bun:test'
import type { IPty } from 'node-pty'

import type { TerminalDataEvent, TerminalExitEvent } from '../shared/contracts.js'
import {
  createTerminalEnvironment,
  normalizeTerminalSize,
  resolveTerminalShell,
  TerminalService,
  type TerminalOwner
} from './terminalService.js'

function fakePty(): IPty & {
  emitData(data: string): void
  emitExit(exitCode: number): void
  writes: Array<string | Buffer>
  cleared: boolean
  killed: boolean
  paused: boolean
} {
  let dataListener: (data: string) => void = () => {}
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () => {}
  return {
    pid: 42,
    cols: 80,
    rows: 24,
    process: 'zsh',
    handleFlowControl: false,
    cleared: false,
    killed: false,
    paused: false,
    writes: [],
    onData(listener) {
      dataListener = listener
      return { dispose: () => { dataListener = () => {} } }
    },
    onExit(listener) {
      exitListener = listener
      return { dispose: () => { exitListener = () => {} } }
    },
    resize(columns, rows) {
      Object.assign(this, { cols: columns, rows })
    },
    clear() { this.cleared = true },
    write(data) { this.writes.push(data) },
    kill() { this.killed = true },
    pause() { this.paused = true },
    resume() { this.paused = false },
    emitData(data) { dataListener(data) },
    emitExit(exitCode) { exitListener({ exitCode }) }
  }
}

function fakeOwner(id: number): TerminalOwner & {
  events: Array<{ channel: string; payload: TerminalDataEvent | TerminalExitEvent }>
  destroy(): void
} {
  let destroyed = false
  let destroyListener = (): void => {}
  return {
    id,
    events: [],
    isDestroyed: () => destroyed,
    send(channel, payload) { this.events.push({ channel, payload }) },
    once(_event, listener) { destroyListener = listener },
    destroy() {
      destroyed = true
      destroyListener()
    }
  }
}

describe('terminal configuration', () => {
  test('uses the configured login shell and a safe fallback', () => {
    expect(resolveTerminalShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, () => true))
      .toEqual({ executable: '/opt/homebrew/bin/fish', args: ['-l'], label: 'fish' })
    expect(resolveTerminalShell('darwin', { SHELL: 'relative-shell' }, (path) => path === '/bin/zsh'))
      .toEqual({ executable: '/bin/zsh', args: ['-l'], label: 'zsh' })
  })

  test('sets terminal metadata without leaking Electron child-process flags', () => {
    const environment = createTerminalEnvironment('/work/project', '1.2.3', {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      GOOGLE_API_KEY: 'internal'
    })
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(environment.GOOGLE_API_KEY).toBeUndefined()
    expect(environment.TERM).toBe('xterm-256color')
    expect(environment.TERM_PROGRAM).toBe('Horus')
  })

  test('rejects malformed or excessive dimensions', () => {
    expect(normalizeTerminalSize(120, 40)).toEqual({ columns: 120, rows: 40 })
    expect(() => normalizeTerminalSize(0, 40)).toThrow()
    expect(() => normalizeTerminalSize(80.5, 40)).toThrow()
    expect(() => normalizeTerminalSize(80, 500)).toThrow()
  })
})

describe('TerminalService', () => {
  test('scopes input to its renderer and waits for renderer readiness before output', async () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const otherOwner = fakeOwner(2)
    const service = new TerminalService(() => pty)
    const session = service.create(owner, process.cwd(), 80, 24, '0.1.0')

    expect(pty.paused).toBe(true)
    pty.emitData('prompt')
    expect(owner.events).toHaveLength(0)
    service.write(otherOwner.id, session.id, 'blocked')
    service.write(owner.id, session.id, 'accepted')
    expect(pty.writes).toEqual(['accepted'])

    service.ready(owner.id, session.id)
    pty.emitData(' ready')
    await Bun.sleep(15)
    expect(pty.paused).toBe(false)
    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, data: 'prompt ready' })

    owner.destroy()
    expect(pty.killed).toBe(true)
  })

  test('resizes, clears, reports exit, and rejects work after exit', () => {
    const pty = fakePty()
    const owner = fakeOwner(1)
    const service = new TerminalService(() => pty)
    const session = service.create(owner, process.cwd(), 80, 24, '0.1.0')

    service.resize(owner.id, session.id, 120, 36)
    service.clear(owner.id, session.id)
    expect({ columns: pty.cols, rows: pty.rows, cleared: pty.cleared })
      .toEqual({ columns: 120, rows: 36, cleared: true })

    service.ready(owner.id, session.id)
    pty.emitExit(7)
    expect(owner.events.at(-1)?.payload).toEqual({ sessionId: session.id, exitCode: 7 })

    service.write(owner.id, session.id, 'ignored')
    service.resize(owner.id, session.id, 90, 20)
    expect(pty.writes).toHaveLength(0)
    expect({ columns: pty.cols, rows: pty.rows }).toEqual({ columns: 120, rows: 36 })
  })
})
