import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PullRequestReviewBar } from './PullRequestReviewBar'

afterEach(cleanup)

test('blocks review submission until orphaned comments are handled', () => {
  const submit = mock(async () => true)
  render(<PullRequestReviewBar submitting={false} message={null} inlineCommentCount={0}
    orphanedCommentCount={1} viewerCanSubmitDecision={true} onOpen={() => {}} onSubmit={submit} />)

  expect(screen.getByText('1 orphaned comment needs attention')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Submit Review' }))
  expect(screen.getByText('1 orphaned comment must be reattached or dropped before submission.')).toBeTruthy()
  const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
  expect(approve.disabled).toBe(true)
  fireEvent.click(approve)
  expect(submit).not.toHaveBeenCalled()
})

test('keeps approval available when there are no orphans', () => {
  render(<PullRequestReviewBar submitting={false} message={null} inlineCommentCount={0}
    orphanedCommentCount={0} viewerCanSubmitDecision={true} onOpen={() => {}} onSubmit={async () => true} />)

  fireEvent.click(screen.getByRole('button', { name: 'Submit Review' }))
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
})
