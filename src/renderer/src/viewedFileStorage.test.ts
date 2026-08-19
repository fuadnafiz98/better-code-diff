import { describe, expect, it } from 'bun:test'
import type { CodeViewItem } from '@pierre/diffs'

import {
  dropChangedViewedFiles,
  findStaleViewedPaths,
  markViewedFile,
  parseStoredViewedFiles,
  reviewFileSignature,
  viewedFileStorageKey
} from './viewedFileStorage'

function diffItem(path: string, objectId: string | undefined, additions: string[] = ['+a']): CodeViewItem<unknown> {
  return {
    id: `review:${path}`,
    type: 'diff',
    fileDiff: {
      name: path,
      type: 'modified',
      newObjectId: objectId,
      prevObjectId: objectId == null ? undefined : 'old-oid',
      additionLines: additions,
      deletionLines: []
    }
  } as unknown as CodeViewItem<unknown>
}

describe('viewedFileStorageKey', () => {
  it('scopes keys by repository root and review identity', () => {
    expect(viewedFileStorageKey('/repo', 'working-tree'))
      .toBe('better-code-diff:viewed-files:/repo:working-tree')
    expect(viewedFileStorageKey('/repo', 'commit:abc'))
      .not.toBe(viewedFileStorageKey('/repo', 'working-tree'))
  })
})

describe('parseStoredViewedFiles', () => {
  it('round-trips path to signature maps', () => {
    expect(parseStoredViewedFiles(JSON.stringify({ 'src/a.ts': 'sig-1' })))
      .toEqual({ 'src/a.ts': 'sig-1' })
  })

  it('returns an empty map for missing or corrupt payloads', () => {
    expect(parseStoredViewedFiles(null)).toEqual({})
    expect(parseStoredViewedFiles('not json')).toEqual({})
    expect(parseStoredViewedFiles('[1,2]')).toEqual({})
    expect(parseStoredViewedFiles('42')).toEqual({})
  })

  it('drops entries without a usable signature', () => {
    const stored = JSON.stringify({ 'src/a.ts': 'sig-1', 'src/b.ts': '', 'src/c.ts': 7, '': 'sig-2' })
    expect(parseStoredViewedFiles(stored)).toEqual({ 'src/a.ts': 'sig-1' })
  })
})

describe('reviewFileSignature', () => {
  it('prefers Git object ids so the signature tracks content', () => {
    expect(reviewFileSignature(diffItem('src/a.ts', 'new-oid'))).toBe('old-oid..new-oid')
  })

  it('falls back to patch line counts when object ids are absent', () => {
    expect(reviewFileSignature(diffItem('src/a.ts', undefined, ['+a', '+b'])))
      .toBe('modified:2:0')
  })
})

describe('markViewedFile', () => {
  it('stores the signature of the file at the moment it was marked', () => {
    expect(markViewedFile({}, diffItem('src/a.ts', 'new-oid')))
      .toEqual({ 'src/a.ts': 'old-oid..new-oid' })
  })
})

describe('findStaleViewedPaths', () => {
  it('reports viewed files whose content signature moved on', () => {
    const signatures = { 'src/a.ts': 'old-oid..new-oid', 'src/b.ts': 'old-oid..b-oid' }
    const items = [diffItem('src/a.ts', 'newer-oid'), diffItem('src/b.ts', 'b-oid')]
    expect(findStaleViewedPaths(signatures, items)).toEqual(['src/a.ts'])
  })

  it('ignores files that were never marked viewed', () => {
    expect(findStaleViewedPaths({}, [diffItem('src/a.ts', 'new-oid')])).toEqual([])
  })
})

describe('dropChangedViewedFiles', () => {
  it('removes changed paths and keeps the rest', () => {
    const signatures = { 'src/a.ts': 'sig-a', 'src/b.ts': 'sig-b' }
    expect(dropChangedViewedFiles(signatures, ['src/a.ts'])).toEqual({ 'src/b.ts': 'sig-b' })
  })

  it('returns the same object when nothing changed', () => {
    const signatures = { 'src/a.ts': 'sig-a' }
    expect(dropChangedViewedFiles(signatures, ['src/z.ts'])).toBe(signatures)
  })
})
