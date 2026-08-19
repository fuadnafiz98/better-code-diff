import { describe, expect, it } from 'bun:test'

import { getDirectoryPaths, getTreeFollowBehavior, orderPathsForTree } from './treeExpansion'

describe('getTreeFollowBehavior', () => {
  it('centers the active file when the review scroll drives the tree', () => {
    expect(getTreeFollowBehavior('review-scroll')).toEqual({ offset: 'center', animate: true })
  })

  it('does not recenter the tree during direct navigation', () => {
    expect(getTreeFollowBehavior('direct-navigation')).toEqual({ offset: 'nearest', animate: false })
  })
})

describe('orderPathsForTree', () => {
  it('matches the tree natural folders-first order', () => {
    expect(orderPathsForTree([
      'src/page10.tsx',
      'README.md',
      'app/page.tsx',
      'src/page2.tsx',
      'package.json'
    ])).toEqual([
      'app/page.tsx',
      'src/page2.tsx',
      'src/page10.tsx',
      'package.json',
      'README.md'
    ])
  })
})

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
