import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type WindowThemeType = 'dark' | 'light'

export interface SessionState {
  lastRoot: string | null
  approvedRoots: string[]
  restoreLastFolder: boolean
  themeType: WindowThemeType
}

export const DEFAULT_SESSION_STATE: SessionState = {
  lastRoot: null,
  approvedRoots: [],
  restoreLastFolder: true,
  themeType: 'dark'
}

const FILE_NAME = 'last-session.json'
let pendingSave: Promise<void> = Promise.resolve()

export function parseSessionState(raw: unknown): SessionState {
  if (typeof raw !== 'object' || raw == null) return DEFAULT_SESSION_STATE
  const { lastRoot, approvedRoots, restoreLastFolder, themeType } = raw as Record<string, unknown>
  const parsedLastRoot = typeof lastRoot === 'string' && lastRoot !== '' ? lastRoot : null
  return {
    lastRoot: parsedLastRoot,
    approvedRoots: Array.isArray(approvedRoots)
      ? [...new Set(approvedRoots.filter((root): root is string => typeof root === 'string' && root !== ''))]
      : parsedLastRoot == null ? [] : [parsedLastRoot],
    restoreLastFolder: typeof restoreLastFolder === 'boolean'
      ? restoreLastFolder
      : DEFAULT_SESSION_STATE.restoreLastFolder,
    themeType: themeType === 'light' ? 'light' : 'dark'
  }
}

/**
 * Synchronous because both values are needed before the first BrowserWindow
 * exists: the theme decides the window's background colour and the restore flag
 * decides whether to start opening a repository alongside it.
 */
export function loadSessionState(directory: string): SessionState {
  try {
    return parseSessionState(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
  } catch {
    return DEFAULT_SESSION_STATE
  }
}

export function saveSessionState(directory: string, state: SessionState): Promise<void> {
  const path = join(directory, FILE_NAME)
  const serialized = JSON.stringify(state, null, 2)
  pendingSave = pendingSave
    .then(() => writeFile(path, serialized, 'utf8'))
    .catch((error) => {
      console.error('Could not persist the last session:', error)
    })
  return pendingSave
}

export function flushSessionState(): Promise<void> {
  return pendingSave
}
