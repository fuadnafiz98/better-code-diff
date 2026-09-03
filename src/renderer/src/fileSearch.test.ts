import { describe, expect, it } from 'bun:test'

import { createFileSearchIndex, rankFilePaths } from './fileSearch'

describe('rankFilePaths', () => {
  it('prioritizes filename matches and handles case-insensitive queries', () => {
    const index = createFileSearchIndex([
      'docs/application-notes.md',
      'src/App.tsx',
      'src/components/AppPanel.tsx',
      'src/components/Button.tsx'
    ])

    expect(rankFilePaths(index, 'APP')).toEqual([
      'src/App.tsx',
      'src/components/AppPanel.tsx',
      'docs/application-notes.md'
    ])
  })

  it('returns a bounded set for broad searches', () => {
    const paths = Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`)

    const results = rankFilePaths(createFileSearchIndex(paths), 'file', 25)

    expect(results).toHaveLength(25)
    expect(results[0]).toBe('src/file-0.ts')
  })

  it('ranks review files ahead of other matches', () => {
    const index = createFileSearchIndex([
      'apps/data-platform/src/apps/files/service.py',
      'apps/data-platform/src/apps/storage_backends/service.py',
      'apps/aim2-backend/src/services/jobs.py',
      'apps/aim2-backend/src/services/analytics.py',
      'apps/web/src/services/test_heatmap_service.py'
    ])
    const reviewPaths = new Set(['apps/web/src/services/test_heatmap_service.py'])

    expect(rankFilePaths(index, 'service', 80, reviewPaths)[0]).toBe(
      'apps/web/src/services/test_heatmap_service.py'
    )
    expect(rankFilePaths(index, 'service', 80)[0]).toBe(
      'apps/data-platform/src/apps/files/service.py'
    )
  })

  it('keeps review files first when the result set is bounded', () => {
    const reviewPaths = new Set(['src/z-review-file.ts'])
    const paths = [
      'src/z-review-file.ts',
      ...Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`)
    ]

    expect(rankFilePaths(createFileSearchIndex(paths), 'file', 8, reviewPaths)).toEqual([
      'src/z-review-file.ts',
      'src/file-0.ts',
      'src/file-1.ts',
      'src/file-2.ts',
      'src/file-3.ts',
      'src/file-4.ts',
      'src/file-5.ts',
      'src/file-6.ts'
    ])
  })
})
