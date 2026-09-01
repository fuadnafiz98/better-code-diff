import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_STORAGE_BUDGET,
  STORAGE_INDEX_KEY,
  enforceStorageBudget,
  forgetStorageKey,
  loadStorageIndex,
  persistManagedValue,
  rebuildStorageIndex,
  touchStorageKey,
  type BudgetStorage
} from './storageBudget'

function createStorage(initial: Record<string, string> = {}): BudgetStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] },
    get length() { return Object.keys(data).length },
    key: (index) => Object.keys(data)[index] ?? null
  }
}

describe('storageBudget', () => {
  it('evicts least-recently-touched keys until under budget', () => {
    const storage = createStorage()
    touchStorageKey(storage, 'better-code-diff:viewed-files:/a', 40, 1)
    storage.setItem('better-code-diff:viewed-files:/a', 'a'.repeat(40))
    touchStorageKey(storage, 'better-code-diff:review-threads:/b', 40, 2)
    storage.setItem('better-code-diff:review-threads:/b', 'b'.repeat(40))
    touchStorageKey(storage, 'horus:drafts:v1:/c', 40, 3)
    storage.setItem('horus:drafts:v1:/c', 'c'.repeat(40))

    expect(enforceStorageBudget(storage, 80)).toEqual(['better-code-diff:viewed-files:/a'])
    expect(storage.getItem('better-code-diff:viewed-files:/a')).toBeNull()
    expect(storage.getItem('better-code-diff:review-threads:/b')).not.toBeNull()
  })

  it('never evicts the key being written', () => {
    const storage = createStorage()
    const preserved = 'better-code-diff:viewed-files:/kept'
    touchStorageKey(storage, preserved, 90, 1)
    storage.setItem(preserved, 'k'.repeat(90))
    touchStorageKey(storage, 'better-code-diff:review-threads:/old', 20, 2)
    storage.setItem('better-code-diff:review-threads:/old', 'o'.repeat(20))

    expect(enforceStorageBudget(storage, 80, preserved)).toEqual(['better-code-diff:review-threads:/old'])
    expect(storage.getItem(preserved)).not.toBeNull()
  })

  it('rebuilds a corrupt manifest from a prefix scan', () => {
    const storage = createStorage({
      [STORAGE_INDEX_KEY]: 'not-json',
      'better-code-diff:viewed-files:/repo': 'abc',
      'unrelated': 'skip'
    })
    const index = loadStorageIndex(storage, 10)
    expect(index['better-code-diff:viewed-files:/repo']).toEqual({ bytes: 3, touchedAt: 10 })
    expect(index.unrelated).toBeUndefined()
    expect(rebuildStorageIndex(storage, 10)['better-code-diff:viewed-files:/repo']?.bytes).toBe(3)
  })

  it('forgets a key and persistManagedValue records a successful write', () => {
    const storage = createStorage()
    expect(persistManagedValue(storage, 'horus:drafts:v1:/repo', 'hello', DEFAULT_STORAGE_BUDGET)).toBe(true)
    expect(storage.getItem('horus:drafts:v1:/repo')).toBe('hello')
    forgetStorageKey(storage, 'horus:drafts:v1:/repo')
    expect(loadStorageIndex(storage)['horus:drafts:v1:/repo']).toBeUndefined()
  })
})
