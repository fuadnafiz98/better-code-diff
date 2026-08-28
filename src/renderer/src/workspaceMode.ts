import type { RepositoryReview, RepositorySnapshot } from '../../shared/contracts'
import type { WorkspaceView } from './AppView'

/**
 * Review is the primary workspace whenever there is something to review.
 * A clean repository and a plain folder use the single-file surface as a file
 * browser instead of presenting an empty review.
 */
export function automaticWorkspaceView(
  snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses'>,
  repositoryReview: RepositoryReview | null
): WorkspaceView {
  return repositoryReview != null || (snapshot.kind === 'git' && snapshot.statuses.length > 0)
    ? 'multi'
    : 'file'
}

export function workspaceViewForTreePath(
  currentView: WorkspaceView,
  pathIsInReview: boolean,
  hasEditSession: boolean
): WorkspaceView {
  if (hasEditSession) return currentView
  return pathIsInReview ? 'multi' : 'file'
}
