import { IconInReview, IconRefresh } from '@pierre/icons'

export function PullRequestLoadingIndicator(): React.JSX.Element {
  return (
    <div className="pr-loading-indicator" role="status" aria-live="polite">
      <span className="pr-loading-icon">
        <IconInReview />
        <IconRefresh className="spin" />
      </span>
      <span><strong>Loading pull request</strong><small>Preparing the multi-file review…</small></span>
    </div>
  )
}
