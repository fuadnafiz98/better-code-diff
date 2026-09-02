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
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconTerminalFill,
  IconTypeWord
} from '@pierre/icons'

import type { ContentSearchResult } from '../../shared/contracts'
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
import { tokenizeSearchPreview } from './searchPreview'

const MAX_RESULTS = 30
const MAX_RECENT_FILES = 5
const MAX_SEARCH_FILES = 12
const MAX_CONTENT_RESULTS = 8
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

const PROJECT_COMMANDS = new Set<AppCommand>([
  'toggleSidebar',
  'toggleWordWrap',
  'toggleFoldUnchanged',
  'toggleTerminal'
])

const PALETTE_ONLY_COMMANDS = new Set<AppCommand>([
  'openCommandPalette',
  'goToFile',
  'searchContent'
])

interface CommandPaletteProps {
  gitRepositoryOpen: boolean
  projectOpen: boolean
  keybindings: KeybindingMap
  recentFiles?: readonly string[]
  fileResults?: readonly string[]
  contentResults?: readonly ContentSearchResult[]
  searchingContent?: boolean
  branches?: readonly string[]
  onClose(): void
  onQueryChange?(query: string): void
  onOpenPullRequest(selector: number | string): void
  onOpenRepository(): void
  onOpenSettings(): void
  onToggleTerminal(): void
  onRunCommand?(command: AppCommand): void
  onOpenFile?(path: string): void
  onSwitchBranch?(branch: string): void
}

export interface CommandPaletteHandle {
  close(): boolean
  open(): void
  toggle(): void
}

type CommandPaletteControllerProps = Omit<CommandPaletteProps, 'onClose'>

interface PaletteAction extends PaletteEntry {
  icon: React.ComponentType
  preview?: string
  previewPath?: string
  run(): void
}

function pullRequestNumber(selector: number | string): number {
  if (typeof selector === 'number') return selector
  const match = /\/pull\/(\d+)/i.exec(selector)
  return Number(match?.[1])
}

function fileNameFromPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function isCommandOnlyQuery(query: string): boolean {
  return query.trimStart().startsWith('>')
}

function paletteFilterQuery(query: string): string {
  const trimmed = query.trimStart()
  return trimmed.startsWith('>') ? trimmed.slice(1).trim() : query
}

function searchQueryForRepository(query: string): string {
  return isCommandOnlyQuery(query) ? '' : query
}

const SearchPreview = memo(function SearchPreview({
  path,
  preview,
  query
}: { path: string; preview: string; query: string }): React.JSX.Element {
  const tokens = tokenizeSearchPreview(path, preview, query)
  return <>{tokens.map((token, index) => (
    <span
      className={`search-syntax-${token.kind}${token.match ? ' search-query-match' : ''}`}
      key={`${index}:${token.text}`}
    >
      {token.text}
    </span>
  ))}</>
})

function CommandPalette({
  gitRepositoryOpen,
  projectOpen,
  keybindings,
  recentFiles,
  fileResults,
  contentResults,
  searchingContent,
  branches,
  onClose,
  onQueryChange,
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
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const scrollActiveRowRef = useRef(false)
  const selector = parsePullRequestSelector(query)
  const filterQuery = paletteFilterQuery(query)
  const commandOnly = isCommandOnlyQuery(query)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog != null && !dialog.open) dialog.showModal()
    inputRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  const commandActions = useMemo<PaletteAction[]>(() => {
    const runAndClose = (run: () => void) => () => {
      onQueryChange?.('')
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
      if (PALETTE_ONLY_COMMANDS.has(command)) continue
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
    branches, gitRepositoryOpen, keybindings, onClose, onOpenRepository, onOpenSettings,
    onQueryChange, onRunCommand, onSwitchBranch, onToggleTerminal, projectOpen
  ])

  const recentFileActions = useMemo<PaletteAction[]>(() => {
    if (onOpenFile == null) return []
    return (recentFiles ?? []).slice(0, MAX_RECENT_FILES).map((path) => ({
      id: `recent:${path}`,
      group: 'Files' as const,
      title: fileNameFromPath(path),
      subtitle: path,
      icon: IconFileCode,
      run: () => {
        onQueryChange?.('')
        onClose()
        onOpenFile(path)
      }
    }))
  }, [onClose, onOpenFile, onQueryChange, recentFiles])

  const searchFileActions = useMemo<PaletteAction[]>(() => {
    if (onOpenFile == null) return []
    return (fileResults ?? []).slice(0, MAX_SEARCH_FILES).map((path) => ({
      id: `file:${path}`,
      group: 'Files' as const,
      title: fileNameFromPath(path),
      subtitle: path,
      icon: IconFileCode,
      run: () => {
        onQueryChange?.('')
        onClose()
        onOpenFile(path)
      }
    }))
  }, [fileResults, onClose, onOpenFile, onQueryChange])

  const contentActions = useMemo<PaletteAction[]>(() => {
    if (onOpenFile == null) return []
    return (contentResults ?? []).slice(0, MAX_CONTENT_RESULTS).map((result, index) => ({
      id: `content:${result.path}:${result.line}:${result.column}:${index}`,
      group: 'Content' as const,
      title: fileNameFromPath(result.path),
      subtitle: `${result.path}:${result.line}:${result.column}`,
      icon: IconFileCode,
      preview: result.preview,
      previewPath: result.path,
      run: () => {
        onQueryChange?.('')
        onClose()
        onOpenFile(result.path)
      }
    }))
  }, [contentResults, onClose, onOpenFile, onQueryChange])

  const results = useMemo<PaletteAction[]>(() => {
    if (selector != null) return []
    if (commandOnly) {
      return rankPaletteEntries(commandActions, filterQuery, MAX_RESULTS) as PaletteAction[]
    }
    if (filterQuery.trim() === '') {
      return rankPaletteEntries(
        [...commandActions, ...recentFileActions],
        '',
        MAX_RESULTS
      ) as PaletteAction[]
    }
    const matched = rankPaletteEntries(commandActions, filterQuery, MAX_RESULTS) as PaletteAction[]
    return [...searchFileActions, ...contentActions, ...matched].slice(0, MAX_RESULTS)
  }, [
    commandActions, commandOnly, contentActions, filterQuery, recentFileActions,
    searchFileActions, selector
  ])

  const groups = useMemo(() => groupPaletteEntries(results), [results])
  const clampedIndex = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1)
  const activeAction = results[clampedIndex]

  useLayoutEffect(() => {
    if (!scrollActiveRowRef.current) return
    scrollActiveRowRef.current = false
    rowRefs.current[clampedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex])

  const moveActive = (direction: 1 | -1): void => {
    scrollActiveRowRef.current = true
    setActiveIndex(nextPaletteIndex(clampedIndex, direction, results.length))
  }

  const displayPullRequest = (): void => {
    if (!gitRepositoryOpen || selector == null) return
    onQueryChange?.('')
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

  const updateQuery = (next: string): void => {
    setQuery(next)
    setActiveIndex(0)
    onQueryChange?.(searchQueryForRepository(next))
  }

  let rowIndex = -1

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-layer"
      aria-labelledby="command-palette-title"
      onCancel={(event) => {
        event.preventDefault()
        onQueryChange?.('')
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
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              moveActive(event.key === 'ArrowDown' ? 1 : -1)
            }}
            placeholder="Search files, commands, or a pull request"
            spellCheck={false}
            autoCapitalize="none"
          />
          {searchingContent ? <IconRefresh className="spin search-spinner" aria-hidden="true" /> : null}
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
              <strong>No matching files or commands</strong>
              <span>Try a file name, a command, &gt; for commands only, a PR number such as #123, or a GitHub pull request URL.</span>
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
                    ref={(node) => { rowRefs.current[index] = node }}
                    type="button"
                    className={[
                      action.id === activeAction?.id ? 'primary-result' : '',
                      action.preview != null ? 'palette-content' : ''
                    ].filter(Boolean).join(' ') || undefined}
                    disabled={action.disabledReason != null}
                    onPointerEnter={() => setActiveIndex(index)}
                    onClick={action.run}
                  >
                    <span className="command-icon"><action.icon /></span>
                    <span>
                      <strong>{action.title}</strong>
                      <small>{action.disabledReason ?? action.subtitle}</small>
                      {action.preview != null && action.previewPath != null ? (
                        <code className="palette-content-preview">
                          <SearchPreview path={action.previewPath} preview={action.preview} query={filterQuery} />
                        </code>
                      ) : null}
                    </span>
                    {action.keybinding == null ? null : <kbd>{action.keybinding}</kbd>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <footer>
          <span><kbd>↑↓</kbd> Select</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>&gt;</kbd> Commands</span>
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
    const onQueryChangeRef = useRef(props.onQueryChange)
    useLayoutEffect(() => {
      onQueryChangeRef.current = props.onQueryChange
    })

    const setVisibility = (visible: boolean): void => {
      if (visible && !openRef.current) {
        focusReturnRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      }
      openRef.current = visible
      setOpen(visible)
      if (!visible) {
        onQueryChangeRef.current?.('')
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
      open: () => setVisibility(true),
      toggle: () => setVisibility(!openRef.current)
    }), [])

    return open ? <CommandPalette {...props} onClose={() => setVisibility(false)} /> : null
  }
))
