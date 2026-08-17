import { describe, expect, it } from 'bun:test'

import { parsePullRequestSelector } from './pullRequestSelector'

describe('parsePullRequestSelector', () => {
  it('accepts a number and hash-prefixed number', () => {
    expect(parsePullRequestSelector('42')).toBe(42)
    expect(parsePullRequestSelector(' #42 ')).toBe(42)
  })

  it('accepts a GitHub pull request URL', () => {
    expect(parsePullRequestSelector('https://github.com/pierrecomputer/pierre/pull/123/files'))
      .toBe('https://github.com/pierrecomputer/pierre/pull/123/files')
  })

  it('rejects invalid and unsafe values', () => {
    expect(parsePullRequestSelector('pull request 42')).toBeNull()
    expect(parsePullRequestSelector('https://example.com/owner/repo/pull/42')).toBeNull()
    expect(parsePullRequestSelector('0')).toBeNull()
  })
})
