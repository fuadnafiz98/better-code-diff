import { describe, expect, it } from 'bun:test'

import type { PullRequestConversation, RemoteReviewThread } from '../../shared/contracts'
import { groupRemoteThreadsByPath, sameConversation } from './usePullRequestConversation'

const thread = (overrides: Partial<RemoteReviewThread> = {}): RemoteReviewThread => ({
  id: 'thread-1',
  path: 'src/a.ts',
  line: 4,
  startLine: null,
  side: 'RIGHT',
  resolved: false,
  outdated: false,
  comments: [{ id: 'comment-1', body: 'Rename this.', authorLogin: 'reviewer', createdAt: '2026-08-17T10:00:00Z' }],
  ...overrides
})

const conversation = (overrides: Partial<PullRequestConversation> = {}): PullRequestConversation => ({
  available: true,
  message: null,
  body: 'Adds the inbox.',
  threads: [thread()],
  reviews: [],
  ...overrides
})

describe('groupRemoteThreadsByPath', () => {
  it('groups threads by their file path', () => {
    const grouped = groupRemoteThreadsByPath([
      thread(),
      thread({ id: 'thread-2' }),
      thread({ id: 'thread-3', path: 'src/b.ts' })
    ])
    expect([...grouped.keys()]).toEqual(['src/a.ts', 'src/b.ts'])
    expect(grouped.get('src/a.ts')?.map((entry) => entry.id)).toEqual(['thread-1', 'thread-2'])
  })

  it('returns an empty map for no threads', () => {
    expect(groupRemoteThreadsByPath([]).size).toBe(0)
  })
})

describe('sameConversation', () => {
  it('treats an identical poll result as unchanged', () => {
    expect(sameConversation(conversation(), conversation())).toBe(true)
  })

  it('never matches a missing previous conversation', () => {
    expect(sameConversation(null, conversation())).toBe(false)
  })

  it('detects new comments, replies, and resolution changes', () => {
    expect(sameConversation(conversation(), conversation({ threads: [thread({ resolved: true })] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ threads: [thread({ outdated: true })] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ comments: [...thread().comments, { id: 'comment-2', body: 'Reply', authorLogin: 'other', createdAt: '2026-08-17T11:00:00Z' }] })]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ comments: [{ id: 'comment-1', body: 'Edited.', authorLogin: 'reviewer', createdAt: '2026-08-17T10:00:00Z' }] })]
    }))).toBe(false)
  })

  it('detects new threads, reviews, description edits, and availability changes', () => {
    expect(sameConversation(conversation(), conversation({ threads: [] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ body: 'Rewritten.' }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      reviews: [{ id: 'review-1', state: 'APPROVED', body: '', authorLogin: 'reviewer', submittedAt: null }]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ available: false, message: 'gh missing' }))).toBe(false)
  })
})
