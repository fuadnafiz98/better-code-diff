import { describe, expect, it } from 'bun:test'

import { getDirectoryPaths } from './treeExpansion'

describe('getDirectoryPaths', () => {
  it('returns each parent directory once from shallowest to deepest', () => {
    expect(getDirectoryPaths([
      'src/renderer/App.tsx',
      'src/main/index.ts',
      'README.md'
    ])).toEqual([
      'src',
      'src/main',
      'src/renderer'
    ])
  })

  it('returns no directories for root files', () => {
    expect(getDirectoryPaths(['README.md', 'package.json'])).toEqual([])
  })
})
