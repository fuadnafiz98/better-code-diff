import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import { createReviewCommentAnchor } from './reviewThreadAnchors'
import { createPatchReviewItems } from './reviewItems'
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { reviewThreadStorageKey } from './reviewThreadStorage'
import { useReviewSession } from './useReviewSession'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function item(contents: string, newOid: string) {
  const lines = contents.split('\n')
  const patch = `diff --git a/a.ts b/a.ts\nindex ${'1'.repeat(40)}..${newOid} 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
  return createPatchReviewItems<ReviewAnnotationMetadata>(patch, newOid)[0]!
}

test('reanchors stored threads when a complete Patch snapshot changes', async () => {
  const before = item('first\ntarget\nlast', '2'.repeat(40))
  const after = item('inserted\nfirst\ntarget\nlast', '3'.repeat(40))
  const range = { start: 2, end: 2, side: 'additions' as const }
  const thread: ReviewThread = {
    id: 'thread-1', body: 'Check this.', lineNumber: 2, side: 'additions', range,
    anchor: createReviewCommentAnchor(before, range) ?? undefined,
    replies: [], resolved: false
  }

  localStorage.setItem(reviewThreadStorageKey('/repo', 'review-1'), JSON.stringify({ 'a.ts': [thread] }))
  const { result } = renderHook(() => useReviewSession('/repo', 'review-1', {
    items: [after],
    loading: false,
    enabled: true
  }))

  await waitFor(() => expect(result.current.threadsByPath['a.ts']?.[0]?.range.start).toBe(3))
  expect(result.current.threadsByPath['a.ts']?.[0]?.orphaned).toBe(false)
})
