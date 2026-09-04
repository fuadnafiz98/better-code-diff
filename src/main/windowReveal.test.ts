import { describe, expect, it } from 'bun:test'

import {
  revealCreatedWindow,
  revealExistingWindow,
  shouldHoldWindowHidden,
  shouldRevealForReview,
  type ExistingWindowRevealTarget,
  type WindowRevealTarget
} from './windowReveal.js'

function fakeWindow(overrides: Partial<{ destroyed: boolean; visible: boolean }> = {}): WindowRevealTarget & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    isDestroyed: () => overrides.destroyed === true,
    isVisible: () => overrides.visible === true,
    maximize() { calls.push('maximize') },
    show() { calls.push('show') }
  }
}

describe('revealCreatedWindow', () => {
  it('shows a hidden window and maximizes first when asked', () => {
    const window = fakeWindow()
    expect(revealCreatedWindow(window, { holdHidden: false, maximize: true })).toBe(true)
    expect(window.calls).toEqual(['maximize', 'show'])
  })

  it('shows without maximizing', () => {
    const window = fakeWindow()
    expect(revealCreatedWindow(window, { holdHidden: false, maximize: false })).toBe(true)
    expect(window.calls).toEqual(['show'])
  })

  it('does not show a background launch, a destroyed window, or one already visible', () => {
    expect(revealCreatedWindow(fakeWindow(), { holdHidden: true, maximize: false })).toBe(false)
    expect(revealCreatedWindow(fakeWindow({ destroyed: true }), { holdHidden: false, maximize: true })).toBe(false)
    const visible = fakeWindow({ visible: true })
    expect(revealCreatedWindow(visible, { holdHidden: false, maximize: true })).toBe(false)
    expect(visible.calls).toEqual([])
  })
})

function fakeExistingWindow(overrides: Partial<{
  destroyed: boolean
  minimized: boolean
}> = {}): ExistingWindowRevealTarget & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isDestroyed: () => overrides.destroyed === true,
    isMinimized: () => overrides.minimized === true,
    restore() { calls.push('restore') },
    show() { calls.push('show') },
    focus() { calls.push('focus') }
  }
}

describe('revealExistingWindow', () => {
  it('shows and focuses without waiting for the renderer to finish loading', () => {
    const window = fakeExistingWindow()
    expect(revealExistingWindow(window)).toBe(true)
    expect(window.calls).toEqual(['show', 'focus'])
  })

  it('restores a minimized window before showing', () => {
    const window = fakeExistingWindow({ minimized: true })
    expect(revealExistingWindow(window)).toBe(true)
    expect(window.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('does not touch a missing or destroyed window', () => {
    expect(revealExistingWindow(null)).toBe(false)
    expect(revealExistingWindow(fakeExistingWindow({ destroyed: true }))).toBe(false)
  })
})

describe('shouldHoldWindowHidden', () => {
  it('never holds a launch that asked to open a pull request', () => {
    expect(shouldHoldWindowHidden(false, [{ intent: 'open' }])).toBe(false)
    expect(shouldHoldWindowHidden(false, [{ intent: 'warmup' }, { intent: 'open' }])).toBe(false)
  })

  it('holds warmup-only and start-hidden launches', () => {
    expect(shouldHoldWindowHidden(false, [{ intent: 'warmup' }])).toBe(true)
    expect(shouldHoldWindowHidden(true, [{ intent: 'open' }])).toBe(true)
    expect(shouldHoldWindowHidden(false, [])).toBe(false)
  })
})

describe('shouldRevealForReview', () => {
  it('reveals only open intents so warmup stays in the background', () => {
    expect(shouldRevealForReview('open')).toBe(true)
    expect(shouldRevealForReview('warmup')).toBe(false)
  })
})
