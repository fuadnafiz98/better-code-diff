import { describe, expect, test } from 'bun:test'

import { clipboardWarmupDecision, warmupCooledDown } from './pullRequestWarmup.js'

const PULL_REQUEST = 'https://github.com/acme/app/pull/7'

describe('clipboardWarmupDecision', () => {
  test('warms a newly copied pull request URL', () => {
    expect(clipboardWarmupDecision({ text: PULL_REQUEST, seen: '', windowVisible: true }))
      .toEqual({ seen: PULL_REQUEST, url: PULL_REQUEST })
  })

  test('ignores unchanged clipboard text', () => {
    expect(clipboardWarmupDecision({ text: PULL_REQUEST, seen: PULL_REQUEST, windowVisible: true }))
      .toEqual({ seen: PULL_REQUEST, url: null })
  })

  test('consumes text that holds no pull request URL', () => {
    expect(clipboardWarmupDecision({ text: 'notes', seen: '', windowVisible: true }))
      .toEqual({ seen: 'notes', url: null })
  })

  test('does nothing and keeps the marker while no window is visible', () => {
    expect(clipboardWarmupDecision({ text: PULL_REQUEST, seen: 'notes', windowVisible: false }))
      .toEqual({ seen: 'notes', url: null })
  })
})

describe('warmupCooledDown', () => {
  test('allows a URL that has never been warmed', () => {
    expect(warmupCooledDown({ lastWarmedAt: undefined, now: 1_000, cooldownMs: 60_000 })).toBe(true)
  })

  test('blocks a URL warmed inside the cooldown, hit or miss', () => {
    expect(warmupCooledDown({ lastWarmedAt: 1_000, now: 30_000, cooldownMs: 60_000 })).toBe(false)
  })

  test('allows a URL again once the cooldown has passed', () => {
    expect(warmupCooledDown({ lastWarmedAt: 1_000, now: 61_000, cooldownMs: 60_000 })).toBe(true)
  })
})
