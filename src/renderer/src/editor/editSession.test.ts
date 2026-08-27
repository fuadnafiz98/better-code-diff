import { describe, expect, test } from 'bun:test'

import { resolveDiskState, resolveDraftFile } from './editSession'

const file = { name: 'src/a.ts', contents: 'original', cacheKey: 'key-1' }

describe('resolveDraftFile', () => {
  test('pins the file identity when there is no draft', () => {
    expect(resolveDraftFile(file, undefined)).toBe(file)
  })

  test('pins the file identity when the draft matches what is on disk', () => {
    expect(resolveDraftFile(file, { baseCacheKey: 'key-1', contents: 'original' })).toBe(file)
  })

  test('substitutes a draft typed against this file, keeping the cacheKey', () => {
    const rendered = resolveDraftFile(file, { baseCacheKey: 'key-1', contents: 'edited' })
    expect(rendered).not.toBe(file)
    expect(rendered.contents).toBe('edited')
    expect(rendered.cacheKey).toBe('key-1')
    expect(rendered.name).toBe('src/a.ts')
  })

  test('ignores a draft that predates an external write', () => {
    expect(resolveDraftFile(file, { baseCacheKey: 'key-0', contents: 'edited' })).toBe(file)
  })
})

describe('resolveDiskState', () => {
  const clean = { sourceCacheKey: 'key-1', dirty: false }
  const dirty = { sourceCacheKey: 'key-1', dirty: true }

  test('is unchanged without a session or a file', () => {
    expect(resolveDiskState(null, file)).toBe('unchanged')
    expect(resolveDiskState(clean, null)).toBe('unchanged')
  })

  test('is unchanged while disk still holds the revision the session knows', () => {
    expect(resolveDiskState(clean, file)).toBe('unchanged')
    expect(resolveDiskState(dirty, file)).toBe('unchanged')
  })

  test('a clean session adopts a new revision silently', () => {
    expect(resolveDiskState(clean, { ...file, cacheKey: 'key-2' })).toBe('adopt')
  })

  test('a dirty session raises a conflict instead', () => {
    expect(resolveDiskState(dirty, { ...file, cacheKey: 'key-2' })).toBe('conflict')
  })
})
