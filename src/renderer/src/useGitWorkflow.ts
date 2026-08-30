import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  GitIntegrationSnapshot,
  PullRequestInboxSnapshot,
  PullRequestMergeStrategy,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  PullRequestSummary,
  RepositorySnapshot
} from '../../shared/contracts'
import type { WorkspaceView } from './AppView'
import type { ConfirmRequest } from './ConfirmDialog'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import { automaticWorkspaceView } from './workspaceMode'
import { useReviewWorlds, type ReviewWorld } from './useReviewWorlds'
import {
  compareReviewCheckpoint,
  createReviewCheckpoint,
  createSinceReview,
  loadReviewCheckpoint,
  saveReviewCheckpoint
} from './reviewCheckpoints'

interface UseGitWorkflowOptions {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  applySnapshot(snapshot: RepositorySnapshot): void
  activateSnapshot(snapshot: RepositorySnapshot | null): void
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
  root: string | null
  head: string | null
  branch: string | null
}

const emptyEntry = <Value,>(): PanelCacheEntry<Value> => ({
  data: null,
  fetchedAt: 0,
  root: null,
  head: null,
  branch: null
})

export function isPanelDataStale(
  entry: PanelCacheEntry<unknown>,
  snapshot: { root?: string | null; head: string | null; branch: string | null } | null,
  now: number,
  ttlMs: number = GIT_PANEL_TTL_MS
): boolean {
  if (entry.data == null) return true
  if (snapshot != null && entry.root !== (snapshot.root ?? null)) return true
  if (snapshot != null && (entry.head !== snapshot.head || entry.branch !== snapshot.branch)) return true
  return now - entry.fetchedAt >= ttlMs
}

export function useGitWorkflow({
  snapshot,
  selectedPath,
  workspaceView,
  applySnapshot,
  activateSnapshot,
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
  const [submittingReview, setSubmittingReview] = useState(false)
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null)
  const [checkpointRevision, setCheckpointRevision] = useState(0)
  const reviewWorlds = useReviewWorlds({
    snapshot,
    selectedPath,
    workspaceView,
    onActivateSnapshot: activateSnapshot,
    onActivateRepository: (root) => requireRepositoryApi().activateRepository(root),
    onReleaseRepository: (root) => requireRepositoryApi().releaseRepository(root),
    onActivationError: (error) => onError(getErrorMessage(error)),
    onSelectPath,
    onWorkspaceViewChange
  })
  const repositoryReview = reviewWorlds.activeReview
  const activePatchReview = reviewWorlds.activeWorld?.source === 'patch'
    && reviewWorlds.activeWorld.review.kind === 'github'
    ? reviewWorlds.activeWorld.review
    : null
  const activePullRequestUrl = activePatchReview?.pullRequest.url ?? null
  const root = snapshot?.root ?? null
  const reviewCheckpoint = useMemo(() => root == null || activePullRequestUrl == null
    ? null
    : loadReviewCheckpoint(root, activePullRequestUrl), [activePullRequestUrl, checkpointRevision, root])
  const checkpointComparison = useMemo(() => reviewCheckpoint == null || activePatchReview == null
    ? null
    : compareReviewCheckpoint(reviewCheckpoint, activePatchReview.files), [activePatchReview, reviewCheckpoint])
  const reviewReady = reviewWorlds.activeWorld?.source === 'patch'
    && reviewWorlds.activeWorld.loadStatus === 'ready'

  const head = snapshot?.head ?? null
  const branch = snapshot?.branch ?? null
  const integration = integrationEntry.root === root ? integrationEntry.data : null
  const inbox = inboxEntry.root === root ? inboxEntry.data : null
  const reviewGenerationRef = useRef(0)
  const reviewRequestsRef = useRef(new Map<string, { root: string; originWorldId: string | null }>())
  const restoringWorldsRef = useRef(new Set<string>())
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
    for (const [requestId, request] of reviewRequestsRef.current) {
      requireRepositoryApi().cancelPullRequestReview(request.root, requestId)
    }
    reviewRequestsRef.current.clear()
    reviewWorlds.reset()
    setSubmissionMessage(null)
    writeIntegrationEntry(emptyEntry())
    writeInboxEntry(emptyEntry())
    setPanelOpen(false)
  }, [reviewWorlds.reset, writeInboxEntry, writeIntegrationEntry])

  const loadIntegration = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(integrationEntryRef.current, { root, head, branch }, Date.now())) return
    setLoadingIntegration(true)
    onError(null)
    try {
      const data = await requireRepositoryApi().getGitIntegration()
      writeIntegrationEntry({ data, fetchedAt: Date.now(), root, head, branch })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoadingIntegration(false)
    }
  }, [branch, head, onError, root, writeIntegrationEntry])

  const loadInbox = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(inboxEntryRef.current, { root, head, branch }, Date.now())) return
    setLoadingInbox(true)
    try {
      const data = await requireRepositoryApi().getPullRequestInbox()
      writeInboxEntry({ data, fetchedAt: Date.now(), root, head, branch })
    } catch (error) {
      writeInboxEntry({
        data: { available: false, message: getErrorMessage(error), sections: [] },
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
    } finally {
      setLoadingInbox(false)
    }
  }, [branch, head, root, writeInboxEntry])

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
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      reviewWorlds.focusDesk(nextSnapshot.statuses[0]?.path ?? null, nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, onError, reviewWorlds.focusDesk])

  const openPullRequestReview = useCallback(async (
    selector: number | string,
    repositorySnapshot: RepositorySnapshot | null = snapshot,
    originWorldId = reviewWorlds.activeWorld?.worldId ?? null
  ) => {
    if (repositorySnapshot == null || repositorySnapshot.kind !== 'git') {
      onError('Open a Git repository before opening a pull request.')
      return
    }
    const generation = ++reviewGenerationRef.current
    const requestId = crypto.randomUUID()
    reviewRequestsRef.current.set(requestId, { root: repositorySnapshot.root, originWorldId })
    setActionKey(`review:${selector}`)
    onError(null)
    // A large review is streamed: its metadata opens the view, then each page of
    // files is appended. Waiting for the whole fetch left the app on a spinner for
    // minutes on pull requests with thousands of files.
    let streamed = false
    let worldId: string | null = null
    const stopListening = requireRepositoryApi().onPullRequestReviewProgress((progress) => {
      if (progress.requestId !== requestId || progress.root !== repositorySnapshot.root) return
      if (!reviewRequestsRef.current.has(requestId)) return
      if (progress.kind === 'metadata') {
        streamed = true
        worldId = reviewWorlds.openPatchWorld(
          repositorySnapshot,
          progress.review,
          generation,
          true,
          requestId,
          originWorldId
        )
        setSubmissionMessage(null)
        setPanelOpen(false)
        setActionKey((current) => current === `review:${selector}` ? null : current)
        return
      }
      if (worldId == null) return
      reviewWorlds.appendPatchPage(worldId, generation, progress)
      const firstPath = progress.files[0]?.path
      if (firstPath != null) reviewWorlds.selectInitialPath(worldId, firstPath)
    })
    try {
      const review = await requireRepositoryApi().getPullRequestReview(
        repositorySnapshot.root,
        selector,
        requestId
      )
      if (!reviewRequestsRef.current.has(requestId)) return
      if (streamed) {
        // The resolved review is authoritative: progress events and the reply to
        // this call are separate IPC messages, so a late page can land after the
        // listener is gone. Its patch shares the streamed prefix, so adopting it
        // only costs parsing whatever tail was missed. The expected count becomes
        // what actually arrived — GitHub's own number can exceed what its files API
        // will serve, and nothing is still loading once the fetch has finished.
        if (worldId != null) {
          reviewWorlds.replacePatchReview(worldId, generation, {
            ...review,
            expectedFileCount: review.files.length
          })
          reviewWorlds.setPatchLoadStatus(worldId, generation, 'ready')
        }
        return
      }
      worldId = reviewWorlds.openPatchWorld(
        repositorySnapshot,
        review,
        generation,
        false,
        requestId,
        originWorldId
      )
      setSubmissionMessage(null)
      setPanelOpen(false)
    } catch (error) {
      if (reviewRequestsRef.current.has(requestId)) onError(getErrorMessage(error))
      // The stream is dead either way, so collapse the target onto what actually
      // arrived — otherwise the review sits there looking like it is still loading
      // until the 25 s stall backstop fires.
      if (streamed && reviewRequestsRef.current.has(requestId) && worldId != null) {
        reviewWorlds.setPatchLoadStatus(worldId, generation, 'error')
      }
    } finally {
      stopListening()
      reviewRequestsRef.current.delete(requestId)
      setActionKey((current) => current === `review:${selector}` ? null : current)
    }
  }, [onError, reviewWorlds.activeWorld, reviewWorlds.appendPatchPage, reviewWorlds.openPatchWorld,
    reviewWorlds.replacePatchReview, reviewWorlds.selectInitialPath, reviewWorlds.setPatchLoadStatus,
    snapshot])

  const openPullRequestFromLocator = useCallback(async (pullRequestUrl: string): Promise<boolean> => {
    const originWorldId = reviewWorlds.activeWorld?.worldId
    reviewWorlds.setNewWorldPending(true, pullRequestUrl, originWorldId)
    setActionKey('resolve:pull-request')
    onError(null)
    try {
      const repositorySnapshot = await requireRepositoryApi().resolvePullRequestRepository(pullRequestUrl)
      if (repositorySnapshot == null) return false
      if (!reviewWorlds.hasWorld(originWorldId)) {
        if (!reviewWorlds.hasRepositoryRoot(repositorySnapshot.root)) {
          await requireRepositoryApi().releaseRepository(repositorySnapshot.root)
        }
        return false
      }
      if (reviewWorlds.isWorldActive(originWorldId)) {
        await requireRepositoryApi().activateRepository(repositorySnapshot.root)
      }
      await openPullRequestReview(pullRequestUrl, repositorySnapshot, originWorldId ?? null)
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      reviewWorlds.setNewWorldPending(false, '', originWorldId)
      setActionKey((current) => current === 'resolve:pull-request' ? null : current)
    }
  }, [onError, openPullRequestReview, reviewWorlds.activeWorld, reviewWorlds.hasRepositoryRoot,
    reviewWorlds.hasWorld, reviewWorlds.isWorldActive, reviewWorlds.setNewWorldPending])

  const restoreReleasedWorld = useCallback((world: ReviewWorld | null | undefined): void => {
    if (world?.source !== 'patch' || world.loadStatus !== 'released'
      || world.review.kind !== 'github' || restoringWorldsRef.current.has(world.worldId)) return
    restoringWorldsRef.current.add(world.worldId)
    void openPullRequestReview(world.review.pullRequest.url, world.snapshot, world.worldId)
      .finally(() => restoringWorldsRef.current.delete(world.worldId))
  }, [openPullRequestReview])

  const focusWorld = useCallback(async (worldId: string): Promise<boolean> => {
    const world = reviewWorlds.worlds.find((candidate) => candidate.worldId === worldId)
    const focused = await reviewWorlds.focusWorld(worldId)
    if (focused) restoreReleasedWorld(world)
    return focused
  }, [restoreReleasedWorld, reviewWorlds.focusWorld, reviewWorlds.worlds])

  const cycleWorld = useCallback((direction: -1 | 1): void => {
    const activeWorldId = reviewWorlds.activeWorld?.worldId
    if (activeWorldId == null || reviewWorlds.worlds.length < 2) return
    const index = reviewWorlds.worlds.findIndex((world) => world.worldId === activeWorldId)
    const nextIndex = (index + direction + reviewWorlds.worlds.length) % reviewWorlds.worlds.length
    const nextWorld = reviewWorlds.worlds[nextIndex]
    if (nextWorld != null) void focusWorld(nextWorld.worldId)
  }, [focusWorld, reviewWorlds.activeWorld, reviewWorlds.worlds])

  const reviewPullRequest = useCallback((pullRequest: PullRequestSummary) => {
    return openPullRequestReview(pullRequest.number)
  }, [openPullRequestReview])

  const reviewLocalBranch = useCallback(async (baseRef: string, headRef: string) => {
    if (snapshot == null) return
    const repositorySnapshot = snapshot
    const originWorldId = reviewWorlds.activeWorld?.worldId ?? null
    const generation = ++reviewGenerationRef.current
    setActionKey(`compare:${headRef}`)
    onError(null)
    try {
      const review = await requireRepositoryApi().getLocalBranchReview(baseRef, headRef)
      reviewWorlds.openPatchWorld(repositorySnapshot, review, generation, false, null, originWorldId)
      setSubmissionMessage(null)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey((current) => current === `compare:${headRef}` ? null : current)
    }
  }, [onError, reviewWorlds.activeWorld, reviewWorlds.openPatchWorld, snapshot])

  const reviewCommit = useCallback(async (oid: string) => {
    if (snapshot == null) return
    const repositorySnapshot = snapshot
    const originWorldId = reviewWorlds.activeWorld?.worldId ?? null
    const generation = ++reviewGenerationRef.current
    setActionKey(`commit:${oid}`)
    onError(null)
    try {
      const review = await requireRepositoryApi().getCommitReview(oid)
      reviewWorlds.openPatchWorld(repositorySnapshot, review, generation, false, null, originWorldId)
      setSubmissionMessage(null)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey((current) => current === `commit:${oid}` ? null : current)
    }
  }, [onError, reviewWorlds.activeWorld, reviewWorlds.openPatchWorld, snapshot])

  const checkoutPullRequest = useCallback(async (pullRequest: PullRequestSummary) => {
    if (!(await confirmWorkingTreeChange('pull request checkout'))) return
    setActionKey(`checkout:${pullRequest.number}`)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().checkoutPullRequest(pullRequest.number)
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      reviewWorlds.focusDesk(nextSnapshot.statuses[0]?.path ?? null, nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, onError, reviewWorlds.focusDesk])

  const fetchRemote = useCallback(async () => {
    setActionKey('sync:fetch')
    onError(null)
    try {
      writeIntegrationEntry({
        data: await requireRepositoryApi().fetchRemote(),
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
      void loadInbox(true)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, loadInbox, onError, root, writeIntegrationEntry])

  const pullCurrentBranch = useCallback(async () => {
    if (!(await confirmWorkingTreeChange('pull'))) return
    setActionKey('sync:pull')
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().pullCurrentBranch()
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      reviewWorlds.focusDesk(nextSnapshot.statuses[0]?.path ?? null, nextView)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, loadInbox, loadIntegration, onError, reviewWorlds.focusDesk])

  const pushCurrentBranch = useCallback(async () => {
    setActionKey('sync:push')
    onError(null)
    try {
      writeIntegrationEntry({
        data: await requireRepositoryApi().pushCurrentBranch(),
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, onError, root, writeIntegrationEntry])

  const persistCheckpoint = useCallback((review: typeof activePatchReview): boolean => {
    if (root == null || review == null) return false
    const saved = saveReviewCheckpoint(root, createReviewCheckpoint(review))
    if (saved) setCheckpointRevision((revision) => revision + 1)
    return saved
  }, [root])

  const setReviewCheckpoint = useCallback(() => {
    if (activePatchReview == null) return
    if (!reviewReady) {
      setSubmissionMessage('Wait for the complete patch before setting a checkpoint.')
      return
    }
    setSubmissionMessage(persistCheckpoint(activePatchReview)
      ? `Checkpoint set at ${activePatchReview.headOid.slice(0, 8)}.`
      : 'The checkpoint could not be saved locally.')
  }, [activePatchReview, persistCheckpoint, reviewReady])

  const openSinceReview = useCallback(() => {
    const activeWorld = reviewWorlds.activeWorld
    if (activeWorld?.source !== 'patch' || activeWorld.review.kind !== 'github') return
    if (reviewCheckpoint == null) {
      setSubmissionMessage('Set a checkpoint before opening Since.')
      return
    }
    const since = createSinceReview(activeWorld.review, reviewCheckpoint)
    if (since.review.files.length === 0 && since.removedPaths.length === 0) {
      setSubmissionMessage('No files changed since this checkpoint.')
      return
    }
    reviewWorlds.openSinceWorld(activeWorld.worldId, since, reviewCheckpoint)
  }, [reviewCheckpoint, reviewWorlds.activeWorld, reviewWorlds.openSinceWorld])

  const submitReview = useCallback(async (
    reviewEvent: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<boolean> => {
    if (repositoryReview?.kind !== 'github' || reviewWorlds.activeWorld?.source !== 'patch') return false
    if (reviewWorlds.activeWorld.loadStatus !== 'ready') {
      setSubmissionMessage('Wait for the complete patch before submitting a review.')
      return false
    }
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
      setSubmissionMessage(persistCheckpoint(repositoryReview)
        ? 'Review submitted to GitHub. Checkpoint advanced.'
        : 'Review submitted to GitHub, but the local checkpoint could not be saved.')
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setSubmittingReview(false)
    }
  }, [confirm, onError, persistCheckpoint, repositoryReview, reviewWorlds.activeWorld,
    writeInboxEntry, writeIntegrationEntry])

  const closeReview = useCallback((worldId?: string) => {
    const target = worldId == null
      ? reviewWorlds.activeWorld
      : reviewWorlds.worlds.find((world) => world.worldId === worldId)
    if (target == null) return
    if (target.source === 'patch' && target.loadStatus === 'loading' && target.requestId != null) {
      // Otherwise up to eight `gh api` children per wave keep paging a patch that
      // is already discarded.
      reviewRequestsRef.current.delete(target.requestId)
      requireRepositoryApi().cancelPullRequestReview(target.root, target.requestId)
    }
    if (target.source === 'new' && target.pending) {
      const roots = new Set<string>()
      for (const [requestId, request] of reviewRequestsRef.current) {
        if (request.originWorldId !== target.worldId) continue
        reviewRequestsRef.current.delete(requestId)
        roots.add(request.root)
        requireRepositoryApi().cancelPullRequestReview(request.root, requestId)
      }
      for (const root of roots) {
        const rootStillLoading = [...reviewRequestsRef.current.values()].some((request) => request.root === root)
        if (!rootStillLoading && !reviewWorlds.hasRepositoryRoot(root)) {
          void requireRepositoryApi().releaseRepository(root)
        }
      }
    }
    const closingActive = reviewWorlds.activeWorld?.worldId === target.worldId
    const targetIndex = reviewWorlds.worlds.findIndex((world) => world.worldId === target.worldId)
    const remainingWorlds = reviewWorlds.worlds.filter((world) => world.worldId !== target.worldId)
    const nextWorld = closingActive
      ? remainingWorlds[targetIndex - 1] ?? remainingWorlds[targetIndex]
      : null
    if (closingActive) setSubmissionMessage(null)
    void reviewWorlds.closeWorld(target.worldId).then((closed) => {
      if (closed) restoreReleasedWorld(nextWorld)
    })
  }, [reviewWorlds.activeWorld, reviewWorlds.closeWorld, reviewWorlds.hasRepositoryRoot,
    restoreReleasedWorld, reviewWorlds.worlds])

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
    worlds: reviewWorlds.worlds,
    activeWorld: reviewWorlds.activeWorld,
    initialReviewScrollTop: reviewWorlds.initialReviewScrollTop,
    repositoryReview,
    reviewCheckpoint,
    checkpointChangedFileCount: checkpointComparison == null
      ? 0
      : checkpointComparison.changedFiles.length + checkpointComparison.removedPaths.length,
    checkpointRemovedFileCount: checkpointComparison?.removedPaths.length ?? 0,
    reviewReady,
    submittingReview,
    submissionMessage,
    reset,
    loadIntegration,
    openPanel,
    openBranches,
    switchBranch,
    reviewPullRequest,
    openPullRequestReview,
    openPullRequestFromLocator,
    openNewWorld: reviewWorlds.openNewWorld,
    updateNewWorldLocator: reviewWorlds.updateNewWorldLocator,
    openWorkingTree: reviewWorlds.openDeskWorld,
    syncRepositorySnapshot: reviewWorlds.syncRepositorySnapshot,
    reviewLocalBranch,
    reviewCommit,
    checkoutPullRequest,
    fetchRemote,
    pullCurrentBranch,
    pushCurrentBranch,
    submitReview,
    setReviewCheckpoint,
    openSinceReview,
    closeReview,
    focusWorld,
    cycleWorld,
    rememberReviewScroll: reviewWorlds.rememberReviewScroll,
    mergePullRequest,
    markPullRequestReady
  }), [
    actionKey,
    reviewWorlds.activeWorld,
    cycleWorld,
    focusWorld,
    reviewWorlds.initialReviewScrollTop,
    reviewWorlds.openDeskWorld,
    reviewWorlds.openNewWorld,
    reviewWorlds.rememberReviewScroll,
    reviewWorlds.syncRepositorySnapshot,
    reviewWorlds.updateNewWorldLocator,
    reviewWorlds.worlds,
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
    openPullRequestFromLocator,
    panelOpen,
    panelTab,
    pullCurrentBranch,
    pushCurrentBranch,
    checkpointComparison,
    repositoryReview,
    reviewCheckpoint,
    reviewReady,
    reset,
    reviewCommit,
    reviewLocalBranch,
    reviewPullRequest,
    submissionMessage,
    setReviewCheckpoint,
    openSinceReview,
    submitReview,
    submittingReview,
    switchBranch
  ])
}
