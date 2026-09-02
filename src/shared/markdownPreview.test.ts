import { describe, expect, test } from 'bun:test'

import { isMarkdownPath } from './markdownPreview.js'

describe('isMarkdownPath', () => {
  test('accepts common markdown extensions', () => {
    expect(isMarkdownPath('docs/plan.md')).toBe(true)
    expect(isMarkdownPath('README.markdown')).toBe(true)
    expect(isMarkdownPath('notes.MDOWN')).toBe(true)
    expect(isMarkdownPath('C:\\repo\\GUIDE.MD')).toBe(true)
  })

  test('rejects source and MDX', () => {
    expect(isMarkdownPath('src/app.ts')).toBe(false)
    expect(isMarkdownPath('page.mdx')).toBe(false)
    expect(isMarkdownPath('md')).toBe(false)
    expect(isMarkdownPath('.md')).toBe(false)
  })
})
