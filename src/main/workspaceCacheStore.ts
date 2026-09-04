import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  parseWorkspaceCache,
  type WorkspaceCache
} from '../shared/workspaceCache.js'

const FILE_NAME = 'last-workspace.json'
let pendingSave: Promise<void> = Promise.resolve()

/**
 * Synchronous because the first HTML/React paint needs real folder names
 * before git status returns.
 */
export function loadWorkspaceCache(directory: string): WorkspaceCache | null {
  try {
    return parseWorkspaceCache(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
  } catch {
    return null
  }
}

export function saveWorkspaceCache(directory: string, cache: WorkspaceCache): Promise<void> {
  const path = join(directory, FILE_NAME)
  const serialized = JSON.stringify(cache)
  pendingSave = pendingSave
    .then(() => writeFile(path, serialized, 'utf8'))
    .catch((error) => {
      console.error('Could not persist the last workspace:', error)
    })
  return pendingSave
}

export function flushWorkspaceCache(): Promise<void> {
  return pendingSave
}
