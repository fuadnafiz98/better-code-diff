import type { ReviewWorld } from './useReviewWorlds'

export function isPullRequestWorkspacePending(
  actionKey: string | null,
  activeWorld: ReviewWorld | null
): boolean {
  if (actionKey?.startsWith('review:') === true || actionKey === 'resolve:pull-request') {
    return true
  }
  return activeWorld?.source === 'patch'
    && activeWorld.loadStatus === 'loading'
    && activeWorld.review.files.length === 0
}
