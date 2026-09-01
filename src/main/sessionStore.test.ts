import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SESSION_STATE, loadSessionState, parseSessionState, saveSessionState } from './sessionStore.js'

describe('parseSessionState', () => {
  it('reads a complete record', () => {
    expect(parseSessionState({ lastRoot: '/work/horus', approvedRoots: ['/work/horus'], restoreLastFolder: false, themeType: 'light' })).toEqual({
      lastRoot: '/work/horus',
      approvedRoots: ['/work/horus'],
      restoreLastFolder: false,
      themeType: 'light'
    })
  })

  it('falls back to the defaults field by field', () => {
    expect(parseSessionState({})).toEqual(DEFAULT_SESSION_STATE)
    expect(parseSessionState({ lastRoot: '' }).lastRoot).toBeNull()
    expect(parseSessionState({ lastRoot: 7 }).lastRoot).toBeNull()
    expect(parseSessionState({ restoreLastFolder: 'yes' }).restoreLastFolder).toBe(true)
    expect(parseSessionState({ themeType: 'sepia' }).themeType).toBe('dark')
    expect(parseSessionState({ lastRoot: '/work/horus' }).approvedRoots).toEqual(['/work/horus'])
  })

  it('survives a corrupt record', () => {
    expect(parseSessionState(null)).toEqual(DEFAULT_SESSION_STATE)
    expect(parseSessionState('{"lastRoot":"/work"}')).toEqual(DEFAULT_SESSION_STATE)
  })
})

describe('loadSessionState', () => {
  it('round-trips through disk and defaults when the file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horus-session-'))
    try {
      expect(loadSessionState(directory)).toEqual(DEFAULT_SESSION_STATE)
      await saveSessionState(directory, { lastRoot: '/work/horus', approvedRoots: ['/work/horus'], restoreLastFolder: false, themeType: 'light' })
      expect(loadSessionState(directory)).toEqual({
        lastRoot: '/work/horus',
        approvedRoots: ['/work/horus'],
        restoreLastFolder: false,
        themeType: 'light'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes rapid saves in call order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horus-session-order-'))
    try {
      const first = saveSessionState(directory, {
        lastRoot: '/work/first',
        approvedRoots: ['/work/first'],
        restoreLastFolder: true,
        themeType: 'dark'
      })
      const second = saveSessionState(directory, {
        lastRoot: '/work/second',
        approvedRoots: ['/work/first', '/work/second'],
        restoreLastFolder: false,
        themeType: 'light'
      })
      await Promise.all([first, second])

      expect(loadSessionState(directory)).toEqual({
        lastRoot: '/work/second',
        approvedRoots: ['/work/first', '/work/second'],
        restoreLastFolder: false,
        themeType: 'light'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
