import { describe, expect, test } from 'bun:test'

import { includesPath, samePathList } from './snapshotPaths'

describe('includesPath', () => {
  const paths = ['a.ts', 'src/App.tsx', 'src/b.ts', 'src/nested/c.ts', 'z.ts']

  test('finds every member of a sorted list', () => {
    for (const path of paths) expect(includesPath(paths, path)).toBe(true)
  })

  test('rejects paths that are not present', () => {
    expect(includesPath(paths, 'src/missing.ts')).toBe(false)
    expect(includesPath(paths, '')).toBe(false)
    expect(includesPath([], 'a.ts')).toBe(false)
  })

  test('still finds members when the list is not sorted', () => {
    const unsorted = ['z.ts', 'a.ts', 'src/b.ts']
    for (const path of unsorted) expect(includesPath(unsorted, path)).toBe(true)
    expect(includesPath(unsorted, 'q.ts')).toBe(false)
  })
})

describe('samePathList', () => {
  test('is true for the same identity', () => {
    const paths = ['a', 'b']
    expect(samePathList(paths, paths)).toBe(true)
  })

  test('is true for equal contents in equal order', () => {
    expect(samePathList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(samePathList([], [])).toBe(true)
  })

  test('is false when length or contents differ', () => {
    expect(samePathList(['a'], ['a', 'b'])).toBe(false)
    expect(samePathList(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(samePathList(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})
