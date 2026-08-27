import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  IconBranch,
  IconCollapsedRow,
  IconFileCode,
  IconFolder,
  IconGear,
  IconInReview,
  IconSearch,
  IconSidebar,
  IconTerminalFill,
  IconTypeWord
} from '@pierre/icons'

import {
  KEYBINDING_COMMANDS,
  formatKeybinding,
  formatTerminalToggleShortcut,
  type AppCommand,
  type KeybindingMap
} from './keybindings'
import {
  groupPaletteEntries,
  nextPaletteIndex,
  rankPaletteEntries,
  type PaletteEntry
} from './paletteCommands'
import { parsePullRequestSelector } from './pullRequestSelector'

const MAX_RESULTS = 30
const MAX_FILE_RESULTS = 5
const MAX_BRANCH_RESULTS = 5

const COMMAND_ICONS: Record<AppCommand, React.ComponentType> = {
  openFolder: IconFolder,
  openCommandPalette: IconSearch,
  goToFile: IconSearch,
  searchContent: IconSearch,
  toggleSidebar: IconSidebar,
  toggleWordWrap: IconTypeWord,
  toggleFoldUnchanged: IconCollapsedRow,
  toggleTerminal: IconTerminalFill,
  openSettings: IconGear
}

// Everything but opening a folder or the settings needs something open first.
const PROJECT_COMMANDS = new Set<AppCommand>([
  'goToFile',
  'searchContent',
  'toggleSidebar',
  'toggleWordWrap',
  'toggleFoldUnchanged',
  'toggleTerminal'
])

interface CommandPaletteProps {
  gitRepositoryOpen: boolean
  projectOpen: boolean
  keybindings: KeybindingMap
  /** Recently opened files, most recent first. Rendered under a Files group. */
  recentFiles?: readonly string[]
  /** Local branch names, already loaded by the git panel. Never fetched here. */
  branches?: readonly string[]
  onClose(): void
  onOpenPullRequest(selector: number | string): void
  onOpenRepository(): void
  onOpenSettings(): void
  onToggleTerminal(): void
  /** Runs an application command. Without it only the three wired actions show. */
  onRunCommand?(command: AppCommand): void
  onOpenFile?(path: string): void
  onSwitchBranch?(branch: string): void
}

export interface CommandPaletteHandle {
  close(): boolean
  toggle(): void
}

type CommandPaletteControllerProps = Omit<CommandPaletteProps, 'onClose'>

interface PaletteAction extends PaletteEntry {
  icon: React.ComponentType
  run(): void
}

function pullRequestNumber(selector: number | string): number {
  if (typeof selector === 'number') return selector
  const match = /\/pull\/(\d+)/i.exec(selector)
  return Number(match?.[1])
}

function CommandPalette({
  gitRepositoryOpen,
  projectOpen,
  keybindings,
  recentFiles,
  branches,
  onClose,
  onOpenPullRequest,
  onOpenRepository,
  onOpenSettings,
  onToggleTerminal,
  onRunCommand,
  onOpenFile,
  onSwitchBranch
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const selector = parsePullRequestSelector(query)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog != null && !dialog.open) dialog.showModal()
    inputRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  const actions = useMemo<PaletteAction[]>(() => {
    const runAndClose = (run: () => void) => () => {
      onClose()
      run()
    }
    const entries: PaletteAction[] = [{
      id: 'open-repository',
      group: 'Commands',
      title: 'Open repository',
      subtitle: 'Branches, commits, remotes, and pull requests',
      icon: IconBranch,
      disabledReason: gitRepositoryOpen ? undefined : 'Open a Git repository first',
      run: runAndClose(onOpenRepository)
    }]

    for (const { command, label, description } of KEYBINDING_COMMANDS) {
      // The palette cannot open itself, and re-binding it is a settings concern.
      if (command === 'openCommandPalette') continue
      const dedicated = command === 'openSettings'
        ? onOpenSettings
        : command === 'toggleTerminal' ? onToggleTerminal : null
      const run = dedicated ?? (onRunCommand == null ? null : () => onRunCommand(command))
      if (run == null) continue
      entries.push({
        id: `command:${command}`,
        group: 'Commands',
        title: label,
        subtitle: description,
        keybinding: command === 'toggleTerminal'
          ? formatTerminalToggleShortcut()
          : formatKeybinding(keybindings[command]),
        icon: COMMAND_ICONS[command],
        disabledReason: PROJECT_COMMANDS.has(command) && !projectOpen ? 'Open a project first' : undefined,
        run: runAndClose(run)
      })
    }

    if (onOpenFile != null) {
      for (const path of (recentFiles ?? []).slice(0, MAX_FILE_RESULTS)) {
        entries.push({
          id: `file:${path}`,
          group: 'Files',
          title: path.slice(path.lastIndexOf('/') + 1),
          subtitle: path,
          icon: IconFileCode,
          run: runAndClose(() => onOpenFile(path))
        })
      }
    }

    if (onSwitchBranch != null) {
      for (const branch of (branches ?? []).slice(0, MAX_BRANCH_RESULTS)) {
        entries.push({
          id: `branch:${branch}`,
          group: 'Branches',
          title: branch,
          subtitle: 'Switch to this branch',
          icon: IconBranch,
          run: runAndClose(() => onSwitchBranch(branch))
        })
      }
    }

    return entries
  }, [
    branches, gitRepositoryOpen, keybindings, onClose, onOpenFile, onOpenRepository,
    onOpenSettings, onRunCommand, onSwitchBranch, onToggleTerminal, projectOpen, recentFiles
  ])

  const results = useMemo(
    () => selector != null ? [] : rankPaletteEntries(actions, query, MAX_RESULTS) as PaletteAction[],
    [actions, query, selector]
  )
  const groups = useMemo(() => groupPaletteEntries(results), [results])
  const activeAction = results[Math.min(activeIndex, results.length - 1)]

  const displayPullRequest = (): void => {
    if (!gitRepositoryOpen || selector == null) return
    onClose()
    onOpenPullRequest(selector)
  }

  const runActive = (): void => {
    if (selector != null) {
      displayPullRequest()
      return
    }
    if (activeAction?.disabledReason == null) activeAction?.run()
  }

  let rowIndex = -1

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-layer"
      aria-labelledby="command-palette-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <section className="command-palette">
        <form onSubmit={(event) => {
          event.preventDefault()
          runActive()
        }}>
          <IconSearch aria-hidden="true" />
          <label className="sr-only" id="command-palette-title" htmlFor="command-palette-input">Command palette</label>
          <input
            ref={inputRef}
            id="command-palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              setActiveIndex((current) => nextPaletteIndex(current, event.key === 'ArrowDown' ? 1 : -1, results.length))
            }}
            placeholder="Type a command, PR number, or GitHub URL"
            spellCheck={false}
            autoCapitalize="none"
          />
          <kbd>{formatKeybinding(keybindings.openCommandPalette)}</kbd>
        </form>

        <div className="command-palette-results" aria-live="polite">
          {selector != null ? (
            <button type="button" className="primary-result" onClick={displayPullRequest} disabled={!gitRepositoryOpen}>
              <span className="command-icon"><IconInReview /></span>
              <span>
                <strong>Display PR #{pullRequestNumber(selector)}</strong>
                <small>{gitRepositoryOpen ? 'Open the pull request in multi-file review' : 'Open a Git repository first'}</small>
              </span>
              <kbd>↵</kbd>
            </button>
          ) : results.length === 0 ? (
            <div className="command-palette-empty">
              <IconSearch aria-hidden="true" />
              <strong>No matching command</strong>
              <span>Try a command name, a PR number such as #123, or a GitHub pull request URL.</span>
            </div>
          ) : groups.map(({ group, entries }) => (
            <div key={group}>
              <p>{group}</p>
              {entries.map((entry) => {
                const action = entry as PaletteAction
                rowIndex += 1
                const index = rowIndex
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={action.id === activeAction?.id ? 'primary-result' : undefined}
                    disabled={action.disabledReason != null}
                    onPointerEnter={() => setActiveIndex(index)}
                    onClick={action.run}
                  >
                    <span className="command-icon"><action.icon /></span>
                    <span><strong>{action.title}</strong><small>{action.disabledReason ?? action.subtitle}</small></span>
                    {action.keybinding == null ? null : <kbd>{action.keybinding}</kbd>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <footer>
          <span><kbd>↑↓</kbd> Select</span>
          <span><kbd>↵</kbd> Run</span>
          <span><kbd>esc</kbd> Close</span>
        </footer>
      </section>
    </dialog>
  )
}

export const CommandPaletteController = memo(forwardRef<CommandPaletteHandle, CommandPaletteControllerProps>(
  function CommandPaletteController(props, ref): React.JSX.Element | null {
    const [open, setOpen] = useState(false)
    const openRef = useRef(false)
    const focusReturnRef = useRef<HTMLElement | null>(null)

    const setVisibility = (visible: boolean): void => {
      if (visible && !openRef.current) {
        focusReturnRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      }
      openRef.current = visible
      setOpen(visible)
      if (!visible) {
        const focusTarget = focusReturnRef.current
        focusReturnRef.current = null
        window.requestAnimationFrame(() => focusTarget?.focus())
      }
    }

    useImperativeHandle(ref, () => ({
      close: () => {
        if (!openRef.current) return false
        setVisibility(false)
        return true
      },
      toggle: () => setVisibility(!openRef.current)
    }), [])

    return open ? <CommandPalette {...props} onClose={() => setVisibility(false)} /> : null
  }
))
