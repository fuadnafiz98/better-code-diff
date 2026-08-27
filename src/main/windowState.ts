import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

// A saved window has to overlap a work area by more than a hairline before it is
// worth restoring: a display that was unplugged since the last session leaves
// coordinates that open the window somewhere the user cannot drag it back from.
const MIN_VISIBLE_PIXELS = 80

const FILE_NAME = 'window-state.json'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw == null) return null
  const { x, y, width, height, maximized } = raw as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width < 1 || height < 1) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: maximized === true
  }
}

/**
 * Overlap rather than containment, so a window the user deliberately nudged part
 * way off an edge still comes back exactly where they left it.
 */
export function isReachable(state: WindowState, workAreas: readonly ScreenArea[]): boolean {
  return workAreas.some((area) => {
    const overlapX = Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)
    const overlapY = Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y)
    return overlapX >= MIN_VISIBLE_PIXELS && overlapY >= MIN_VISIBLE_PIXELS
  })
}

/**
 * Synchronous on purpose: the bounds are constructor arguments for the first
 * BrowserWindow, so there is nothing useful to overlap the read with.
 */
export function loadWindowState(directory: string, workAreas: readonly ScreenArea[]): WindowState | null {
  try {
    const state = parseWindowState(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
    return state != null && isReachable(state, workAreas) ? state : null
  } catch {
    return null
  }
}

export function saveWindowState(directory: string, state: WindowState): void {
  try {
    writeFileSync(join(directory, FILE_NAME), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('Could not persist window geometry:', error)
  }
}
