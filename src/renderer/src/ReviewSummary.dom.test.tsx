import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'

afterEach(cleanup)

const orphan: ReviewSummaryEntry = {
  path: 'src/app.ts',
  thread: {
    id: 'thread-1', body: 'Keep this check.', lineNumber: 8,
    range: { start: 8, end: 8, side: 'additions' }, replies: [],
    resolved: false, orphaned: true
  }
}

test('keeps an orphan visible and requires reattach or drop', () => {
  const beginReattach = mock(() => {})
  const drop = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={beginReattach} onCancelReattach={() => {}} onDrop={drop} />)

  expect(screen.getByText('Orphaned')).toBeTruthy()
  expect(screen.getByText('The original lines no longer have one safe match.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reattach' }))
  expect(beginReattach).toHaveBeenCalledWith(orphan)
  fireEvent.click(screen.getByRole('button', { name: 'Drop' }))
  expect(drop).toHaveBeenCalledWith(orphan)
})

test('shows selection guidance while an orphan is being reattached', () => {
  const cancel = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId="thread-1"
    onBeginReattach={() => {}} onCancelReattach={cancel} onDrop={() => {}} />)

  expect(screen.getByText('Select replacement lines in any file.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(cancel).toHaveBeenCalledTimes(1)
})
