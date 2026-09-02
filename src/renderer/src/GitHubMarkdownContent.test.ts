import { describe, expect, test } from 'bun:test'

import { isExternalMarkdownHref, resolveGitHubHref } from './GitHubMarkdownContent'

describe('markdown hrefs', () => {
  test('maps GitHub root-relative paths and leaves local paths alone', () => {
    expect(resolveGitHubHref('/owner/repo')).toBe('https://github.com/owner/repo')
    expect(resolveGitHubHref('https://example.com')).toBe('https://example.com')
    expect(resolveGitHubHref('./notes.md')).toBe('./notes.md')
  })

  test('treats http and mailto as external', () => {
    expect(isExternalMarkdownHref('https://example.com')).toBe(true)
    expect(isExternalMarkdownHref('mailto:dev@example.com')).toBe(true)
    expect(isExternalMarkdownHref('./notes.md')).toBe(false)
    expect(isExternalMarkdownHref('#heading')).toBe(false)
  })
})
