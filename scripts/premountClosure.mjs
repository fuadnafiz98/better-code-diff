import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// Rollup writes static edges as `from"./chunk.js"` / `import"./chunk.js"` and
// lazy ones as `import("./chunk.js")`. Only the static form is followed: a
// dynamic import is a chunk the app can defer, which is the whole point of the
// budget.
const STATIC_IMPORT = /(?:^|[^.\w$])(?:from|import)\s*"\.\/([^"]+\.js)"/g

/** The chunks that run, or are awaited, before the workspace is on screen. */
export const PREMOUNT_ROOT_NAMES = ['boot', 'WorkspaceRoot', 'DiffSurface', 'MultiFileReview']

export function entryChunkFromHtml(html) {
  return /<script[^>]+src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? null
}

export function staticImportsOf(source) {
  return [...source.matchAll(STATIC_IMPORT)].map((match) => match[1])
}

async function readChunk(assetsDirectory, name) {
  const path = resolve(assetsDirectory, name)
  try {
    const [source, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { source, size: metadata.size }
  } catch {
    return null
  }
}

async function walkStaticClosure(assetsDirectory, roots) {
  const chunks = new Map()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()
    if (name == null || chunks.has(name)) continue
    const chunk = await readChunk(assetsDirectory, name)
    if (chunk == null) continue
    chunks.set(name, chunk.size)
    queue.push(...staticImportsOf(chunk.source))
  }

  const largest = [...chunks]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes)
  return {
    chunkCount: chunks.size,
    totalBytes: largest.reduce((total, chunk) => total + chunk.bytes, 0),
    largest
  }
}

/**
 * Two budgets from one build. `entry` is what the browser must fetch and run
 * before the first dynamic import resolves — it should stay near nothing.
 * `premount` adds the boot chunk and the workspace/viewer chunks: everything
 * the renderer parses before a repository is usable.
 */
export async function measurePremountClosure(rendererDirectory) {
  const html = await readFile(resolve(rendererDirectory, 'index.html'), 'utf8')
  const entry = entryChunkFromHtml(html)
  if (entry == null) {
    throw new Error(`Cannot find the renderer entry chunk in ${rendererDirectory}/index.html.`)
  }

  const assetsDirectory = resolve(rendererDirectory, 'assets')
  const files = await readdir(assetsDirectory)
  const bootChunks = files.filter((file) => file.startsWith('boot-') && file.endsWith('.js'))
  const roots = [entry]
  for (const name of PREMOUNT_ROOT_NAMES) {
    roots.push(...files.filter((file) => file.startsWith(`${name}-`) && file.endsWith('.js')))
  }

  return {
    entry,
    roots,
    bootChunks,
    entryClosure: await walkStaticClosure(assetsDirectory, [entry]),
    ...await walkStaticClosure(assetsDirectory, roots)
  }
}

/**
 * Pre-mount chunks belonging to one Rollup manual-chunk group — how a vendor
 * group that is supposed to sit behind a dynamic import is caught when it stops
 * being lazy. Hashes contain hyphens (`vendor-diffs-BEU-U29u.js`), so a group
 * cannot be matched by splitting the name; `siblingGroups` names the longer
 * group names that share this one's prefix and must not be counted with it.
 */
export function closureChunksInGroup(closure, group, siblingGroups = []) {
  return closure.largest
    .map((chunk) => chunk.name)
    .filter((name) => name.startsWith(`${group}-`))
    .filter((name) => !siblingGroups.some((sibling) => name.startsWith(`${sibling}-`)))
    .sort()
}

export async function bootChunkContains(rendererDirectory, bootChunks, needle) {
  for (const name of bootChunks) {
    const source = await readFile(resolve(rendererDirectory, 'assets', name), 'utf8')
    if (source.includes(needle)) return name
  }
  return null
}
