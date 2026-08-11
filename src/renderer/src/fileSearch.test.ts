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
})
