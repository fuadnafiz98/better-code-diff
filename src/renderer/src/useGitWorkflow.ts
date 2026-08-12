import { useCallback, useState } from 'react'

import type {
  GitIntegrationSnapshot,
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

export function useGitWorkflow({
  snapshot,
  applySnapshot,
  onError,
  onSelectPath,
  onWorkspaceViewChange
}: UseGitWorkflowOptions) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [integration, setIntegration] = useState<GitIntegrationSnapshot | null>(null)
  const [loadingIntegration, setLoadingIntegration] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [repositoryReview, setRepositoryReview] = useState<RepositoryReview | null>(null)
  const [submittingReview, setSubmittingReview] = useState(false)
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null)

  const reset = useCallback(() => {
    setRepositoryReview(null)
    setSubmissionMessage(null)
    setIntegration(null)
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

  const openPanel = useCallback(() => {
    setPanelOpen(true)
    void loadIntegration()
  }, [loadIntegration])

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
    try {
      const review = await requireRepositoryApi().getPullRequestReview(selector)
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

  const submitReview = useCallback(async (reviewEvent: PullRequestReviewEvent, body: string) => {
    if (repositoryReview?.kind !== 'github') return
    const pullRequest = repositoryReview.pullRequest
    const selector = repositoryReview.selector
    const actionLabel = reviewEvent === 'approve'
      ? 'approve'
      : reviewEvent === 'request-changes' ? 'request changes on' : 'comment on'
    if (!window.confirm(`Submit this review to GitHub and ${actionLabel} #${pullRequest.number}?`)) return

    setSubmittingReview(true)
    setSubmissionMessage(null)
    onError(null)
    try {
      await requireRepositoryApi().submitPullRequestReview(selector, reviewEvent, body)
      setIntegration(null)
      setSubmissionMessage('Review submitted to GitHub.')
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSubmittingReview(false)
    }
  }, [onError, repositoryReview])

  const closeReview = useCallback(() => {
    setRepositoryReview(null)
    setSubmissionMessage(null)
    onSelectPath(snapshot?.statuses[0]?.path ?? null)
  }, [onSelectPath, snapshot?.statuses])

  return {
    panelOpen,
    setPanelOpen,
    integration,
    loadingIntegration,
    actionKey,
    repositoryReview,
    submittingReview,
    submissionMessage,
    reset,
    loadIntegration,
    openPanel,
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
    closeReview
  }
}
