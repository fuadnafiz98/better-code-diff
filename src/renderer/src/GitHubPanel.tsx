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
  PullRequestMergeStrategy,
  PullRequestInboxSnapshot,
  PullRequestSummary
} from '../../shared/contracts'
import { parsePullRequestSelector } from './pullRequestSelector'
import { SelectControl } from './SelectControl'
import type { RepositoryPanelTab } from './useGitWorkflow'

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

interface RepositoryPanelProps {
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
  onCheckout
}: RepositoryPanelProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<RepositoryPanelTab>(initialTab)
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('')
  const [pullRequestQuery, setPullRequestQuery] = useState('')
  const [pullRequestQueryError, setPullRequestQueryError] = useState<string | null>(null)
  const currentBranch = integration?.branches.find((branch) => branch.current)?.name ?? null
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
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

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
          <div>
            <button type="button" onClick={onFetch} disabled={actionKey != null}><ActionIcon busy={actionKey === 'sync:fetch'} />Fetch</button>
            <button type="button" onClick={onPull} disabled={actionKey != null}><ActionIcon busy={actionKey === 'sync:pull'} />Pull</button>
            <button type="button" onClick={onPush} disabled={actionKey != null}><ActionIcon busy={actionKey === 'sync:push'} />Push</button>
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
                  <button type="button" onClick={() => onReviewCommit(commit.oid)} disabled={actionKey != null} aria-label={`Review commit ${commit.shortOid}`}>
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
                  <button type="submit" disabled={actionKey != null || pullRequestQuery.trim() === ''}>
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
                ) : visiblePullRequests.map((pullRequest) => {
                  const details = pullRequestsByNumber.get(pullRequest.number)
                  const reviewKey = `review:${pullRequest.number}`
                  return (
                    <article className="pr-row compact" key={pullRequest.number}>
                      <div className="pr-row-title">
                        <span>#{pullRequest.number}</span>
                        <strong>{pullRequest.title}</strong>
                        {pullRequest.state.toLowerCase() === 'open' ? null : (
                          <em className={`pr-state state-${pullRequest.state.toLowerCase()}`}>{pullRequest.state}</em>
                        )}
                        {pullRequest.isDraft ? <em>Draft</em> : null}
                      </div>
                      <div className="pr-row-meta">
                        <span>{pullRequest.author.login}</span>
                        {details != null ? <span>{details.headRefName} → {details.baseRefName}</span> : null}
                        <span>{formatRelativeDate(pullRequest.updatedAt)}</span>
                      </div>
                      <div className="pr-row-actions">
                        {details != null ? <button type="button" onClick={() => onCheckout(details)} disabled={actionKey != null}
                          aria-label={`Checkout pull request ${pullRequest.number}`} title="Checkout">
                          <ActionIcon busy={actionKey === `checkout:${pullRequest.number}`}><IconBranch /></ActionIcon>
                        </button> : null}
                        {details?.isDraft && details.state.toLowerCase() === 'open' ? (
                          <button type="button" onClick={() => onMarkReady(details)} disabled={actionKey != null}
                            aria-label={`Mark pull request ${pullRequest.number} ready`} title="Mark ready">
                            <ActionIcon busy={actionKey === `ready:${pullRequest.number}`}><IconApproved /></ActionIcon>
                          </button>
                        ) : null}
                        {details?.state.toLowerCase() === 'open' && !details.isDraft ? (
                          <button type="button" onClick={() => onMerge(details, 'squash')} disabled={actionKey != null}
                            aria-label={`Squash and merge pull request ${pullRequest.number}`} title="Squash and merge">
                            <ActionIcon busy={actionKey === `merge:${pullRequest.number}`}><IconMerged /></ActionIcon>
                          </button>
                        ) : null}
                        <button className="primary" type="button"
                          onClick={() => details == null ? onOpenPullRequest(pullRequest.number) : onReview(details)}
                          disabled={actionKey != null} aria-label={`Review pull request ${pullRequest.number}`} title="Review changes">
                          {actionKey === reviewKey ? <IconRefresh className="spin" /> : <IconInReview />}
                        </button>
                      </div>
                    </article>
                  )
                })}
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
                      {branch.name !== baseBranch ? <button type="button" onClick={() => onReviewLocalBranch(baseBranch, branch.name)} disabled={actionKey != null}>{actionKey === compareKey ? <IconRefresh className="spin" /> : <IconInReview />}Compare</button> : null}
                      {!branch.current ? <button type="button" onClick={() => onSwitchBranch(branch.name)} disabled={actionKey != null}><ActionIcon busy={actionKey === branchKey} />Switch</button> : null}
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
