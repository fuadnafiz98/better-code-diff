import { memo, useEffect, useState } from 'react'
import {
  IconArrowLeftBar,
  IconBraces,
  IconBranch,
  IconCollapsedRow,
  IconCheck,
  IconClockArrow,
  IconDiffSplit,
  IconDiffUnified,
  IconFileCode,
  IconEye,
  IconFolder,
  IconGear,
  IconPencil,
  IconRefresh,
  IconRepeat,
  IconSearch,
  IconSidebarLeftOpen,
  IconSparkles,
  IconTerminalFill,
  IconTypeWord,
  IconWarningOctogonFill,
  IconX
} from '@pierre/icons'

import type {
  FileComparison,
  RepositorySnapshot
} from '../../shared/contracts'
import { isMarkdownPath } from '../../shared/markdownPreview'
import type { DocumentView } from './documentView'
import type { RecentFolder } from './recentFolders'
import { FolderPicker } from './FolderPicker'
import { preloadFolderCatalog } from './folderPickerModel'
import { PerformanceHud } from './PerformanceHud'
import { formatEditorShortcut } from './editor/editorKeymap'
import { formatKeybinding, formatTerminalToggleShortcut, type KeybindingMap } from './keybindings'

const UNDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+z')
const REDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+shift+z')
const SAVE_SHORTCUT = formatEditorShortcut('cmdOrCtrl+s')

export type DiffStyle = 'split' | 'unified'
export type WorkspaceView = 'file' | 'multi'

interface ShortcutHintProps {
  keys: string
  label: string
}

function ShortcutHint({ keys, label }: ShortcutHintProps): React.JSX.Element {
  return <kbd className="shortcut-hint" aria-label={label}>{keys}</kbd>
}

interface TitlebarProps {
  snapshot: RepositorySnapshot | null
  keybindings: KeybindingMap
  newTab: boolean
  locator: string
  locatorBusy: boolean
  onLocatorChange(locator: string): void
  onLocatorSubmit(): void
  onSearchOpen(): void
  onSettingsOpen(): void
  onGitOpen(): void
  agentOpen: boolean
  onAgentToggle(): void
  terminalOpen: boolean
  onTerminalToggle(): void
}

export const Titlebar = memo(function Titlebar({
  snapshot,
  keybindings,
  newTab,
  locator,
  locatorBusy,
  onLocatorChange,
  onLocatorSubmit,
  onSearchOpen,
  onSettingsOpen,
  onGitOpen,
  agentOpen,
  onAgentToggle,
  terminalOpen,
  onTerminalToggle
}: TitlebarProps): React.JSX.Element {
  return (
    <div className="titlebar">
      <div className="titlebar-find">
        {newTab ? (
          <div className="global-search">
            <IconSearch aria-hidden="true" />
            <input
              name="review-locator"
              value={locator}
              onChange={(event) => onLocatorChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                onLocatorSubmit()
              }}
              placeholder="Enter a GitHub pull request URL"
              aria-label="Open pull request URL"
              disabled={locatorBusy}
            />
            {locatorBusy ? <IconRefresh className="spin search-spinner" /> : null}
            {locator !== '' ? (
              <button className="clear-search" type="button" onClick={() => onLocatorChange('')}>
                <IconX /><span className="sr-only">Clear pull request URL</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="titlebar-trailing">
        {snapshot != null ? (
          <div className="titlebar-status">
            <PerformanceHud />
          </div>
        ) : null}
        <div className="titlebar-actions">
          <div className="titlebar-action-cluster">
            {newTab ? null : (
              <button
                className="icon-button"
                type="button"
                onClick={onSearchOpen}
                aria-label="Search files and commands"
                title={`Search files and commands (${formatKeybinding(keybindings.goToFile)})`}
              >
                <IconSearch />
              </button>
            )}
            {snapshot?.kind === 'git' ? (
              <button className="icon-button" type="button" onClick={onGitOpen} aria-label="Open branches and pull requests" title="Branches and pull requests">
                <IconBranch />
              </button>
            ) : null}
            <button className="icon-button" type="button" onClick={onSettingsOpen} aria-label="Open settings" title="Settings">
              <IconGear />
            </button>
            {snapshot != null ? (
              <>
                <button
                  className={`icon-button terminal-titlebar-button ${terminalOpen ? 'active' : ''}`}
                  type="button"
                  aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
                  aria-pressed={terminalOpen}
                  title={`Toggle Terminal (${formatTerminalToggleShortcut()})`}
                  onClick={onTerminalToggle}
                >
                  <IconTerminalFill />
                </button>
                <button
                  className={`icon-button agent-titlebar-button ${agentOpen ? 'active' : ''}`}
                  type="button"
                  aria-label={agentOpen ? 'Close agent' : 'Ask agent'}
                  aria-pressed={agentOpen}
                  title={agentOpen ? 'Close Agent' : 'Ask Agent'}
                  onClick={onAgentToggle}
                >
                  <IconSparkles />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})

export function ErrorBanner({ message, onDismiss, closing }: {
  message: string
  onDismiss(): void
  closing?: boolean
}): React.JSX.Element {
  return (
    <div className="error-banner" role="alert" data-state={closing === true ? 'closing' : undefined}>
      <IconWarningOctogonFill />
      <span>{message}</span>
      <button type="button" onClick={onDismiss}><IconX /><span className="sr-only">Dismiss</span></button>
    </div>
  )
}

// The staged entrance runs once per app session, not on every return from Settings.
let welcomeEntranceShown = false

interface WelcomeProps {
  opening: boolean
  openingRecentPath: string | null
  recentFolders: readonly RecentFolder[]
  keybindings: KeybindingMap
  onOpen(): Promise<void>
  onOpenPickedFolder(path: string): void
  onRecentOpen(folder: RecentFolder): Promise<void>
  onRecentRemove(path: string): void
}

export function Welcome({
  onOpen,
  onOpenPickedFolder,
  opening,
  openingRecentPath,
  recentFolders,
  keybindings,
  onRecentOpen,
  onRecentRemove
}: WelcomeProps): React.JSX.Element {
  const [animateEntrance] = useState(() => !welcomeEntranceShown)
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    welcomeEntranceShown = true
  }, [])
  return (
    <section className="welcome" data-entrance={animateEntrance ? 'run' : 'off'}>
      <div className="welcome-layout">
        <header className="welcome-intro">
          <div className="welcome-identity"><IconBraces /><span>Horus</span></div>
          <h1>Your project tree,<br />built for review.</h1>
          <p className="welcome-copy">
            Open any folder. Select a file to read it, or compare its working copy with HEAD when Git is available.
          </p>
          <div className="folder-picker-host welcome-open-host">
            <button
              className="welcome-open"
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              onMouseEnter={preloadFolderCatalog}
              onFocus={preloadFolderCatalog}
              disabled={opening}
              aria-expanded={pickerOpen}
              aria-haspopup="dialog"
            >
              {opening ? <IconRefresh className="spin" /> : <IconFolder />}
              Open Folder
            </button>
            {pickerOpen ? (
              <FolderPicker
                recentFolders={recentFolders}
                openingPath={openingRecentPath}
                onClose={() => setPickerOpen(false)}
                onSelect={(path) => {
                  setPickerOpen(false)
                  onOpenPickedFolder(path)
                }}
                onUseExisting={() => {
                  setPickerOpen(false)
                  void onOpen()
                }}
              />
            ) : null}
          </div>
          <div className="shortcut-list" aria-label="Keyboard shortcuts">
            <span>Open folder</span><ShortcutHint keys={formatKeybinding(keybindings.openFolder)} label="Open folder shortcut" />
            <span>Go to file</span><ShortcutHint keys={formatKeybinding(keybindings.goToFile)} label="Go to file shortcut" />
            <span>Search contents</span><ShortcutHint keys={formatKeybinding(keybindings.searchContent)} label="Search contents shortcut" />
          </div>
        </header>

        <section className="recent-folders" aria-labelledby="recent-folders-title">
          <div className="recent-folders-heading">
            <strong id="recent-folders-title">Recent folders</strong>
            {recentFolders.length > 0 ? <span>{recentFolders.length}</span> : null}
          </div>
          {recentFolders.length > 0 ? (
            <div className="recent-folders-list">
              {recentFolders.map((folder) => (
                <div className="recent-folder" key={folder.path}>
                  <button className="recent-folder-open" type="button" title={folder.path} onClick={() => void onRecentOpen(folder)} disabled={openingRecentPath != null}>
                    {openingRecentPath === folder.path ? <IconRefresh className="spin" /> : <IconFolder />}
                    <span><strong>{folder.name}</strong><small>{folder.path}</small></span>
                  </button>
                  <button className="recent-folder-remove" type="button" onClick={() => onRecentRemove(folder.path)} aria-label={`Remove ${folder.name} from recent folders`} title="Remove from recent folders">
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="recent-folders-empty">
              <IconFolder />
              <div><strong>No recent folders</strong><span>Folders you open will appear here.</span></div>
            </div>
          )}
        </section>
      </div>
      <footer className="welcome-footer"><span>Git is optional</span><span>Local files only</span></footer>
    </section>
  )
}

export interface FileEditControls {
  available: boolean
  /** Why the Edit button is disabled: binary, oversized, or a review is open. */
  unavailableReason: string | null
  startLabel: 'Edit' | 'Resume draft'
  mode: 'read' | 'edit' | 'preview'
  documentView: DocumentView
  dirty: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  unsavedPaths: readonly string[]
  onStart(): void
  onModeChange(mode: 'edit' | 'preview'): void
  onDocumentViewChange(view: DocumentView): void
  onUndo(): void
  onRedo(): void
  onCancel(): void
  onRevert(): void
  onSave(): void
  onOpenPath(path: string): void
}

interface DiffToolbarProps {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  reviewTitle?: string
  reviewComparison?: string
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  onCloseExternalReview?(): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  sidebarVisible?: boolean
  onSidebarToggle?(): void
  sidebarShortcut?: string
}

function FilePathBreadcrumbs({ path }: { path: string }): React.JSX.Element {
  const segments = path.split('/')
  return (
    <nav className="editor-breadcrumbs" aria-label="File path">
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`}>
          {index > 0 ? <span className="breadcrumb-separator" aria-hidden="true">›</span> : null}
          <span>{segment}</span>
        </span>
      ))}
    </nav>
  )
}

function formatStatus(status: FileComparison['status']): string {
  switch (status) {
    case 'added': return 'Added'
    case 'conflicted': return 'Conflicted'
    case 'deleted': return 'Deleted'
    case 'modified': return 'Modified'
    case 'renamed': return 'Renamed'
    case 'untracked': return 'Untracked'
    default: return 'No changes'
  }
}

function UnsavedDraftsPill({ fileEdit, currentPath }: {
  fileEdit: FileEditControls
  currentPath: string | null
}): React.JSX.Element | null {
  const others = fileEdit.unsavedPaths.filter((path) => path !== currentPath)
  const first = others[0]
  if (first == null) return null
  return (
    <button type="button" className="file-edit-state dirty"
      title={`Unsaved drafts:\n${others.join('\n')}`}
      onClick={() => fileEdit.onOpenPath(first)}>
      {others.length} unsaved
    </button>
  )
}

export function DiffToolbar({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  reviewTitle,
  reviewComparison,
  wordWrap,
  foldUnchanged,
  fileEdit,
  onCloseExternalReview,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  sidebarVisible = true,
  onSidebarToggle,
  sidebarShortcut
}: DiffToolbarProps): React.JSX.Element {
  const displayName = workspaceView === 'multi'
    ? reviewTitle ?? 'Repository review'
    : isFilePreview
      ? selectedPath?.split('/').at(-1)
      : selectedPath
  const showDiffLayout = isGitRepository && (workspaceView === 'multi' || !isFilePreview)
  const showEditStart = (fileEdit.available && fileEdit.mode === 'read')
    || (!fileEdit.available && fileEdit.unavailableReason != null && workspaceView === 'file')
  const markdownPath = selectedPath != null && isMarkdownPath(selectedPath)
  const showMarkdownViewToggle = markdownPath && workspaceView === 'file' && fileEdit.mode === 'read'
  const markdownPreviewOnly = markdownPath && (
    fileEdit.mode === 'preview'
    || (fileEdit.mode === 'read' && fileEdit.documentView === 'preview')
  )

  return (
    <div className="diff-toolbar">
      {onSidebarToggle != null && !sidebarVisible ? (
        <button
          className="icon-button"
          type="button"
          aria-label="Show explorer"
          title={sidebarShortcut == null ? 'Show Explorer' : `Show Explorer (${sidebarShortcut})`}
          onClick={onSidebarToggle}
        >
          <IconSidebarLeftOpen />
        </button>
      ) : null}
      {/* Leaving a pull request belongs beside its title, not in the group of view
          toggles on the right where it read as another display mode. */}
      {onCloseExternalReview != null ? (
        <button className="review-exit-button" type="button" onClick={onCloseExternalReview}
          title="Close this review and go back to the working tree">
          <IconArrowLeftBar />Working tree
        </button>
      ) : null}
      <div className="diff-toolbar-context">
        {isFilePreview && selectedPath != null ? (
          <FilePathBreadcrumbs path={selectedPath} />
        ) : (
          <div className="diff-file-title" title={selectedPath ?? undefined}>
            <IconFileCode />
            <span>{displayName ?? 'Select a file'}</span>
            {workspaceView === 'file' && comparison != null && comparison.status !== 'unchanged' ? (
              <span className={`status-pill status-${comparison.status}`}>{formatStatus(comparison.status)}</span>
            ) : null}
          </div>
        )}
        <span className="comparison-label">
          {workspaceView === 'multi'
            ? reviewComparison ?? `${reviewFileCount} ${isGitRepository ? 'changed' : 'project'} files`
            : isGitRepository ? 'HEAD → Working Tree' : 'Read-only preview'}
        </span>
      </div>
      <div className="diff-controls">
        {fileEdit.available && fileEdit.mode !== 'read' ? (
          <div className="file-edit-actions" role="group" aria-label="File editing">
            <span className={`file-edit-state ${fileEdit.dirty ? 'dirty' : ''}`} role="status">
              {fileEdit.dirty ? 'Unsaved' : 'Saved'}
            </span>
            <UnsavedDraftsPill fileEdit={fileEdit} currentPath={selectedPath} />
            <div className="editor-option-controls file-history-controls" role="group" aria-label="Edit history">
              <button type="button" aria-label={`Undo (${UNDO_SHORTCUT})`}
                title={`Undo (${UNDO_SHORTCUT})`}
                disabled={!fileEdit.canUndo || fileEdit.saving} onClick={fileEdit.onUndo}>
                <IconClockArrow />
              </button>
              <button type="button" aria-label={`Redo (${REDO_SHORTCUT})`}
                title={`Redo (${REDO_SHORTCUT})`}
                disabled={!fileEdit.canRedo || fileEdit.saving} onClick={fileEdit.onRedo}>
                <IconRepeat />
              </button>
            </div>
            <div className="segmented-control file-edit-mode" role="group" aria-label="Draft view">
              <button type="button" aria-pressed={fileEdit.mode === 'edit'}
                className={fileEdit.mode === 'edit' ? 'active' : undefined}
                title="Edit" onClick={() => fileEdit.onModeChange('edit')} disabled={fileEdit.saving}>
                <IconPencil /><span>Edit</span>
              </button>
              <button type="button" aria-pressed={fileEdit.mode === 'preview'}
                className={fileEdit.mode === 'preview' ? 'active' : undefined}
                title="Preview" onClick={() => fileEdit.onModeChange('preview')} disabled={fileEdit.saving}>
                <IconEye /><span>Preview</span>
              </button>
            </div>
            <button className="file-edit-cancel" type="button" onClick={fileEdit.onRevert}
              disabled={!fileEdit.dirty || fileEdit.saving}
              title="Discard this draft and go back to the file on disk (undoable with ⌘Z)">
              <IconClockArrow /><span>Revert</span>
            </button>
            <button className="file-edit-cancel" type="button" onClick={fileEdit.onCancel} disabled={fileEdit.saving}
              title="Leave edit mode. An unsaved draft is kept and can be resumed.">
              <IconX /><span>Close</span>
            </button>
            <button className="file-edit-save" type="button" onClick={fileEdit.onSave}
              aria-keyshortcuts="Meta+S Control+S"
              aria-label={`Save (${SAVE_SHORTCUT})`}
              title={`Save (${SAVE_SHORTCUT})`}
              disabled={!fileEdit.dirty || fileEdit.saving}>
              <span className="icon-swap" data-state={fileEdit.saving ? 'alt' : 'base'} aria-hidden="true">
                <IconCheck /><IconRefresh className="spin" />
              </span>
              <span className="file-edit-save-label" aria-hidden="true">{fileEdit.saving ? 'Saving' : 'Save'}</span>
              {fileEdit.saving ? null : (
                <kbd className="shortcut-hint" aria-hidden="true">{SAVE_SHORTCUT}</kbd>
              )}
            </button>
          </div>
        ) : null}
        <div className="diff-display-controls">
          {!fileEdit.available && fileEdit.unavailableReason != null && workspaceView === 'file' ? (
            <button className="file-edit-start" type="button" disabled
              title={fileEdit.unavailableReason} aria-describedby="file-edit-unavailable">
              <IconPencil /><span>Edit</span>
              <span id="file-edit-unavailable" hidden>{fileEdit.unavailableReason}</span>
            </button>
          ) : null}
          {fileEdit.available && fileEdit.mode === 'read' ? (
            <button className="file-edit-start" type="button" onClick={fileEdit.onStart}>
              <IconPencil /><span>{fileEdit.startLabel}</span>
            </button>
          ) : null}
          {showEditStart && (showMarkdownViewToggle || !markdownPreviewOnly || showDiffLayout)
            ? <span className="diff-control-divider" aria-hidden="true" />
            : null}
          {showMarkdownViewToggle || !markdownPreviewOnly || showDiffLayout ? (
          <div className="editor-option-controls" role="group" aria-label="Editor display options">
            {showMarkdownViewToggle ? (
              <div className="markdown-view-toggle" role="group" aria-label="Markdown view">
                <button type="button" aria-label="Source" data-tooltip="Source"
                  aria-pressed={fileEdit.documentView === 'source'}
                  className={fileEdit.documentView === 'source' ? 'active' : undefined}
                  onClick={() => fileEdit.onDocumentViewChange('source')}>
                  <IconFileCode />
                </button>
                <button type="button" aria-label="Both" data-tooltip="Source and preview"
                  aria-pressed={fileEdit.documentView === 'split'}
                  className={fileEdit.documentView === 'split' ? 'active' : undefined}
                  onClick={() => fileEdit.onDocumentViewChange('split')}>
                  <IconDiffSplit />
                </button>
                <button type="button" aria-label="Preview" data-tooltip="Preview"
                  aria-pressed={fileEdit.documentView === 'preview'}
                  className={fileEdit.documentView === 'preview' ? 'active' : undefined}
                  onClick={() => fileEdit.onDocumentViewChange('preview')}>
                  <IconEye />
                </button>
              </div>
            ) : null}
            {markdownPreviewOnly ? null : (
              <button type="button" aria-label="Toggle word wrap" aria-pressed={wordWrap}
                data-tooltip="Word wrap" className={wordWrap ? 'active' : undefined} onClick={onWordWrapToggle}>
                <IconTypeWord />
              </button>
            )}
            {showDiffLayout ? (
              <button type="button" aria-label="Toggle unchanged context folding" aria-pressed={foldUnchanged}
                data-tooltip="Context folding" className={foldUnchanged ? 'active' : undefined} onClick={onFoldUnchangedToggle}>
                <IconCollapsedRow />
              </button>
            ) : null}
          </div>
          ) : null}
          {showDiffLayout ? (
            <>
              <span className="diff-control-divider" aria-hidden="true" />
              <div className="segmented-control diff-layout-control" role="group" aria-label="Diff layout">
                <button type="button" aria-label="Split diff" aria-pressed={diffStyle === 'split'}
                  data-tooltip="Split view" className={diffStyle === 'split' ? 'active' : undefined} onClick={() => onDiffStyleChange('split')}>
                  <IconDiffSplit />
                </button>
                <button type="button" aria-label="Unified diff" aria-pressed={diffStyle === 'unified'}
                  data-tooltip="Unified view" className={diffStyle === 'unified' ? 'active' : undefined} onClick={() => onDiffStyleChange('unified')}>
                  <IconDiffUnified />
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
