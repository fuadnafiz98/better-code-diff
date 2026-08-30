import { describe, expect, test } from 'bun:test'

import { parseDiffGitHeaderPaths } from './patchHeaders.js'

describe('parseDiffGitHeaderPaths', () => {
  test('reads plain and space-containing paths', () => {
    expect(parseDiffGitHeaderPaths('diff --git a/src/a.ts b/src/a.ts'))
      .toEqual({ previousPath: 'src/a.ts', path: 'src/a.ts' })
    expect(parseDiffGitHeaderPaths('diff --git "a/dir/a b.ts" "b/dir/a b.ts"'))
      .toEqual({ previousPath: 'dir/a b.ts', path: 'dir/a b.ts' })
  })

  test('decodes escaped quotes, backslashes, and UTF-8 octal bytes', () => {
    expect(parseDiffGitHeaderPaths(
      'diff --git "a/dir/a\\"b\\\\c-\\303\\251.ts" "b/dir/a\\"b\\\\c-\\303\\251.ts"'
    )).toEqual({ previousPath: 'dir/a"b\\c-é.ts', path: 'dir/a"b\\c-é.ts' })
  })

  test('rejects incomplete headers', () => {
    expect(parseDiffGitHeaderPaths('diff --git "a/missing b/missing')).toBeNull()
    expect(parseDiffGitHeaderPaths('not a diff header')).toBeNull()
  })
})
