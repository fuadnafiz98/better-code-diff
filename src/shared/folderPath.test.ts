import { describe, expect, test } from 'bun:test'

import { displayUserPath, folderNameFromPath, highlightPathMatches } from './folderPath.js'

describe('folderNameFromPath', () => {
  test('returns the last path segment', () => {
    expect(folderNameFromPath('/Users/me/Developer/echo')).toBe('echo')
    expect(folderNameFromPath('/Users/me/Developer/echo/')).toBe('echo')
  })
})

describe('displayUserPath', () => {
  test('replaces the home prefix with a tilde', () => {
    expect(displayUserPath('/Users/me/Developer/echo', '/Users/me')).toBe('~/Developer/echo')
    expect(displayUserPath('/Users/me', '/Users/me')).toBe('~')
    expect(displayUserPath('/opt/echo', '/Users/me')).toBe('/opt/echo')
  })
})

describe('highlightPathMatches', () => {
  test('highlights a contiguous substring first', () => {
    expect(highlightPathMatches('~/Developer/personal/echo', 'echo')).toEqual([
      { text: '~/Developer/personal/', match: false },
      { text: 'echo', match: true }
    ])
  })

  test('falls back to subsequence matches', () => {
    expect(highlightPathMatches('echo', 'eo')).toEqual([
      { text: 'e', match: true },
      { text: 'ch', match: false },
      { text: 'o', match: true }
    ])
  })

  test('returns the whole string when nothing matches', () => {
    expect(highlightPathMatches('~/Developer/echo', 'zzz')).toEqual([
      { text: '~/Developer/echo', match: false }
    ])
  })
})
