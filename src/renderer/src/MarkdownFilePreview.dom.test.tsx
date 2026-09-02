import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { stripMarkdownFrontmatter } from './documentView'
import { MarkdownFilePreview } from './MarkdownFilePreview'

afterEach(cleanup)

test('renders headings, tables, and local links without leaving the file', () => {
  render(<MarkdownFilePreview source={`# Current state

A [local note](./notes.md) and an [issue](https://example.com/issue).

| Layer | Status |
| --- | --- |
| Viewer | Live |
`} />)

  expect(screen.getByRole('heading', { name: 'Current state' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Layer' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'Live' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'issue' }).getAttribute('target')).toBe('_blank')
  expect(screen.getByRole('link', { name: 'local note' }).getAttribute('href')).toBe('./notes.md')
})

test('does not render YAML frontmatter as preview prose', () => {
  render(<MarkdownFilePreview source={stripMarkdownFrontmatter(`---
name: add-dark-mode
description: Add dark mode with colors, shadows, and surfaces.
---

# Add Dark Mode

Activation notes.
`)} />)

  expect(screen.getByRole('heading', { name: 'Add Dark Mode' })).toBeTruthy()
  expect(screen.queryByText(/add-dark-mode/)).toBeNull()
  expect(screen.queryByText(/name:/)).toBeNull()
  expect(screen.queryByText(/description:/)).toBeNull()
})
