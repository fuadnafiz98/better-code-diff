import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { RepositorySnapshot } from '../shared/contracts.js'
import { EXCLUDED_DIRECTORY_SET } from './ignoredListing.js'

// The listing only has to carry the open folder until the live snapshot lands, so
// it is bounded rather than complete: three levels deep and 2,000 paths keeps it
// under 5 ms on a 2,621-file repository while showing more than one folder's worth
// of names.
const MAX_LISTING_PATHS = 2_000
const MAX_LISTING_DEPTH = 3
// Exactly the directories the live snapshot also hides, so the two trees agree
// for the moments the listing is on screen.
const SKIP_DIRECTORIES = new Set<string>([...EXCLUDED_DIRECTORY_SET, '.git'])

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

// Files of a level before its subdirectories, so a truncated listing is the top
// of the tree rather than one deep branch of it.
function collectListing(root: string, prefix: string, depth: number, maxPaths: number, paths: string[]): void {
  let entries
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true })
  } catch {
    // A directory we cannot read is skipped; the git refresh will fill it later.
    return
  }
  const directories: string[] = []
  for (const entry of entries) {
    if (paths.length >= maxPaths) return
    if (entry.isFile()) {
      paths.push(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      continue
    }
    if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name)) continue
    if (depth < MAX_LISTING_DEPTH) directories.push(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
  }
  for (const directory of directories) {
    if (paths.length >= maxPaths) return
    collectListing(root, directory, depth + 1, maxPaths, paths)
  }
}

/** Bounded directory listing so first paint has real names without waiting on git. */
export function listRootSnapshot(root: string, maxPaths = MAX_LISTING_PATHS): RepositorySnapshot {
  const paths: string[] = []
  collectListing(root, '', 1, maxPaths, paths)
  return {
    root,
    name: basename(root),
    kind: detectRepositoryKind(root),
    branch: null,
    head: null,
    paths,
    statuses: [],
    stage: 'skeleton'
  }
}
