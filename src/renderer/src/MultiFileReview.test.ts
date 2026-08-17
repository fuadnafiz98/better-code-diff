import { describe, expect, test } from 'bun:test'

import type { CodeViewItem } from '@pierre/diffs'

import { findActiveReviewItemId, mergeReviewItems } from './reviewItems'

describe('multi-file review items', () => {
  test('replaces duplicate IDs instead of passing duplicates to CodeView', () => {
    const first = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'old', cacheKey: 'old' } } as CodeViewItem
    const replacement = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'new', cacheKey: 'new' } } as CodeViewItem
    const merged = mergeReviewItems([first], [replacement])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(replacement)
  })
})

describe('multi-file explorer synchronization', () => {
  const positions = [
    { id: 'review:first.ts', top: 160 },
    { id: 'review:second.ts', top: 640 },
    { id: 'review:third.ts', top: 1_120 }
  ]

  test('keeps the first item active while the review summary is visible', () => {
    expect(findActiveReviewItemId(0, positions)).toBe('review:first.ts')
  })

  test('changes the active item after crossing a file boundary', () => {
    expect(findActiveReviewItemId(600, positions)).toBe('review:second.ts')
    expect(findActiveReviewItemId(1_080, positions)).toBe('review:third.ts')
  })
})
