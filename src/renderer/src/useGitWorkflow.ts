import { useCallback, useMemo, useState } from 'react'

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
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'

interface UseGitWorkflowOptions {
  snapshot: RepositorySnapshot | null
  applySnapshot(snapshot: RepositorySnapshot): void
  onError(message: string | null): void
  onSelectPath(path: string | null): void
  onWorkspaceViewChange(view: WorkspaceView): void
}

export type RepositoryPanelTab = 'history' | 'branches' | 'remotes' | 'pull-requests'

export function useGitWorkflow({
  snapshot,
  applySnapshot,
  onError,
  onSelectPath,
  onWorkspaceViewChange
}: UseGitWorkflowOptions) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<RepositoryPanelTab>('pull-requests')
  const [integration, setIntegration] = useState<GitIntegrationSnapshot | null>(null)
  const [loadingIntegration, setLoadingIntegration] = useState(false)
  const [inbox, setInbox] = useState<PullRequestInboxSnapshot | null>(null)
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [repositoryReview, setRepositoryReview] = useState<RepositoryReview | null>(null)
  const [submittingReview, setSubmittingReview] = useState(false)
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null)

  const reset = useCallback(() => {
    setRepositoryReview(null)
    setSubmissionMessage(null)
    setIntegration(null)
    setInbox(null)
    setPanelOpen(false)
  }, [])

  const loadIntegration = useCallback(async () => {
    setLoadingIntegration(true)
    onError(null)
    try {
      setIntegration(await requireRepositoryApi().getGitIntegration())
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoadingIntegration(false)
    }
  }, [onError])

  const loadInbox = useCallback(async () => {
    setLoadingInbox(true)
    try {
      setInbox(await requireRepositoryApi().getPullRequestInbox())
    } catch (error) {
      setInbox({ available: false, message: getErrorMessage(error), sections: [] })
    } finally {
      setLoadingInbox(false)
    }
  }, [])

  const mergePullRequest = useCallback(async (
    pullRequest: PullRequestSummary,
    strategy: PullRequestMergeStrategy
  ) => {
    setActionKey(`merge:${pullRequest.number}`)
    onError(null)
    try {
      await requireRepositoryApi().mergePullRequest(pullRequest.number, strategy)
      await loadIntegration()
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [loadIntegration, onError])

  const markPullRequestReady = useCallback(async (pullRequest: PullRequestSummary) => {
    setActionKey(`ready:${pullRequest.number}`)
    onError(null)
    try {
      await requireRepositoryApi().markPullRequestReady(pullRequest.number)
      await loadIntegration()
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [loadIntegration, onError])

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

  const confirmWorkingTreeChange = useCallback((action: string): boolean => {
    if ((snapshot?.statuses.length ?? 0) === 0) return true
    return window.confirm(`The working tree has local changes. Git will stop the ${action} if it would overwrite them. Continue?`)
  }, [snapshot?.statuses.length])

  const switchBranch = useCallback(async (name: string) => {
    if (!confirmWorkingTreeChange('branch switch')) return
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
    setActionKey(`review:${selector}`)
    onError(null)
    // A large review is streamed: its metadata opens the view, then each page of
    // files is appended. Waiting for the whole fetch left the app on a spinner for
    // minutes on pull requests with thousands of files.
    let streamed = false
    const stopListening = requireRepositoryApi().onPullRequestReviewProgress((progress) => {
      if (progress.kind === 'metadata') {
        streamed = true
        setRepositoryReview(progress.review)
        setSubmissionMessage(null)
        onWorkspaceViewChange('multi')
        setPanelOpen(false)
        setActionKey(null)
        return
      }
      let firstPath: string | null = null
      setRepositoryReview((current) => {
        if (current == null || current.kind !== 'github' || current.selector !== progress.selector) return current
        if (current.files.length === 0) firstPath = progress.files[0]?.path ?? null
        return {
          ...current,
          files: [...current.files, ...progress.files],
          patch: `${current.patch}${progress.patch}`,
          omittedFiles: [...current.omittedFiles, ...progress.omittedFiles]
        }
      })
      // Selecting on the first page rather than at the end keeps the review from
      // jumping back to file one once the last page lands.
      if (firstPath != null) onSelectPath(firstPath)
    })
    try {
      const review = await requireRepositoryApi().getPullRequestReview(selector)
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
      onError(getErrorMessage(error))
    } finally {
      stopListening()
      setActionKey(null)
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
    if (!confirmWorkingTreeChange('pull request checkout')) return
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
      setIntegration(await requireRepositoryApi().fetchRemote())
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [onError])

  const pullCurrentBranch = useCallback(async () => {
    if (!confirmWorkingTreeChange('pull')) return
    setActionKey('sync:pull')
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().pullCurrentBranch()
      setRepositoryReview(null)
      applySnapshot(nextSnapshot)
      setIntegration(await requireRepositoryApi().getGitIntegration())
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, onError])

  const pushCurrentBranch = useCallback(async () => {
    setActionKey('sync:push')
    onError(null)
    try {
      setIntegration(await requireRepositoryApi().pushCurrentBranch())
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [onError])

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
    if (!window.confirm(`Submit this review${commentSummary} to GitHub and ${actionLabel} #${pullRequest.number}?`)) return false

    setSubmittingReview(true)
    setSubmissionMessage(null)
    onError(null)
    try {
      await requireRepositoryApi().submitPullRequestReview(selector, repositoryReview.commitId, reviewEvent, body, comments)
      setIntegration(null)
      setSubmissionMessage('Review submitted to GitHub.')
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setSubmittingReview(false)
    }
  }, [onError, repositoryReview])

  const closeReview = useCallback(() => {
    setRepositoryReview(null)
    setSubmissionMessage(null)
    onSelectPath(snapshot?.statuses[0]?.path ?? null)
  }, [onSelectPath, snapshot?.statuses])

  return useMemo(() => ({
    panelOpen,
    panelTab,
    setPanelOpen,
    integration,
    loadingIntegration,
    inbox,
    loadingInbox,
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
