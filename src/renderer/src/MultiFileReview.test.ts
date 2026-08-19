import { describe, expect, test } from 'bun:test'

import type { CodeViewItem } from '@pierre/diffs'

import { deriveAnnotatedReviewItems, planAnnotatedReviewItemMutations } from './annotatedReviewItems'
import { findActiveReviewItemId, mergeReviewItems, orderReviewItems } from './reviewItems'
import type { ReviewAnnotationMetadata } from './ReviewComments'

describe('multi-file review items', () => {
  test('replaces duplicate IDs instead of passing duplicates to CodeView', () => {
    const first = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'old', cacheKey: 'old' } } as CodeViewItem
    const replacement = { id: 'review:file.ts', type: 'file', file: { name: 'file.ts', contents: 'new', cacheKey: 'new' } } as CodeViewItem
    const merged = mergeReviewItems([first], [replacement])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(replacement)
  })

  test('follows the explorer path order instead of patch order', () => {
    const first = { id: 'review:src/page10.tsx', type: 'file' } as CodeViewItem
    const second = { id: 'review:app/page.tsx', type: 'file' } as CodeViewItem
    const third = { id: 'review:src/page2.tsx', type: 'file' } as CodeViewItem

    expect(orderReviewItems(
      [first, second, third],
      ['app/page.tsx', 'src/page2.tsx', 'src/page10.tsx']
    )).toEqual([second, third, first])
  })

  test('keeps unaffected item identities stable when one annotation changes', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: `review:file-${index}.ts`,
      type: 'file',
      file: { name: `file-${index}.ts`, contents: `${index}`, cacheKey: `${index}` }
    })) as CodeViewItem<ReviewAnnotationMetadata>[]
    const common = {
      items,
      threadsByPath: {},
      remoteThreadsByPath: new Map(),
      draftComment: null,
      pendingSelection: null,
      collapsedItemIds: new Set<string>()
    }
    const initial = deriveAnnotatedReviewItems({
      ...common,
      annotationVersions: {},
      previousCache: new Map()
    })
    const next = deriveAnnotatedReviewItems({
      ...common,
      annotationVersions: { 'file-25.ts': 1 },
      previousCache: initial.cache
    })

    const changedIndexes = next.items.flatMap((item, index) => item === initial.items[index] ? [] : [index])
    expect(changedIndexes).toEqual([25])

    const mutations = planAnnotatedReviewItemMutations(
      next.items,
      new Map(initial.items.map((item) => [item.id, item])),
      () => true
    )
    expect(mutations.additions).toHaveLength(0)
    expect(mutations.updates).toEqual([next.items[25]!])
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
