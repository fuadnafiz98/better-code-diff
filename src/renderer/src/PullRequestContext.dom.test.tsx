import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { PullRequestConversation } from '../../shared/contracts'
import { PullRequestContext } from './PullRequestContext'

afterEach(cleanup)

const conversation: PullRequestConversation = {
  available: true,
  message: null,
  body: '',
  threads: [],
  reviews: [{
    id: 'review-1',
    state: 'COMMENTED',
    authorLogin: 'reviewer',
    submittedAt: null,
    body: [
      '<details><summary>Files reviewed</summary>',
      '',
      '| File | Description |',
      '| --- | --- |',
      '| `src/app.ts` | **Updated** behavior |',
      '',
      '</details>',
      '',
      '<a href="/owner/repository/pull/1">Open review</a>'
    ].join('\n')
  }]
}

describe('PullRequestContext', () => {
  test('toggles the whole pull request context', () => {
    render(<PullRequestContext conversation={conversation} />)
    const toggle = screen.getByRole('button', { name: 'Pull request context' })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('reviewer')).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('reviewer')).toBeNull()
  })

  test('renders GitHub details and tables instead of raw markup', () => {
    render(<PullRequestContext conversation={conversation} />)
    const disclosure = screen.getByText('Files reviewed').closest('details')

    expect(disclosure).not.toBeNull()
    expect(within(disclosure!).getByRole('table')).toBeTruthy()
    expect(screen.queryByText(/<details>/)).toBeNull()
    expect(screen.getByText('Updated').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href'))
      .toBe('https://github.com/owner/repository/pull/1')
  })
})
