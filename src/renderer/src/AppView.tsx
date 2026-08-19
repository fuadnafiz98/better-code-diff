import { memo, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  IconBraces,
  IconBranch,
  IconCodeFolder,
  IconCollapsedRow,
  IconDiffSplit,
  IconDiffUnified,
  IconFileCode,
  IconFiles,
  IconFolder,
  IconGear,
  IconRefresh,
  IconSearch,
  IconSidebarLeft,
  IconSidebarLeftOpen,
  IconSparkles,
  IconTypeWord,
  IconWarningOctogonFill,
  IconX
} from '@pierre/icons'

import type {
  ContentSearchResult,
  FileComparison,
  RepositorySnapshot
} from '../../shared/contracts'
import type { RecentFolder } from './recentFolders'
import { PerformanceHud } from './PerformanceHud'
import { formatKeybinding, type KeybindingMap } from './keybindings'
import { tokenizeSearchPreview } from './searchPreview'

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
  sidebarVisible: boolean
  searchQuery: string
  searchInputRef: RefObject<HTMLInputElement | null>
  searchingContent: boolean
  opening: boolean
  keybindings: KeybindingMap
  activeSearchResultId?: string
  onSidebarToggle(): void
  onSearchQueryChange(query: string): void
  onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void
  onOpen(): Promise<void>
  onSettingsOpen(): void
  onGitOpen(): void
  onBranchesOpen(): void
  agentOpen: boolean
  onAgentToggle(): void
}

export const Titlebar = memo(function Titlebar({
  snapshot,
  sidebarVisible,
  searchQuery,
  searchInputRef,
  searchingContent,
  opening,
  keybindings,
  activeSearchResultId,
  onSidebarToggle,
  onSearchQueryChange,
  onSearchKeyDown,
  onOpen,
  onSettingsOpen,
  onGitOpen,
  onBranchesOpen,
  agentOpen,
  onAgentToggle
}: TitlebarProps): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-repository">
        {snapshot == null ? (
          <span className="product-name"><IconBraces />Horus</span>
        ) : (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label={sidebarVisible ? 'Hide explorer' : 'Show explorer'}
              title={sidebarVisible ? 'Hide Explorer' : 'Show Explorer'}
              onClick={onSidebarToggle}
            >
              <span className="icon-swap sidebar-icon-swap" data-state={sidebarVisible ? 'base' : 'alt'}>
                <IconSidebarLeft /><IconSidebarLeftOpen />
              </span>
            </button>
            <button
              className="open-button titlebar-open-button"
              type="button"
              onClick={() => void onOpen()}
              disabled={opening}
              title={`Open Folder (${formatKeybinding(keybindings.openFolder)})`}
            >
              {opening ? <IconRefresh className="spin" /> : <IconFolder />}
              <span>Open</span>
            </button>
            <IconCodeFolder className="repository-icon" />
            <strong>{snapshot.name}</strong>
            {snapshot.kind === 'git' ? (
              <button
                className="titlebar-branch-button"
                type="button"
                onClick={onBranchesOpen}
                aria-label={`Switch branch. Current branch: ${snapshot.branch ?? 'detached HEAD'}`}
                title="Switch branch"
              >
                <IconBranch />
                <span>{snapshot.branch ?? 'Detached HEAD'}</span>
              </button>
            ) : (
              <span className="branch-label" title="Folder">
                <IconFolder />
                Folder
              </span>
            )}
          </>
        )}
      </div>

      <div className="global-search">
        <IconSearch aria-hidden="true" />
        <input
          name="repository-search"
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search files and content"
          aria-label="Search repository files and content"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="repository-search-results"
          aria-activedescendant={activeSearchResultId}
          aria-expanded={searchQuery.trim().length > 0}
          disabled={snapshot == null}
        />
        {searchingContent ? <IconRefresh className="spin search-spinner" /> : null}
        {searchQuery !== '' ? (
          <button className="clear-search" type="button" onClick={() => onSearchQueryChange('')}>
            <IconX /><span className="sr-only">Clear search</span>
          </button>
        ) : (
          <ShortcutHint keys={formatKeybinding(keybindings.goToFile)} label="Search repository shortcut" />
        )}
      </div>

      <div className="titlebar-actions">
        {snapshot != null ? (
          <>
            <PerformanceHud />
            {snapshot.kind === 'git' ? (
              <button className="icon-button" type="button" onClick={onGitOpen} aria-label="Open branches and pull requests" title="Branches and pull requests">
                <IconBranch />
              </button>
            ) : null}
          </>
        ) : null}
        <button className="icon-button" type="button" onClick={onSettingsOpen} aria-label="Open settings" title="Settings">
          <IconGear />
        </button>
        {snapshot != null ? (
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
        ) : null}
      </div>
    </header>
  )
})

interface SearchResultsProps {
  query: string
  fileResults: string[]
  contentResults: ContentSearchResult[]
  searchingContent: boolean
  activeIndex: number
  onSelect(path: string): void
  onActiveIndexChange(index: number): void
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

export function SearchResults({
  query,
  fileResults,
  contentResults,
  searchingContent,
  activeIndex,
  onSelect,
  onActiveIndexChange
}: SearchResultsProps): React.JSX.Element {
  const hasResults = fileResults.length > 0 || contentResults.length > 0
  const resultsListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    resultsListRef.current
      ?.querySelector<HTMLElement>(`[data-search-result-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className="search-popover" id="repository-search-results">
      <div className="search-popover-heading">
        <IconSearch />
        <span>Files and content</span>
        <span className="search-query-label">“{query}”</span>
      </div>
      <div ref={resultsListRef} className="search-results-list" role="listbox" aria-label="Repository search results">
        {fileResults.length > 0 ? <div className="search-result-group-heading">
          <span>Files</span><span>{fileResults.length}</span>
        </div> : null}
        {fileResults.map((path, resultIndex) => (
          <button
            id={`repository-search-result-${resultIndex}`}
            data-search-result-index={resultIndex}
            key={path}
            type="button"
            role="option"
            aria-selected={activeIndex === resultIndex}
            onMouseEnter={() => onActiveIndexChange(resultIndex)}
            onClick={() => onSelect(path)}
          >
            <IconFileCode />
            <span>{path}</span>
          </button>
        ))}
        {contentResults.length > 0 || searchingContent ? <div className="search-result-group-heading">
          <span>Content</span>
          <span>{searchingContent ? 'Searching…' : contentResults.length}</span>
        </div> : null}
        {contentResults.map((result, resultIndex) => (
          <button
            id={`repository-search-result-${fileResults.length + resultIndex}`}
            data-search-result-index={fileResults.length + resultIndex}
            key={`${result.path}:${result.line}:${result.column}:${resultIndex}`}
            type="button"
            role="option"
            aria-selected={activeIndex === fileResults.length + resultIndex}
            className="content-result"
            onMouseEnter={() => onActiveIndexChange(fileResults.length + resultIndex)}
            onClick={() => onSelect(result.path)}
          >
            <div><IconFileCode /><strong>{result.path}</strong><span>:{result.line}:{result.column}</span></div>
            <code><SearchPreview path={result.path} preview={result.preview} query={query} /></code>
          </button>
        ))}
        {!hasResults && !searchingContent ? <div className="no-search-results">No matches</div> : null}
        <span className="sr-only" aria-live="polite">
          {searchingContent ? 'Searching repository content' : `${fileResults.length + contentResults.length} results`}
        </span>
      </div>
    </div>
  )
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss(): void }): React.JSX.Element {
  return (
    <div className="error-banner" role="alert">
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
  onRecentOpen(folder: RecentFolder): Promise<void>
  onRecentRemove(path: string): void
}

export function Welcome({
  onOpen,
  opening,
  openingRecentPath,
  recentFolders,
  keybindings,
  onRecentOpen,
  onRecentRemove
}: WelcomeProps): React.JSX.Element {
  const [animateEntrance] = useState(() => !welcomeEntranceShown)
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
          <button className="welcome-open" type="button" onClick={() => void onOpen()} disabled={opening}>
            {opening ? <IconRefresh className="spin" /> : <IconFolder />}
            Open Folder
          </button>
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
  onCloseExternalReview?(): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
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
  onCloseExternalReview,
  onDiffStyleChange,
  onWorkspaceViewChange,
  onWordWrapToggle,
  onFoldUnchangedToggle
}: DiffToolbarProps): React.JSX.Element {
  const displayName = workspaceView === 'multi'
    ? reviewTitle ?? 'Repository review'
    : isFilePreview
      ? selectedPath?.split('/').at(-1)
      : selectedPath

  return (
    <div className="diff-toolbar">
      <div className="diff-toolbar-context">
        <div className="diff-file-title" title={selectedPath ?? undefined}>
          <IconFileCode />
          <span>{displayName ?? 'Select a file'}</span>
          {workspaceView === 'file' && comparison != null && comparison.status !== 'unchanged' ? (
            <span className={`status-pill status-${comparison.status}`}>{formatStatus(comparison.status)}</span>
          ) : null}
        </div>
        <span className="comparison-label">
          {workspaceView === 'multi'
            ? reviewComparison ?? `${reviewFileCount} ${isGitRepository ? 'changed' : 'project'} files`
            : isGitRepository ? 'HEAD → Working Tree' : 'Read-only preview'}
        </span>
      </div>
      <div className="diff-controls">
        <div className="editor-option-controls" role="group" aria-label="Editor display options">
          <button type="button" aria-label="Toggle word wrap" aria-pressed={wordWrap} className={wordWrap ? 'active' : undefined} onClick={onWordWrapToggle} title="Toggle word wrap">
            <IconTypeWord />
          </button>
          {isGitRepository && (workspaceView === 'multi' || !isFilePreview) ? (
            <button type="button" aria-label="Toggle unchanged context folding" aria-pressed={foldUnchanged} className={foldUnchanged ? 'active' : undefined} onClick={onFoldUnchangedToggle} title="Toggle unchanged context folding">
              <IconCollapsedRow />
            </button>
          ) : null}
        </div>
        {onCloseExternalReview != null ? (
          <button className="review-return-button" type="button" onClick={onCloseExternalReview}><IconBranch />Working Tree</button>
        ) : null}
        {onCloseExternalReview == null ? (
          <div className="segmented-control workspace-view-control" role="group" aria-label="Review view">
            <button type="button" aria-pressed={workspaceView === 'file'} className={workspaceView === 'file' ? 'active' : undefined} onClick={() => onWorkspaceViewChange('file')}>
              <IconFileCode />File
            </button>
            <button type="button" aria-pressed={workspaceView === 'multi'} className={workspaceView === 'multi' ? 'active' : undefined} onClick={() => onWorkspaceViewChange('multi')}>
              <IconFiles />Multi-file
            </button>
          </div>
        ) : null}
        {isGitRepository && (workspaceView === 'multi' || !isFilePreview) ? (
          <div className="segmented-control" role="group" aria-label="Diff layout">
            <button type="button" aria-pressed={diffStyle === 'split'} className={diffStyle === 'split' ? 'active' : undefined} onClick={() => onDiffStyleChange('split')}>
              <IconDiffSplit />Split
            </button>
            <button type="button" aria-pressed={diffStyle === 'unified'} className={diffStyle === 'unified' ? 'active' : undefined} onClick={() => onDiffStyleChange('unified')}>
              <IconDiffUnified />Unified
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
