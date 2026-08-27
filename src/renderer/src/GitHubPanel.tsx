import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBraces,
  IconBranch,
  IconApproved,
  IconBrandGithub,
  IconCodeFolder,
  IconInReview,
  IconMerged,
  IconRefresh,
  IconSwitch,
  IconX
} from '@pierre/icons'

import type {
  GitIntegrationSnapshot,
  InboxPullRequest,
  PullRequestMergeStrategy,
  PullRequestInboxSnapshot,
  PullRequestSummary
} from '../../shared/contracts'
import { parsePullRequestSelector } from './pullRequestSelector'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import { SelectControl } from './SelectControl'
import type { RepositoryPanelTab } from './useGitWorkflow'

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const FRESHNESS_TICK_MS = 5_000

export function formatUpdatedAgo(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'just now'
  const seconds = Math.floor(elapsedMs / 1_000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

interface RepositoryPanelProps {
  open: boolean
  initialTab: RepositoryPanelTab
  integration: GitIntegrationSnapshot | null
  loading: boolean
  inbox: PullRequestInboxSnapshot | null
  loadingInbox: boolean
  actionKey: string | null
  onClose(): void
  onSwitchBranch(name: string): void
  onReviewLocalBranch(baseRef: string, headRef: string): void
  onReviewCommit(oid: string): void
  onFetch(): void
  onPull(): void
  onPush(): void
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
  onRefresh?(): void
  updatedAt?: number | null
}

interface PullRequestRowProps {
  summary: PullRequestSummary | InboxPullRequest
  details: PullRequestSummary | undefined
  actionKey: string | null
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

// Anything that moves HEAD, the index or a remote branch. Two of these at once
// means index.lock contention, or two merges into the same base, so they exclude
// each other. Read-only work (review:, commit:, compare:) never joins the set, so
// opening a review while a merge finishes stays allowed.
const MUTATING_ACTION_PREFIXES = ['sync:', 'checkout:', 'merge:', 'ready:', 'branch:']

function isMutatingAction(actionKey: string | null): boolean {
  return actionKey != null && MUTATING_ACTION_PREFIXES.some((prefix) => actionKey.startsWith(prefix))
}

function PullRequestRow({
  summary,
  details,
  actionKey,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: PullRequestRowProps): React.JSX.Element {
  const state = summary.state.toLowerCase()
  const mutating = isMutatingAction(actionKey)
  return (
    <article className="pr-row compact">
      <div className="pr-row-title">
        <span>#{summary.number}</span>
        <strong>{summary.title}</strong>
        {state === 'open' ? null : <em className={`pr-state state-${state}`}>{summary.state}</em>}
        {summary.isDraft ? <em>Draft</em> : null}
      </div>
      <div className="pr-row-meta">
        <span>{summary.author.login}</span>
        {details != null ? <span>{details.headRefName} → {details.baseRefName}</span> : null}
        <span>{formatRelativeDate(summary.updatedAt)}</span>
      </div>
      <div className="pr-row-actions">
        {details != null ? <button type="button" onClick={() => onCheckout(details)}
          disabled={mutating}
          aria-busy={actionKey === `checkout:${summary.number}`}
          aria-label={`Checkout pull request ${summary.number}`} title="Checkout">
          <ActionIcon busy={actionKey === `checkout:${summary.number}`}><IconBranch /></ActionIcon>
        </button> : null}
        {details?.isDraft && details.state.toLowerCase() === 'open' ? (
          <button type="button" onClick={() => onMarkReady(details)}
            disabled={mutating}
            aria-busy={actionKey === `ready:${summary.number}`}
            aria-label={`Mark pull request ${summary.number} ready`} title="Mark ready">
            <ActionIcon busy={actionKey === `ready:${summary.number}`}><IconApproved /></ActionIcon>
          </button>
        ) : null}
        {details?.state.toLowerCase() === 'open' && !details.isDraft ? (
          <button type="button" onClick={() => onMerge(details, 'squash')}
            disabled={mutating}
            aria-busy={actionKey === `merge:${summary.number}`}
            aria-label={`Squash and merge pull request ${summary.number}`} title="Squash and merge">
            <ActionIcon busy={actionKey === `merge:${summary.number}`}><IconMerged /></ActionIcon>
          </button>
        ) : null}
        <button className="primary" type="button"
          onClick={() => details == null ? onOpenPullRequest(summary.number) : onReview(details)}
          disabled={actionKey === `review:${summary.number}`}
          aria-busy={actionKey === `review:${summary.number}`}
          aria-label={`Review pull request ${summary.number}`} title="Review changes">
          {actionKey === `review:${summary.number}` ? <IconRefresh className="spin" /> : <IconInReview />}
        </button>
      </div>
    </article>
  )
}

function formatRelativeDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsedDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
  if (elapsedDays === 0) return 'today'
  if (elapsedDays === 1) return 'yesterday'
  if (elapsedDays < 30) return `${elapsedDays}d ago`
  return shortDateFormatter.format(timestamp)
}

function ActionIcon({ busy, children }: { busy: boolean; children?: React.ReactNode }): React.JSX.Element | null {
  const icon = busy ? <IconRefresh className="spin" /> : children
  return icon == null ? null : <span className="action-icon-slot">{icon}</span>
}

export function RepositoryPanel({
  open,
  initialTab,
  integration,
  loading,
  inbox,
  loadingInbox,
  actionKey,
  onClose,
  onSwitchBranch,
  onReviewLocalBranch,
  onReviewCommit,
  onFetch,
  onPull,
  onPush,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout,
  onRefresh,
  updatedAt
}: RepositoryPanelProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<RepositoryPanelTab>(initialTab)
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('')
  const [pullRequestQuery, setPullRequestQuery] = useState('')
  const [pullRequestQueryError, setPullRequestQueryError] = useState<string | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [closedPullRequests, setClosedPullRequests] = useState<PullRequestSummary[] | null>(null)
  const [loadingClosed, setLoadingClosed] = useState(false)
  const [closedPullRequestsError, setClosedPullRequestsError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const currentBranch = integration?.branches.find((branch) => branch.current)?.name ?? null
  const syncing = actionKey?.startsWith('sync:') === true
  const mutating = isMutatingAction(actionKey)
  const populatedInboxSections = inbox?.available
    ? inbox.sections.filter((section) => section.pullRequests.length > 0)
    : []
  const inboxPullRequests = populatedInboxSections.flatMap((section) => section.pullRequests)
  const visiblePullRequests = inbox?.available && inboxPullRequests.length > 0
    ? inboxPullRequests
    : integration?.pullRequests ?? []
  const pullRequestsByNumber = useMemo(
    () => new Map(integration?.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]) ?? []),
    [integration?.pullRequests]
  )
  const baseBranch = selectedBaseBranch || integration?.defaultBranch || currentBranch || ''

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (updatedAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [updatedAt])

  // Closed and merged pull requests are a second network round trip, so they load
  // the first time somebody asks to see them rather than on every panel open.
  const toggleClosed = (): void => {
    if (showClosed) {
      setShowClosed(false)
      return
    }
    setShowClosed(true)
    if ((closedPullRequests != null && closedPullRequestsError == null) || loadingClosed) return
    setLoadingClosed(true)
    void (async () => {
      try {
        setClosedPullRequests(await requireRepositoryApi().getClosedPullRequests())
        setClosedPullRequestsError(null)
      } catch (error) {
        setClosedPullRequestsError(getErrorMessage(error))
      } finally {
        setLoadingClosed(false)
      }
    })()
  }

  const submitPullRequestQuery = (): void => {
    const selector = parsePullRequestSelector(pullRequestQuery)
    if (selector == null) {
      setPullRequestQueryError('Enter a PR number or a GitHub pull request URL.')
      return
    }
    setPullRequestQueryError(null)
    onOpenPullRequest(selector)
  }

  return (
    <dialog
      ref={dialogRef}
      className="git-panel-layer"
      aria-labelledby="git-panel-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <button
        className="git-panel-dismiss-area"
        type="button"
        tabIndex={-1}
        aria-label="Close repository panel"
        onClick={onClose}
      />
      <aside className="git-panel">
        <header className="git-panel-header">
          <div>
            <IconBranch />
            <span><strong id="git-panel-title">Repository</strong><small>Local Git · GitHub optional</small></span>
          </div>
          <div>
            <button type="button" onClick={onClose} aria-label="Close repository panel" title="Close Repository Panel"><IconX /></button>
          </div>
        </header>

        <div className="git-sync-bar" aria-label="Remote synchronization">
          <span>{integration?.behind ?? 0} behind</span>
          <span>{integration?.ahead ?? 0} ahead</span>
          {updatedAt == null ? null : (
            <small className="git-sync-freshness">
              {loading || loadingInbox ? 'updating…' : `updated ${formatUpdatedAgo(now - updatedAt)}`}
            </small>
          )}
          <div>
            {onRefresh == null ? null : (
              <button type="button" onClick={onRefresh} disabled={syncing} title="Refresh repository data">
                <ActionIcon busy={loading || loadingInbox}><IconRefresh /></ActionIcon>Refresh
              </button>
            )}
            <button type="button" onClick={onFetch} disabled={mutating} aria-busy={actionKey === 'sync:fetch'}><ActionIcon busy={actionKey === 'sync:fetch'} />Fetch</button>
            <button type="button" onClick={onPull} disabled={mutating} aria-busy={actionKey === 'sync:pull'}><ActionIcon busy={actionKey === 'sync:pull'} />Pull</button>
            <button type="button" onClick={onPush} disabled={mutating} aria-busy={actionKey === 'sync:push'}><ActionIcon busy={actionKey === 'sync:push'} />Push</button>
          </div>
        </div>

        <div className="git-panel-tabs" role="tablist" aria-label="Repository data">
          <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : undefined} onClick={() => setTab('history')}>
            <IconBraces />History <span>{integration?.commits.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'branches'} className={tab === 'branches' ? 'active' : undefined} onClick={() => setTab('branches')}>
            <IconBranch />Branches <span>{integration?.branches.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'remotes'} className={tab === 'remotes' ? 'active' : undefined} onClick={() => setTab('remotes')}>
            <IconCodeFolder />Remotes <span>{integration?.remotes.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'pull-requests'} className={tab === 'pull-requests' ? 'active' : undefined} onClick={() => setTab('pull-requests')}>
            <IconBrandGithub />Pull requests <span>{visiblePullRequests.length}</span>
          </button>
        </div>

        <div className="git-panel-content">
          {loading && integration == null ? (
            <div className="git-panel-state"><IconRefresh className="spin" /><span>Loading repository data…</span></div>
          ) : tab === 'history' ? (
            <section className="commit-list" aria-label="Recent commits">
              {integration?.commits.length === 0 ? <div className="git-panel-state"><strong>No commits</strong><span>This repository has no commit history.</span></div> : null}
              {integration?.commits.map((commit) => (
                <article className="commit-row" key={commit.oid}>
                  <span className="commit-node" aria-hidden="true" />
                  <div>
                    <strong>{commit.subject}</strong>
                    <span>{commit.authorName} · {formatRelativeDate(commit.authoredAt)}</span>
                    {commit.decorations.length > 0 ? <div>{commit.decorations.map((decoration) => <em key={decoration}>{decoration}</em>)}</div> : null}
                  </div>
                  <code>{commit.shortOid}</code>
                  <button type="button" onClick={() => onReviewCommit(commit.oid)}
                    disabled={actionKey === `commit:${commit.oid}`} aria-busy={actionKey === `commit:${commit.oid}`}
                    aria-label={`Review commit ${commit.shortOid}`}>
                    {actionKey === `commit:${commit.oid}` ? <IconRefresh className="spin" /> : <IconInReview />}
                  </button>
                </article>
              ))}
            </section>
          ) : tab === 'pull-requests' ? (
            <section className="pr-list" aria-label="Recent pull requests">
              <form className="pr-open-form" onSubmit={(event) => {
                event.preventDefault()
                submitPullRequestQuery()
              }}>
                <label htmlFor="pr-open-input">Open pull request</label>
                <div>
                  <input
                    id="pr-open-input"
                    value={pullRequestQuery}
                    onChange={(event) => {
                      setPullRequestQuery(event.target.value)
                      if (pullRequestQueryError != null) setPullRequestQueryError(null)
                    }}
                    placeholder="#123 or GitHub URL"
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-describedby={pullRequestQueryError == null ? undefined : 'pr-open-error'}
                    aria-invalid={pullRequestQueryError != null}
                  />
                  <button type="submit" disabled={pullRequestQuery.trim() === ''}
                    aria-busy={actionKey?.startsWith('review:') === true}>
                    {actionKey?.startsWith('review:') ? <IconRefresh className="spin" /> : <IconInReview />}
                    Review
                  </button>
                </div>
                {pullRequestQueryError != null ? <span id="pr-open-error" role="alert">{pullRequestQueryError}</span> : null}
              </form>
              <div className="pr-inbox" aria-label="Pull requests">
                <div className="pr-inbox-heading">
                  <strong>{inbox?.available && inboxPullRequests.length > 0 ? 'Inbox' : 'Repository pull requests'}</strong>
                  <span>{visiblePullRequests.length}</span>
                  {loadingInbox ? <IconRefresh className="spin" /> : null}
                </div>
                {visiblePullRequests.length === 0 && loadingInbox ? null : visiblePullRequests.length === 0 ? (
                  <div className="git-panel-state"><strong>Inbox zero</strong><span>Nothing needs your review right now.</span></div>
                ) : visiblePullRequests.map((pullRequest) => (
                  <PullRequestRow key={pullRequest.number} summary={pullRequest}
                    details={pullRequestsByNumber.get(pullRequest.number)} actionKey={actionKey}
                    onReview={onReview} onMerge={onMerge} onMarkReady={onMarkReady}
                    onOpenPullRequest={onOpenPullRequest} onCheckout={onCheckout} />
                ))}
              </div>
              <div className="pr-inbox" aria-label="Closed pull requests">
                <div className="pr-inbox-heading">
                  <strong>Closed and merged</strong>
                  {closedPullRequests == null ? null : <span>{closedPullRequests.length}</span>}
                  {loadingClosed ? <IconRefresh className="spin" /> : null}
                  <button type="button" onClick={toggleClosed} aria-expanded={showClosed}>
                    {showClosed ? 'Hide' : 'Show closed'}
                  </button>
                </div>
                {!showClosed || loadingClosed ? null : closedPullRequestsError != null ? (
                  <div className="git-panel-state">
                    <strong>Could not load closed pull requests</strong>
                    <span>{closedPullRequestsError}</span>
                  </div>
                ) : closedPullRequests?.length === 0 ? (
                  <div className="git-panel-state"><strong>Nothing closed</strong><span>No recently closed pull requests.</span></div>
                ) : closedPullRequests?.map((pullRequest) => (
                  <PullRequestRow key={pullRequest.number} summary={pullRequest} details={pullRequest}
                    actionKey={actionKey} onReview={onReview} onMerge={onMerge} onMarkReady={onMarkReady}
                    onOpenPullRequest={onOpenPullRequest} onCheckout={onCheckout} />
                ))}
              </div>
              {integration?.githubAvailable === false ? (
                <div className="git-panel-notice"><strong>GitHub is unavailable</strong><span>{integration.githubMessage}</span></div>
              ) : null}
            </section>
          ) : tab === 'branches' ? (
            <section className="branch-list" aria-label="Local branches">
              <div className="branch-compare-base">
                <label htmlFor="branch-base">Comparison base</label>
                <SelectControl>
                  <select id="branch-base" value={baseBranch} onChange={(event) => setSelectedBaseBranch(event.target.value)}>
                    {integration?.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                  </select>
                </SelectControl>
              </div>
              {integration?.branches.map((branch) => {
                const branchKey = `branch:${branch.name}`
                const compareKey = `compare:${branch.name}`
                return (
                  <article key={branch.name} className={`branch-row ${branch.current ? 'current' : ''}`}>
                    <IconSwitch />
                    <span><strong>{branch.name}</strong>{branch.upstream != null ? <small>{branch.upstream}</small> : null}</span>
                    {branch.current ? <em>Current</em> : null}
                    <div>
                      {branch.name !== baseBranch ? <button type="button" onClick={() => onReviewLocalBranch(baseBranch, branch.name)} disabled={actionKey === compareKey} aria-busy={actionKey === compareKey}>{actionKey === compareKey ? <IconRefresh className="spin" /> : <IconInReview />}Compare</button> : null}
                      {!branch.current ? <button type="button" onClick={() => onSwitchBranch(branch.name)} disabled={mutating} aria-busy={actionKey === branchKey}><ActionIcon busy={actionKey === branchKey} />Switch</button> : null}
                    </div>
                  </article>
                )
              })}
              {integration != null && integration.remoteBranches.length > 0 ? (
                <div className="remote-branch-summary"><strong>Remote branches</strong>{integration.remoteBranches.map((branch) => <span key={branch.name}>{branch.name}</span>)}</div>
              ) : null}
            </section>
          ) : (
            <section className="remote-list" aria-label="Git remotes">
              {integration?.remotes.length === 0 ? <div className="git-panel-state"><strong>No remotes</strong><span>Add a Git remote to fetch, pull, and push.</span></div> : null}
              {integration?.remotes.map((remote) => (
                <article key={remote.name}>
                  <IconCodeFolder />
                  <div><strong>{remote.name}</strong><code>{remote.fetchUrl}</code>{remote.pushUrl !== remote.fetchUrl ? <code>{remote.pushUrl}</code> : null}</div>
                </article>
              ))}
            </section>
          )}
        </div>
      </aside>
    </dialog>
  )
}
