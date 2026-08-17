import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import {
  IconBranch,
  IconGear,
  IconInReview,
  IconSearch
} from '@pierre/icons'

import { formatKeybinding, type KeybindingMap } from './keybindings'
import { parsePullRequestSelector } from './pullRequestSelector'

interface CommandPaletteProps {
  gitRepositoryOpen: boolean
  keybindings: KeybindingMap
  onClose(): void
  onOpenPullRequest(selector: number | string): void
  onOpenRepository(): void
  onOpenSettings(): void
}

export interface CommandPaletteHandle {
  close(): boolean
  toggle(): void
}

type CommandPaletteControllerProps = Omit<CommandPaletteProps, 'onClose'>

function pullRequestNumber(selector: number | string): number {
  if (typeof selector === 'number') return selector
  const match = /\/pull\/(\d+)/i.exec(selector)
  return Number(match?.[1])
}

function CommandPalette({
  gitRepositoryOpen,
  keybindings,
  onClose,
  onOpenPullRequest,
  onOpenRepository,
  onOpenSettings
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const selector = parsePullRequestSelector(query)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const displayPullRequest = (): void => {
    if (!gitRepositoryOpen || selector == null) return
    onClose()
    onOpenPullRequest(selector)
  }

  return (
    <dialog className="command-palette-layer" open aria-labelledby="command-palette-title">
      <section className="command-palette">
        <form onSubmit={(event) => {
          event.preventDefault()
          displayPullRequest()
        }}>
          <IconSearch aria-hidden="true" />
          <label className="sr-only" id="command-palette-title" htmlFor="command-palette-input">Command palette</label>
          <input
            ref={inputRef}
            id="command-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
          ) : query.trim() !== '' ? (
            <div className="command-palette-empty">
              <strong>No matching command</strong>
              <span>Enter a PR number such as #123, or paste a GitHub pull request URL.</span>
            </div>
          ) : (
            <>
              <p>Quick actions</p>
              <button type="button" onClick={() => { onClose(); onOpenRepository() }} disabled={!gitRepositoryOpen}>
                <span className="command-icon"><IconBranch /></span>
                <span><strong>Open repository</strong><small>Branches, commits, remotes, and pull requests</small></span>
              </button>
              <button type="button" onClick={() => { onClose(); onOpenSettings() }}>
                <span className="command-icon"><IconGear /></span>
                <span><strong>Open settings</strong><small>Appearance, editor, and keybindings</small></span>
              </button>
            </>
          )}
        </div>

        <footer>
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

    const setVisibility = (visible: boolean): void => {
      openRef.current = visible
      setOpen(visible)
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
