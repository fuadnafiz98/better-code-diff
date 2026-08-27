import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  GitIntegrationSnapshot,
  PullRequestInboxSnapshot,
  PullRequestMergeStrategy,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  PullRequestSummary,
  RepositoryReview,
  RepositorySnapshot
} from '../../shared/contracts'
import type { WorkspaceView } from './AppView'
import type { ConfirmRequest } from './ConfirmDialog'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'

interface UseGitWorkflowOptions {
  snapshot: RepositorySnapshot | null
  applySnapshot(snapshot: RepositorySnapshot): void
  onError(message: string | null): void
  onSelectPath(path: string | null): void
  onWorkspaceViewChange(view: WorkspaceView): void
  confirm(request: ConfirmRequest): Promise<boolean>
}

export type RepositoryPanelTab = 'history' | 'branches' | 'remotes' | 'pull-requests'

// Long enough that closing and reopening the panel — the normal way to check a
// pull request — is free, short enough that a branch you switched in a terminal
// shows up without a manual refresh. Anything that moves HEAD or the branch
// invalidates the entry immediately regardless of the clock.
export const GIT_PANEL_TTL_MS = 30_000

export interface PanelCacheEntry<Value> {
  data: Value | null
  fetchedAt: number
  head: string | null
  branch: string | null
}

const emptyEntry = <Value,>(): PanelCacheEntry<Value> => ({
  data: null,
  fetchedAt: 0,
  head: null,
  branch: null
})

export function isPanelDataStale(
  entry: PanelCacheEntry<unknown>,
  snapshot: { head: string | null; branch: string | null } | null,
  now: number,
  ttlMs: number = GIT_PANEL_TTL_MS
): boolean {
  if (entry.data == null) return true
  if (snapshot != null && (entry.head !== snapshot.head || entry.branch !== snapshot.branch)) return true
  return now - entry.fetchedAt >= ttlMs
}

export function useGitWorkflow({
  snapshot,
  applySnapshot,
  onError,
  onSelectPath,
  onWorkspaceViewChange,
  confirm
}: UseGitWorkflowOptions) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<RepositoryPanelTab>('pull-requests')
  const [integrationEntry, setIntegrationEntry] = useState<PanelCacheEntry<GitIntegrationSnapshot>>(emptyEntry)
  const [loadingIntegration, setLoadingIntegration] = useState(false)
  const [inboxEntry, setInboxEntry] = useState<PanelCacheEntry<PullRequestInboxSnapshot>>(emptyEntry)
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [repositoryReview, setRepositoryReview] = useState<RepositoryReview | null>(null)
  const [submittingReview, setSubmittingReview] = useState(false)
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null)

  const head = snapshot?.head ?? null
  const branch = snapshot?.branch ?? null
  const integration = integrationEntry.data
  const inbox = inboxEntry.data
  const reviewRequestRef = useRef(0)
  // The cache entries are mirrored into refs so a loader can decide whether it
  // still has anything to do without depending on the render that produced it.
  // Only the writers below touch them, never a render.
  const integrationEntryRef = useRef(integrationEntry)
  const inboxEntryRef = useRef(inboxEntry)
  const writeIntegrationEntry = useCallback((entry: PanelCacheEntry<GitIntegrationSnapshot>) => {
    integrationEntryRef.current = entry
    setIntegrationEntry(entry)
  }, [])
  const writeInboxEntry = useCallback((entry: PanelCacheEntry<PullRequestInboxSnapshot>) => {
    inboxEntryRef.current = entry
    setInboxEntry(entry)
  }, [])

  const reset = useCallback(() => {
    requireRepositoryApi().cancelPullRequestReview()
    // Supersede any review still in flight: without this its rejection reports an
    // error in the repository the user just opened, and a late metadata event
    // would install the previous repository's review over it.
    reviewRequestRef.current += 1
    setRepositoryReview(null)
    setSubmissionMessage(null)
    writeIntegrationEntry(emptyEntry())
    writeInboxEntry(emptyEntry())
    setPanelOpen(false)
  }, [writeInboxEntry, writeIntegrationEntry])

  const loadIntegration = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(integrationEntryRef.current, { head, branch }, Date.now())) return
    setLoadingIntegration(true)
    onError(null)
    try {
      const data = await requireRepositoryApi().getGitIntegration()
      writeIntegrationEntry({ data, fetchedAt: Date.now(), head, branch })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoadingIntegration(false)
    }
  }, [branch, head, onError, writeIntegrationEntry])

  const loadInbox = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(inboxEntryRef.current, { head, branch }, Date.now())) return
    setLoadingInbox(true)
    try {
      const data = await requireRepositoryApi().getPullRequestInbox()
      writeInboxEntry({ data, fetchedAt: Date.now(), head, branch })
    } catch (error) {
      writeInboxEntry({
        data: { available: false, message: getErrorMessage(error), sections: [] },
        fetchedAt: Date.now(),
        head,
        branch
      })
    } finally {
      setLoadingInbox(false)
    }
  }, [branch, head, writeInboxEntry])

  const refreshPanelData = useCallback(() => {
    void loadIntegration(true)
    void loadInbox(true)
  }, [loadInbox, loadIntegration])

  const mergePullRequest = useCallback(async (
    pullRequest: PullRequestSummary,
    strategy: PullRequestMergeStrategy
  ) => {
    const action = strategy === 'merge' ? 'Merge' : strategy === 'rebase' ? 'Rebase and merge' : 'Squash and merge'
    // A merge is irreversible and the button sits in a dense icon row next to
    // Checkout and Review, where a misclick used to be enough.
    if (!(await confirm({
      title: `${action} #${pullRequest.number}?`,
      detail: `Merge “${pullRequest.title}” into ${pullRequest.baseRefName}. This cannot be undone.`,
      confirmLabel: action,
      destructive: true
    }))) return
    setActionKey(`merge:${pullRequest.number}`)
    onError(null)
    try {
      await requireRepositoryApi().mergePullRequest(pullRequest.number, strategy)
      // The panel prefers the inbox whenever it has entries, so refreshing only
      // the integration snapshot left the merged row on screen, still labelled
      // open, with its merge button live.
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [confirm, loadInbox, loadIntegration, onError])

  const markPullRequestReady = useCallback(async (pullRequest: PullRequestSummary) => {
    if (!(await confirm({
      title: `Mark #${pullRequest.number} ready for review?`,
      detail: `Reviewers will be notified about “${pullRequest.title}”.`,
      confirmLabel: 'Mark ready'
    }))) return
    setActionKey(`ready:${pullRequest.number}`)
    onError(null)
    try {
      await requireRepositoryApi().markPullRequestReady(pullRequest.number)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [confirm, loadInbox, loadIntegration, onError])

  const openPanel = useCallback(() => {
    setPanelTab('pull-requests')
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadIntegration, loadInbox])

  const openBranches = useCallback(() => {
    setPanelTab('branches')
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadInbox, loadIntegration])

  const confirmWorkingTreeChange = useCallback(async (action: string): Promise<boolean> => {
    if ((snapshot?.statuses.length ?? 0) === 0) return true
    return confirm({
      title: `Continue with the ${action}?`,
      detail: `The working tree has local changes. Git will stop the ${action} if it would overwrite them.`
    })
  }, [confirm, snapshot?.statuses.length])

  const switchBranch = useCallback(async (name: string) => {
    if (!(await confirmWorkingTreeChange('branch switch'))) return
    setActionKey(`branch:${name}`)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().switchBranch(name)
      setRepositoryReview(null)
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, onError])

  const openPullRequestReview = useCallback(async (selector: number | string) => {
    reviewRequestRef.current += 1
    const requestId = reviewRequestRef.current
    setActionKey(`review:${selector}`)
    onError(null)
    // A large review is streamed: its metadata opens the view, then each page of
    // files is appended. Waiting for the whole fetch left the app on a spinner for
    // minutes on pull requests with thousands of files.
    let streamed = false
    let selectedFirstStreamedPath = false
    const stopListening = requireRepositoryApi().onPullRequestReviewProgress((progress) => {
      if (progress.kind === 'metadata') {
        // A superseded review's metadata can still arrive: without this guard it
        // installs the wrong review over the one the user actually asked for.
        if (reviewRequestRef.current !== requestId) return
        streamed = true
        setRepositoryReview(progress.review)
        setSubmissionMessage(null)
        onWorkspaceViewChange('multi')
        setPanelOpen(false)
        setActionKey(null)
        return
      }
      if (reviewRequestRef.current !== requestId) return
      const firstPath = selectedFirstStreamedPath ? null : progress.files[0]?.path ?? null
      setRepositoryReview((current) => {
        if (current == null || current.kind !== 'github' || current.selector !== progress.selector) return current
        return {
          ...current,
          files: [...current.files, ...progress.files],
          patch: `${current.patch}${progress.patch}`,
          omittedFiles: [...current.omittedFiles, ...progress.omittedFiles]
        }
      })
      // Selecting on the first page rather than at the end keeps the review from
      // jumping back to file one once the last page lands.
      if (firstPath != null) {
        selectedFirstStreamedPath = true
        onSelectPath(firstPath)
      }
    })
    try {
      const review = await requireRepositoryApi().getPullRequestReview(selector)
      // An aborted review resolves successfully with whatever was collected, so a
      // superseded request must not adopt it over the newer stream.
      if (reviewRequestRef.current !== requestId) return
      if (streamed) {
        // The resolved review is authoritative: progress events and the reply to
        // this call are separate IPC messages, so a late page can land after the
        // listener is gone. Its patch shares the streamed prefix, so adopting it
        // only costs parsing whatever tail was missed. The expected count becomes
        // what actually arrived — GitHub's own number can exceed what its files API
        // will serve, and nothing is still loading once the fetch has finished.
        setRepositoryReview((current) => current != null
          && current.kind === 'github'
          && current.selector === review.selector
          ? { ...review, expectedFileCount: review.files.length }
          : current)
        return
      }
      setRepositoryReview(review)
      setSubmissionMessage(null)
      onSelectPath(review.files[0]?.path ?? null)
      onWorkspaceViewChange('multi')
      setPanelOpen(false)
    } catch (error) {
      // A review the user closed, or one superseded by another, fails by design:
      // reporting it would show a banner for something they asked to stop.
      if (reviewRequestRef.current === requestId) onError(getErrorMessage(error))
      // The stream is dead either way, so collapse the target onto what actually
      // arrived — otherwise the review sits there looking like it is still loading
      // until the 25 s stall backstop fires.
      if (streamed && reviewRequestRef.current === requestId) {
        setRepositoryReview((current) => current != null
          && current.kind === 'github'
          && current.selector === selector
          ? { ...current, expectedFileCount: current.files.length }
          : current)
      }
    } finally {
      stopListening()
      // Not gated on the request id: closing a review bumps that ref, and the
      // abandoned key would then disable the open-by-number form for good.
      setActionKey((current) => current === `review:${selector}` ? null : current)
    }
  }, [onError, onSelectPath, onWorkspaceViewChange])

  const reviewPullRequest = useCallback((pullRequest: PullRequestSummary) => {
    return openPullRequestReview(pullRequest.number)
  }, [openPullRequestReview])

  const reviewLocalBranch = useCallback(async (baseRef: string, headRef: string) => {
    setActionKey(`compare:${headRef}`)
    onError(null)
    try {
      const review = await requireRepositoryApi().getLocalBranchReview(baseRef, headRef)
      setRepositoryReview(review)
      setSubmissionMessage(null)
      onSelectPath(review.files[0]?.path ?? null)
      onWorkspaceViewChange('multi')
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [onError, onSelectPath, onWorkspaceViewChange])

  const reviewCommit = useCallback(async (oid: string) => {
    setActionKey(`commit:${oid}`)
    onError(null)
    try {
      const review = await requireRepositoryApi().getCommitReview(oid)
      setRepositoryReview(review)
      setSubmissionMessage(null)
      onSelectPath(review.files[0]?.path ?? null)
      onWorkspaceViewChange('multi')
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [onError, onSelectPath, onWorkspaceViewChange])

  const checkoutPullRequest = useCallback(async (pullRequest: PullRequestSummary) => {
    if (!(await confirmWorkingTreeChange('pull request checkout'))) return
    setActionKey(`checkout:${pullRequest.number}`)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().checkoutPullRequest(pullRequest.number)
      setRepositoryReview(null)
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, onError])

  const fetchRemote = useCallback(async () => {
    setActionKey('sync:fetch')
    onError(null)
    try {
      writeIntegrationEntry({ data: await requireRepositoryApi().fetchRemote(), fetchedAt: Date.now(), head, branch })
      void loadInbox(true)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, loadInbox, onError, writeIntegrationEntry])

  const pullCurrentBranch = useCallback(async () => {
    if (!(await confirmWorkingTreeChange('pull'))) return
    setActionKey('sync:pull')
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().pullCurrentBranch()
      setRepositoryReview(null)
      applySnapshot(nextSnapshot)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, loadInbox, loadIntegration, onError])

  const pushCurrentBranch = useCallback(async () => {
    setActionKey('sync:push')
    onError(null)
    try {
      writeIntegrationEntry({
        data: await requireRepositoryApi().pushCurrentBranch(),
        fetchedAt: Date.now(),
        head,
        branch
      })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, onError, writeIntegrationEntry])

  const submitReview = useCallback(async (
    reviewEvent: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<boolean> => {
    if (repositoryReview?.kind !== 'github') return false
    const pullRequest = repositoryReview.pullRequest
    const selector = repositoryReview.selector
    const actionLabel = reviewEvent === 'approve'
      ? 'approve'
      : reviewEvent === 'request-changes' ? 'request changes on' : 'comment on'
    const commentSummary = comments.length === 0
      ? ''
      : ` with ${comments.length} inline ${comments.length === 1 ? 'comment' : 'comments'}`
    if (!(await confirm({
      title: `Submit review for #${pullRequest.number}?`,
      detail: `This will submit the review${commentSummary} to GitHub and ${actionLabel} #${pullRequest.number}.`,
      confirmLabel: 'Submit review'
    }))) return false

    setSubmittingReview(true)
    setSubmissionMessage(null)
    onError(null)
    try {
      await requireRepositoryApi().submitPullRequestReview(selector, repositoryReview.commitId, reviewEvent, body, comments)
      // Marked stale rather than cleared: blanking the cache put the panel back
      // on its blocking spinner the next time it opened.
      writeIntegrationEntry({ ...integrationEntryRef.current, fetchedAt: 0 })
      writeInboxEntry({ ...inboxEntryRef.current, fetchedAt: 0 })
      setSubmissionMessage('Review submitted to GitHub.')
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setSubmittingReview(false)
    }
  }, [confirm, onError, repositoryReview, writeInboxEntry, writeIntegrationEntry])

  const closeReview = useCallback(() => {
    // Otherwise up to eight `gh api` children per wave keep paging a patch that
    // is already discarded.
    requireRepositoryApi().cancelPullRequestReview()
    reviewRequestRef.current += 1
    setRepositoryReview(null)
    setSubmissionMessage(null)
    onSelectPath(snapshot?.statuses[0]?.path ?? null)
  }, [onSelectPath, snapshot?.statuses])

  // While the panel is open a commit or a branch switch made in the terminal
  // invalidates the entry, so ahead/behind and the branch list stop being a
  // snapshot of whenever the panel was last opened.
  useEffect(() => {
    if (!panelOpen) return
    void loadIntegration()
    void loadInbox()
  }, [branch, head, loadInbox, loadIntegration, panelOpen])

  return useMemo(() => ({
    panelOpen,
    panelTab,
    setPanelOpen,
    integration,
    integrationFetchedAt: integrationEntry.fetchedAt === 0 ? null : integrationEntry.fetchedAt,
    loadingIntegration,
    inbox,
    loadingInbox,
    refreshPanelData,
    actionKey,
    repositoryReview,
    submittingReview,
    submissionMessage,
    reset,
    loadIntegration,
    openPanel,
    openBranches,
    switchBranch,
    reviewPullRequest,
    openPullRequestReview,
    reviewLocalBranch,
    reviewCommit,
    checkoutPullRequest,
    fetchRemote,
    pullCurrentBranch,
    pushCurrentBranch,
    submitReview,
    closeReview,
    mergePullRequest,
    markPullRequestReady
  }), [
    actionKey,
    integrationEntry.fetchedAt,
    refreshPanelData,
    checkoutPullRequest,
    closeReview,
    fetchRemote,
    inbox,
    integration,
    loadIntegration,
    loadingInbox,
    loadingIntegration,
    markPullRequestReady,
    mergePullRequest,
    openPanel,
    openBranches,
    openPullRequestReview,
    panelOpen,
    panelTab,
    pullCurrentBranch,
    pushCurrentBranch,
    repositoryReview,
    reset,
    reviewCommit,
    reviewLocalBranch,
    reviewPullRequest,
    submissionMessage,
    submitReview,
    submittingReview,
    switchBranch
  ])
}
