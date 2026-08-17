import { useEffect, useRef, useState } from 'react'
import {
  IconBraces,
  IconBranch,
  IconBrandGithub,
  IconCodeFolder,
  IconInReview,
  IconRefresh,
  IconSwitch,
  IconX
} from '@pierre/icons'

import type {
  GitIntegrationSnapshot,
  PullRequestSummary
} from '../../shared/contracts'
import { parsePullRequestSelector } from './pullRequestSelector'

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

interface RepositoryPanelProps {
  integration: GitIntegrationSnapshot | null
  loading: boolean
  actionKey: string | null
  onClose(): void
  onReload(): void
  onSwitchBranch(name: string): void
  onReviewLocalBranch(baseRef: string, headRef: string): void
  onReviewCommit(oid: string): void
  onFetch(): void
  onPull(): void
  onPush(): void
  onReview(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

type PanelTab = 'history' | 'branches' | 'remotes' | 'pull-requests'

function formatRelativeDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsedDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
  if (elapsedDays === 0) return 'today'
  if (elapsedDays === 1) return 'yesterday'
  if (elapsedDays < 30) return `${elapsedDays}d ago`
  return shortDateFormatter.format(timestamp)
}

function formatDecision(decision: string | null): string | null {
  if (decision == null || decision === '') return null
  return decision.toLowerCase().replaceAll('_', ' ')
}

export function RepositoryPanel({
  integration,
  loading,
  actionKey,
  onClose,
  onReload,
  onSwitchBranch,
  onReviewLocalBranch,
  onReviewCommit,
  onFetch,
  onPull,
  onPush,
  onReview,
  onOpenPullRequest,
  onCheckout
}: RepositoryPanelProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<PanelTab>('history')
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('')
  const [pullRequestQuery, setPullRequestQuery] = useState('')
  const [pullRequestQueryError, setPullRequestQueryError] = useState<string | null>(null)
  const currentBranch = integration?.branches.find((branch) => branch.current)?.name ?? null
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
    <dialog ref={dialogRef} className="git-panel-layer" aria-labelledby="git-panel-title" onCancel={(event) => {
      event.preventDefault()
      onClose()
    }}>
      <aside className="git-panel">
        <header className="git-panel-header">
          <div>
            <IconBranch />
            <span><strong id="git-panel-title">Repository</strong><small>Local Git · GitHub optional</small></span>
          </div>
          <div>
            <button type="button" onClick={onReload} disabled={loading} aria-label="Reload Git data" title="Reload Git Data">
              <IconRefresh className={loading ? 'spin' : undefined} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close repository panel" title="Close Repository Panel"><IconX /></button>
          </div>
        </header>

        <div className="git-sync-bar" aria-label="Remote synchronization">
          <span>{integration?.behind ?? 0} behind</span>
          <span>{integration?.ahead ?? 0} ahead</span>
          <div>
            <button type="button" onClick={onFetch} disabled={actionKey != null}>{actionKey === 'sync:fetch' ? <IconRefresh className="spin" /> : null}Fetch</button>
            <button type="button" onClick={onPull} disabled={actionKey != null}>{actionKey === 'sync:pull' ? <IconRefresh className="spin" /> : null}Pull</button>
            <button type="button" onClick={onPush} disabled={actionKey != null}>{actionKey === 'sync:push' ? <IconRefresh className="spin" /> : null}Push</button>
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
            <IconBrandGithub />Pull requests <span>{integration?.pullRequests.length ?? 0}</span>
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
              {integration?.githubAvailable === false ? (
                <div className="git-panel-notice"><strong>GitHub is unavailable</strong><span>{integration.githubMessage}</span></div>
              ) : integration?.pullRequests.length === 0 ? (
                <div className="git-panel-state"><strong>No pull requests found</strong><span>Enter a PR number or URL above to open one directly.</span></div>
              ) : integration?.pullRequests.map((pullRequest) => {
                const reviewKey = `review:${pullRequest.number}`
                const checkoutKey = `checkout:${pullRequest.number}`
                const decision = formatDecision(pullRequest.reviewDecision)
                return (
                  <article className="pr-row" key={pullRequest.number}>
                    <div className="pr-row-title">
                      <span>#{pullRequest.number}</span>
                      <strong>{pullRequest.title}</strong>
                      <em className={`pr-state state-${pullRequest.state.toLowerCase()}`}>{pullRequest.state}</em>
                      {pullRequest.isDraft ? <em>Draft</em> : null}
                    </div>
                    <div className="pr-row-meta">
                      <span>{pullRequest.author.login}</span>
                      <span>{pullRequest.headRefName} → {pullRequest.baseRefName}</span>
                      <span>{formatRelativeDate(pullRequest.updatedAt)}</span>
                    </div>
                    <div className="pr-row-footer">
                      <span className="diff-stat"><b>+{pullRequest.additions}</b><i>−{pullRequest.deletions}</i><span>{pullRequest.changedFiles} files</span></span>
                      {decision != null ? <span className={`review-decision decision-${pullRequest.reviewDecision?.toLowerCase()}`}>{decision}</span> : null}
                      <div className="pr-row-actions">
                        <button type="button" onClick={() => onCheckout(pullRequest)} disabled={actionKey != null}>
                          {actionKey === checkoutKey ? <IconRefresh className="spin" /> : <IconBranch />}Checkout
                        </button>
                        <button className="primary" type="button" onClick={() => onReview(pullRequest)} disabled={actionKey != null}>
                          {actionKey === reviewKey ? <IconRefresh className="spin" /> : <IconInReview />}Review Changes
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </section>
          ) : tab === 'branches' ? (
            <section className="branch-list" aria-label="Local branches">
              <div className="branch-compare-base">
                <label htmlFor="branch-base">Comparison base</label>
                <select id="branch-base" value={baseBranch} onChange={(event) => setSelectedBaseBranch(event.target.value)}>
                  {integration?.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                </select>
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
                      {!branch.current ? <button type="button" onClick={() => onSwitchBranch(branch.name)} disabled={actionKey != null}>{actionKey === branchKey ? <IconRefresh className="spin" /> : null}Switch</button> : null}
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
