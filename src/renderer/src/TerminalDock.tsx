import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import {
  IconReload,
  IconTerminalBashFill,
  IconTrash,
  IconX
} from '@pierre/icons'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import type { TerminalSession } from '../../shared/contracts'
import type { EditorThemeType } from './preferences'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import { clampTerminalHeight, resizedTerminalHeight } from './terminalPanel'

type TerminalStatus = 'starting' | 'running' | 'exited' | 'failed'

export interface TerminalDockHandle {
  focus(): void
}

interface TerminalDockProps {
  open: boolean
  projectName: string
  projectRoot: string
  height: number
  fontFamily: string
  fontSize: number
  lineHeight: number
  themeType: EditorThemeType
  shortcutLabel: string
  onClose(): void
  onHeightChange(height: number): void
  onHeightCommit(height: number): void
  onResizingChange(resizing: boolean): void
}

function themeFor(type: EditorThemeType): ITheme {
  if (type === 'light') {
    return {
      background: '#ffffff',
      foreground: '#34373e',
      cursor: '#276bd6',
      cursorAccent: '#ffffff',
      selectionBackground: '#b8d2f5',
      selectionInactiveBackground: '#d8e4f3',
      black: '#24272d',
      red: '#b42318',
      green: '#16734f',
      yellow: '#805b10',
      blue: '#276bd6',
      magenta: '#7542a6',
      cyan: '#176783',
      white: '#e7e8eb',
      brightBlack: '#707681',
      brightRed: '#d92d20',
      brightGreen: '#1f9d6a',
      brightYellow: '#a87616',
      brightBlue: '#175cd3',
      brightMagenta: '#9b51d0',
      brightCyan: '#168aad',
      brightWhite: '#ffffff'
    }
  }
  return {
    background: '#0d0e10',
    foreground: '#d9dbe0',
    cursor: '#78a9ff',
    cursorAccent: '#0d0e10',
    selectionBackground: '#29466f',
    selectionInactiveBackground: '#243247',
    black: '#24262b',
    red: '#ef8582',
    green: '#65d3a8',
    yellow: '#dfc369',
    blue: '#78a9ff',
    magenta: '#c49aee',
    cyan: '#78c5e6',
    white: '#d9dbe0',
    brightBlack: '#797d86',
    brightRed: '#ff9b98',
    brightGreen: '#80e8bd',
    brightYellow: '#f0d780',
    brightBlue: '#9bc1ff',
    brightMagenta: '#d8b5fa',
    brightCyan: '#92daf5',
    brightWhite: '#ffffff'
  }
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

function terminalStatusLabel(
  status: TerminalStatus,
  shell: string | undefined,
  exitCode: number | null
): string {
  if (status === 'starting') return 'Starting'
  if (status === 'running') return shell ?? 'Running'
  if (status === 'exited') return `Exited ${exitCode ?? ''}`.trim()
  return 'Unavailable'
}

interface TerminalHeaderProps {
  status: TerminalStatus
  statusLabel: string
  contextLabel: string
  cwd: string
  shortcutLabel: string
  onClear(): void
  onRestart(): void
  onClose(): void
}

interface TerminalResizerProps {
  height: number
  onReset(): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onPointerDown(event: PointerEvent<HTMLDivElement>): void
  onPointerMove(event: PointerEvent<HTMLDivElement>): void
  onPointerUp(event: PointerEvent<HTMLDivElement>): void
}

function TerminalResizer({
  height,
  onReset,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: TerminalResizerProps): React.JSX.Element {
  return (
    <div
      className="terminal-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Resize terminal"
      aria-orientation="horizontal"
      aria-valuemin={clampTerminalHeight(0, window.innerHeight)}
      aria-valuemax={clampTerminalHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)}
      aria-valuenow={height}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}

function TerminalHeader({
  status,
  statusLabel,
  contextLabel,
  cwd,
  shortcutLabel,
  onClear,
  onRestart,
  onClose
}: TerminalHeaderProps): React.JSX.Element {
  return (
    <header className="terminal-header">
      <div className="terminal-title">
        <IconTerminalBashFill />
        <strong>Terminal</strong>
        <span className={`terminal-status ${status}`} aria-hidden="true" />
        <span className="sr-only">{statusLabel}</span>
        <span className="terminal-shell">{statusLabel}</span>
      </div>
      <code className="terminal-context" title={cwd}>{contextLabel}</code>
      <div className="terminal-actions">
        <button type="button" onClick={onClear} aria-label="Clear terminal" title="Clear Terminal">
          <IconTrash />
        </button>
        <button type="button" onClick={onRestart} aria-label="Restart terminal" title="Restart Terminal">
          <IconReload />
        </button>
        <button type="button" onClick={onClose} aria-label="Hide terminal" title={`Hide Terminal (${shortcutLabel})`}>
          <IconX />
        </button>
      </div>
    </header>
  )
}

export const TerminalDock = forwardRef<TerminalDockHandle, TerminalDockProps>(function TerminalDock({
  open,
  projectName,
  projectRoot,
  height,
  fontFamily,
  fontSize,
  lineHeight,
  themeType,
  shortcutLabel,
  onClose,
  onHeightChange,
  onHeightCommit,
  onResizingChange
}, ref): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const disposedRef = useRef(false)
  const generationRef = useRef(0)
  const startingRef = useRef(false)
  const statusRef = useRef<TerminalStatus>('starting')
  const initialSettingsRef = useRef({ fontFamily, fontSize, lineHeight, themeType })
  const resizeFrameRef = useRef(0)
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('starting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processTitle, setProcessTitle] = useState('')

  const updateStatus = useCallback((nextStatus: TerminalStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  const startTerminal = useCallback(async (resetBuffer: boolean) => {
    if (startingRef.current) return
    const terminal = terminalRef.current
    if (terminal == null) return
    startingRef.current = true
    const generation = generationRef.current + 1
    generationRef.current = generation
    const previousSessionId = sessionIdRef.current
    sessionIdRef.current = null
    setSession(null)
    updateStatus('starting')
    setExitCode(null)
    setError(null)
    setProcessTitle('')
    if (previousSessionId != null) {
      await requireRepositoryApi().killTerminal(previousSessionId).catch(() => {})
    }
    if (resetBuffer) terminal.reset()

    try {
      fitRef.current?.()
      const nextSession = await requireRepositoryApi().createTerminal(terminal.cols, terminal.rows)
      if (disposedRef.current || generationRef.current !== generation) {
        await requireRepositoryApi().killTerminal(nextSession.id).catch(() => {})
        return
      }
      sessionIdRef.current = nextSession.id
      setSession(nextSession)
      updateStatus('running')
      requireRepositoryApi().readyTerminal(nextSession.id)
      window.requestAnimationFrame(() => terminal.focus())
    } catch (startError) {
      if (!disposedRef.current && generationRef.current === generation) {
        const message = getErrorMessage(startError)
        updateStatus('failed')
        setError(message)
        terminal.writeln(`\r\n\x1b[31mCould not start the project terminal.\x1b[0m ${message}`)
      }
    } finally {
      if (generationRef.current === generation) startingRef.current = false
    }
  }, [updateStatus])
  const startTerminalEvent = useEffectEvent(startTerminal)

  useImperativeHandle(ref, () => ({
    focus: () => {
      fitRef.current?.()
      terminalRef.current?.focus()
    }
  }), [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      startingRef.current = false
      generationRef.current += 1
      window.cancelAnimationFrame(resizeFrameRef.current)
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId != null) void requireRepositoryApi().killTerminal(sessionId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const api = requireRepositoryApi()
    const unsubscribeData = api.onTerminalData((event) => {
      if (event.sessionId === sessionIdRef.current) terminalRef.current?.write(event.data)
    })
    const unsubscribeExit = api.onTerminalExit((event) => {
      if (event.sessionId !== sessionIdRef.current) return
      sessionIdRef.current = null
      updateStatus('exited')
      setExitCode(event.exitCode)
      terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${event.exitCode}. Press Enter to restart.\x1b[0m`)
    })
    return () => {
      unsubscribeData()
      unsubscribeExit()
    }
  }, [updateStatus])

  useEffect(() => {
    const container = containerRef.current
    if (container == null) return
    const initialSettings = initialSettingsRef.current
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: false,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      fontFamily: initialSettings.fontFamily,
      fontSize: initialSettings.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: initialSettings.lineHeight,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      scrollback: 10_000,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: themeFor(initialSettings.themeType)
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal

    let fitFrame = 0
    const fit = (): void => {
      window.cancelAnimationFrame(fitFrame)
      fitFrame = window.requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fitAddon.fit()
      })
    }
    fitRef.current = fit
    fit()
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)
    const inputSubscription = terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (sessionId != null) requireRepositoryApi().writeTerminal(sessionId, data)
    })
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current
      if (sessionId != null) requireRepositoryApi().resizeTerminal(sessionId, cols, rows)
    })
    const titleSubscription = terminal.onTitleChange(setProcessTitle)
    const keySubscription = terminal.onKey(({ domEvent }) => {
      if (domEvent.key === 'Enter' && sessionIdRef.current == null && statusRef.current === 'exited') {
        void startTerminalEvent(true)
      }
    })

    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(fitFrame)
      inputSubscription.dispose()
      resizeSubscription.dispose()
      titleSubscription.dispose()
      keySubscription.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal == null) return
    terminal.options.fontFamily = fontFamily
    terminal.options.fontSize = fontSize
    terminal.options.lineHeight = lineHeight
    terminal.options.theme = themeFor(themeType)
    fitRef.current?.()
  }, [fontFamily, fontSize, lineHeight, themeType])

  useEffect(() => {
    if (!open) return
    if (sessionIdRef.current == null && !startingRef.current && status !== 'exited') {
      void startTerminal(false)
    }
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        fitRef.current?.()
        terminalRef.current?.focus()
      })
      resizeFrameRef.current = secondFrame
    })
    resizeFrameRef.current = firstFrame
    return () => window.cancelAnimationFrame(resizeFrameRef.current)
  }, [open, startTerminal, status])

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const range = event.shiftKey ? 48 : 16
    let nextHeight: number | null = null
    if (event.key === 'ArrowUp') nextHeight = clampTerminalHeight(height + range, window.innerHeight)
    if (event.key === 'ArrowDown') nextHeight = clampTerminalHeight(height - range, window.innerHeight)
    if (event.key === 'Home') nextHeight = clampTerminalHeight(0, window.innerHeight)
    if (event.key === 'End') nextHeight = clampTerminalHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)
    if (nextHeight == null) return
    event.preventDefault()
    onHeightChange(nextHeight)
    onHeightCommit(nextHeight)
  }

  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height }
    event.currentTarget.setPointerCapture(event.pointerId)
    onResizingChange(true)
  }

  const continueResize = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag == null || drag.pointerId !== event.pointerId) return
    const nextHeight = resizedTerminalHeight(drag.startHeight, drag.startY, event.clientY, window.innerHeight)
    window.cancelAnimationFrame(resizeFrameRef.current)
    resizeFrameRef.current = window.requestAnimationFrame(() => onHeightChange(nextHeight))
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag == null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.cancelAnimationFrame(resizeFrameRef.current)
    const nextHeight = resizedTerminalHeight(drag.startHeight, drag.startY, event.clientY, window.innerHeight)
    onHeightChange(nextHeight)
    onHeightCommit(nextHeight)
    onResizingChange(false)
  }

  const statusLabel = terminalStatusLabel(status, session?.shell, exitCode)
  const contextLabel = processTitle.trim() || compactPath(session?.cwd ?? projectRoot)

  return (
    <section
      className="terminal-dock"
      data-state={status}
      aria-label={`Terminal for ${projectName}`}
      aria-hidden={!open}
      inert={!open}
    >
      <TerminalResizer
        height={height}
        onReset={() => {
          const nextHeight = clampTerminalHeight(260, window.innerHeight)
          onHeightChange(nextHeight)
          onHeightCommit(nextHeight)
        }}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
      />
      <TerminalHeader
        status={status}
        statusLabel={statusLabel}
        contextLabel={contextLabel}
        cwd={session?.cwd ?? projectRoot}
        shortcutLabel={shortcutLabel}
        onClear={() => {
          terminalRef.current?.clear()
          const sessionId = sessionIdRef.current
          if (sessionId != null) requireRepositoryApi().clearTerminal(sessionId)
          terminalRef.current?.focus()
        }}
        onRestart={() => void startTerminal(true)}
        onClose={onClose}
      />
      <div className="terminal-surface">
        <div className="terminal-viewport" ref={containerRef} />
        {error == null ? null : <div className="terminal-error" role="alert">{error}</div>}
      </div>
    </section>
  )
})

export default TerminalDock
