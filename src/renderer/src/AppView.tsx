import type { RefObject } from 'react'
import {
  IconBraces,
  IconBranch,
  IconCodeFolder,
  IconCodeSearch,
  IconDiffSplit,
  IconDiffUnified,
  IconFileCode,
  IconFiles,
  IconFolder,
  IconGear,
  IconRefresh,
  IconReload,
  IconSearch,
  IconSidebarLeft,
  IconSidebarLeftOpen,
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

export type SearchMode = 'files' | 'content'
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
  searchMode: SearchMode
  searchQuery: string
  searchInputRef: RefObject<HTMLInputElement | null>
  searchingContent: boolean
  opening: boolean
  refreshing: boolean
  onSidebarToggle(): void
  onSearchModeChange(mode: SearchMode): void
  onSearchQueryChange(query: string): void
  onOpen(): Promise<void>
  onRefresh(): Promise<void>
  onSettingsOpen(): void
  onGitOpen(): void
}

export function Titlebar({
  snapshot,
  sidebarVisible,
  searchMode,
  searchQuery,
  searchInputRef,
  searchingContent,
  opening,
  refreshing,
  onSidebarToggle,
  onSearchModeChange,
  onSearchQueryChange,
  onOpen,
  onRefresh,
  onSettingsOpen,
  onGitOpen
}: TitlebarProps): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-repository">
        {snapshot == null ? (
          <span className="product-name"><IconBraces />Better Code Diff</span>
        ) : (
          <>
            <button
              className="icon-button"
              type="button"
              aria-label={sidebarVisible ? 'Hide explorer' : 'Show explorer'}
              title={sidebarVisible ? 'Hide Explorer' : 'Show Explorer'}
              onClick={onSidebarToggle}
            >
              {sidebarVisible ? <IconSidebarLeft /> : <IconSidebarLeftOpen />}
            </button>
            <IconCodeFolder className="repository-icon" />
            <strong>{snapshot.name}</strong>
            <span className="branch-label" title={snapshot.branch ?? 'Folder'}>
              {snapshot.kind === 'git' ? <IconBranch /> : <IconFolder />}
              {snapshot.branch ?? 'Folder'}
            </span>
          </>
        )}
      </div>

      <div className="global-search">
        <IconSearch aria-hidden="true" />
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder={searchMode === 'files' ? 'Go to file' : 'Search repository contents'}
          aria-label={searchMode === 'files' ? 'Search files' : 'Search file contents'}
          disabled={snapshot == null}
        />
        {searchingContent ? <IconRefresh className="spin search-spinner" /> : null}
        {searchQuery !== '' ? (
          <button className="clear-search" type="button" onClick={() => onSearchQueryChange('')}>
            <IconX /><span className="sr-only">Clear search</span>
          </button>
        ) : (
          searchMode === 'files'
            ? <ShortcutHint keys="⌘P" label="Command P" />
            : <ShortcutHint keys="⇧⌘F" label="Shift Command F" />
        )}
      </div>

      <div className="titlebar-actions">
        {snapshot != null ? (
          <>
            <div className="search-mode-switch" role="group" aria-label="Search mode">
              <button
                type="button"
                className={searchMode === 'files' ? 'active' : undefined}
                aria-pressed={searchMode === 'files'}
                onClick={() => onSearchModeChange('files')}
              >
                <IconFileCode />Files
              </button>
              <button
                type="button"
                className={searchMode === 'content' ? 'active' : undefined}
                aria-pressed={searchMode === 'content'}
                onClick={() => onSearchModeChange('content')}
              >
                <IconCodeSearch />Content
              </button>
            </div>
            <PerformanceHud />
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh repository"
              title="Refresh Repository"
              onClick={() => void onRefresh()}
              disabled={refreshing}
            >
              <IconReload className={refreshing ? 'spin' : undefined} />
            </button>
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
        <button className={`open-button ${snapshot == null ? 'open-button-secondary' : ''}`} type="button" onClick={() => void onOpen()} disabled={opening}>
          {opening ? <IconRefresh className="spin" /> : <IconFolder />}
          Open Folder
        </button>
      </div>
    </header>
  )
}

interface SearchResultsProps {
  mode: SearchMode
  query: string
  fileResults: string[]
  contentResults: ContentSearchResult[]
  onSelect(path: string): void
}

export function SearchResults({
  mode,
  query,
  fileResults,
  contentResults,
  onSelect
}: SearchResultsProps): React.JSX.Element {
  const hasResults = mode === 'files' ? fileResults.length > 0 : contentResults.length > 0
  return (
    <div className="search-popover">
      <div className="search-popover-heading">
        {mode === 'files' ? <IconFileCode /> : <IconCodeSearch />}
        <span>{mode === 'files' ? 'Files' : 'Content'}</span>
        <span className="search-query-label">“{query}”</span>
      </div>
      <div className="search-results-list">
        {mode === 'files'
          ? fileResults.map((path) => (
              <button key={path} type="button" onClick={() => onSelect(path)}>
                <IconFileCode />
                <span>{path}</span>
              </button>
            ))
          : contentResults.map((result, resultIndex) => (
              <button
                key={`${result.path}:${result.line}:${result.column}:${resultIndex}`}
                type="button"
                className="content-result"
                onClick={() => onSelect(result.path)}
              >
                <div><IconFileCode /><strong>{result.path}</strong><span>:{result.line}:{result.column}</span></div>
                <code>{result.preview}</code>
              </button>
            ))}
        {!hasResults ? <div className="no-search-results">No matches</div> : null}
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

interface WelcomeProps {
  opening: boolean
  openingRecentPath: string | null
  recentFolders: readonly RecentFolder[]
  onOpen(): Promise<void>
  onRecentOpen(folder: RecentFolder): Promise<void>
  onRecentRemove(path: string): void
}

export function Welcome({
  onOpen,
  opening,
  openingRecentPath,
  recentFolders,
  onRecentOpen,
  onRecentRemove
}: WelcomeProps): React.JSX.Element {
  return (
    <section className="welcome">
      <div className="welcome-layout">
        <header className="welcome-intro">
          <div className="welcome-identity"><IconBraces /><span>Better Code Diff</span></div>
          <h1>Your project tree,<br />built for review.</h1>
          <p className="welcome-copy">
            Open any folder. Select a file to read it, or compare its working copy with HEAD when Git is available.
          </p>
          <button className="welcome-open" type="button" onClick={() => void onOpen()} disabled={opening}>
            {opening ? <IconRefresh className="spin" /> : <IconFolder />}
            Open Folder
          </button>
          <div className="shortcut-list" aria-label="Keyboard shortcuts">
            <span>Open folder</span><ShortcutHint keys="⌘O" label="Command O" />
            <span>Go to file</span><ShortcutHint keys="⌘P" label="Command P" />
            <span>Search contents</span><ShortcutHint keys="⇧⌘F" label="Shift Command F" />
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
                  <button className="recent-folder-open" type="button" onClick={() => void onRecentOpen(folder)} disabled={openingRecentPath != null}>
                    {openingRecentPath === folder.path ? <IconRefresh className="spin" /> : <IconFolder />}
                    <span><strong>{folder.name}</strong><small>{folder.path}</small></span>
                  </button>
                  <button className="recent-folder-remove" type="button" onClick={() => onRecentRemove(folder.path)} aria-label={`Remove ${folder.name} from recent folders`}>
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
  onCloseExternalReview?(): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
}

function formatStatus(status: FileComparison['status']): string {
  switch (status) {
    case 'added': return 'Added'
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
  onCloseExternalReview,
  onDiffStyleChange,
  onWorkspaceViewChange
}: DiffToolbarProps): React.JSX.Element {
  const displayName = workspaceView === 'multi'
    ? reviewTitle ?? 'Repository review'
    : isFilePreview
      ? selectedPath?.split('/').at(-1)
      : selectedPath

  return (
    <div className="diff-toolbar">
      <div className="diff-file-title" title={selectedPath ?? undefined}>
        <IconFileCode />
        <span>{displayName ?? 'Select a file'}</span>
        {workspaceView === 'file' && comparison != null && comparison.status !== 'unchanged' ? (
          <span className={`status-pill status-${comparison.status}`}>{formatStatus(comparison.status)}</span>
        ) : null}
      </div>
      <div className="diff-controls">
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
        <span className="comparison-label">
          {workspaceView === 'multi'
            ? reviewComparison ?? `${reviewFileCount} ${isGitRepository ? 'changed' : 'project'} files`
            : isGitRepository ? 'HEAD → Working Tree' : 'Read-only preview'}
        </span>
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
