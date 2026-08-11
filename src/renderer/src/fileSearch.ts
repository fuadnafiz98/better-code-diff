interface IndexedPath {
  path: string
  normalizedPath: string
}

interface RankedPath {
  path: string
  score: number
}

function fuzzyPathScore(path: IndexedPath, normalizedQuery: string): number | null {
  const { normalizedPath } = path
  if (normalizedQuery.length === 0) return 0

  const directIndex = normalizedPath.indexOf(normalizedQuery)
  if (directIndex >= 0) {
    const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
    if (filename.startsWith(normalizedQuery)) {
      return -100 + (filename.length - normalizedQuery.length) / 1_000 + path.path.length / 1_000_000
    }
    return directIndex + path.path.length / 1_000
  }

  let pathIndex = 0
  let score = 0
  let previousMatch = -2
  for (const queryCharacter of normalizedQuery) {
    const matchIndex = normalizedPath.indexOf(queryCharacter, pathIndex)
    if (matchIndex < 0) return null
    score += matchIndex === previousMatch + 1 ? 1 : 8
    score += matchIndex / 100
    previousMatch = matchIndex
    pathIndex = matchIndex + 1
  }
  return score
}

function compareRankedPaths(left: RankedPath, right: RankedPath): number {
  return left.score - right.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function addRankedPath(heap: RankedPath[], candidate: RankedPath, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      const parent = heap[parentIndex]!
      const current = heap[index]!
      if (compareRankedPaths(parent, current) >= 0) break
      heap[parentIndex] = current
      heap[index] = parent
      index = parentIndex
    }
    return
  }
  if (compareRankedPaths(candidate, heap[0]!) >= 0) return

  heap[0] = candidate
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    const rightIndex = leftIndex + 1
    let worstIndex = index
    if (leftIndex < heap.length && compareRankedPaths(heap[leftIndex]!, heap[worstIndex]!) > 0) worstIndex = leftIndex
    if (rightIndex < heap.length && compareRankedPaths(heap[rightIndex]!, heap[worstIndex]!) > 0) worstIndex = rightIndex
    if (worstIndex === index) break
    const current = heap[index]!
    heap[index] = heap[worstIndex]!
    heap[worstIndex] = current
    index = worstIndex
  }
}

export function createFileSearchIndex(paths: readonly string[]): IndexedPath[] {
  return paths.map((path) => ({ path, normalizedPath: path.toLowerCase() }))
}

export function rankFilePaths(paths: readonly IndexedPath[], query: string, limit = 80): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  const rankedPaths: RankedPath[] = []
  for (const indexedPath of paths) {
    const score = fuzzyPathScore(indexedPath, normalizedQuery)
    if (score != null) addRankedPath(rankedPaths, { path: indexedPath.path, score }, limit)
  }
  return rankedPaths.sort(compareRankedPaths).map((result) => result.path)
}
