import { IconCheck, IconClockArrow } from '@pierre/icons'

import type { ReviewCheckpoint } from './reviewCheckpoints'

interface ReviewCheckpointBarProps {
  checkpoint: ReviewCheckpoint | null
  changedFileCount: number
  removedFileCount: number
  reviewReady: boolean
  onSetCheckpoint(): void
  onOpenSince(): void
}

export function ReviewCheckpointBar({
  checkpoint,
  changedFileCount,
  removedFileCount,
  reviewReady,
  onSetCheckpoint,
  onOpenSince
}: ReviewCheckpointBarProps): React.JSX.Element {
  const checkpointLabel = checkpoint == null
    ? 'No review checkpoint'
    : `Checkpoint ${checkpoint.headOid.slice(0, 8)} · ${new Date(checkpoint.createdAt).toLocaleString()}`
  const sinceLabel = checkpoint == null
    ? 'Since unavailable'
    : changedFileCount === 0
      ? 'No files since checkpoint'
      : `${changedFileCount} since checkpoint${removedFileCount === 0 ? '' : ` · ${removedFileCount} removed`}`

  return (
    <div className="review-bar review-checkpoint-bar" role="status">
      <span title={checkpointLabel}><IconClockArrow />{checkpointLabel}</span>
      <div>
        <button
          className="bar-button"
          type="button"
          disabled={!reviewReady}
          title={reviewReady ? 'Save this complete patch as the review baseline' : 'Wait for the complete patch'}
          onClick={onSetCheckpoint}
        ><IconCheck />{checkpoint == null ? 'Set checkpoint' : 'Update checkpoint'}</button>
        <button
          className="bar-button"
          type="button"
          disabled={checkpoint == null || changedFileCount === 0}
          title={checkpoint == null ? 'Set a checkpoint first' : sinceLabel}
          onClick={onOpenSince}
        >{sinceLabel}</button>
      </div>
    </div>
  )
}
