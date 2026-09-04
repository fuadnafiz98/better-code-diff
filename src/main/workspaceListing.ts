import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { RepositorySnapshot } from '../shared/contracts.js'

const MAX_LISTING_PATHS = 400
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.output',
  '.turbo',
  '.vercel',
  'DerivedData',
  'build',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor'
])

export function resolveExistingRoot(root: string): string | null {
  try {
    if (!existsSync(root)) return null
    return realpathSync(root)
  } catch {
    return null
  }
}

export function rootsMatch(left: string, right: string): boolean {
  if (left === right) return true
  const resolvedLeft = resolveExistingRoot(left)
  const resolvedRight = resolveExistingRoot(right)
  return resolvedLeft != null && resolvedLeft === resolvedRight
}

export function detectRepositoryKind(root: string): 'git' | 'folder' {
  try {
    return existsSync(join(root, '.git')) ? 'git' : 'folder'
  } catch {
    return 'folder'
  }
}

/** Shallow directory listing so first paint has real names without waiting on git. */
export function listRootSnapshot(root: string, maxPaths = MAX_LISTING_PATHS): RepositorySnapshot {
  const paths: string[] = []
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (paths.length >= maxPaths) break
      if (entry.name.startsWith('.')) continue
      if (entry.isFile()) {
        paths.push(entry.name)
        continue
      }
      if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
      try {
        const children = readdirSync(join(root, entry.name), { withFileTypes: true })
        for (const child of children) {
          if (paths.length >= maxPaths) break
          if (child.name.startsWith('.') || !child.isFile()) continue
          paths.push(`${entry.name}/${child.name}`)
        }
      } catch {
        // A directory we cannot read is skipped; git refresh will fill it later.
      }
    }
  } catch {
    // An unreadable root still paints a named empty folder, not a skeleton.
  }
  return {
    root,
    name: basename(root),
    kind: detectRepositoryKind(root),
    branch: null,
    head: null,
    paths,
    statuses: []
  }
}
