import { prepareFileTreeInput } from '@pierre/trees'

export interface TreeFollowBehavior {
  offset: 'nearest' | 'center'
  animate: boolean
}

export function getTreeFollowBehavior(source: 'direct-navigation' | 'review-scroll'): TreeFollowBehavior {
  return source === 'direct-navigation'
    ? { offset: 'nearest', animate: false }
    : { offset: 'center', animate: false }
}

export function orderPathsForTree(filePaths: readonly string[]): string[] {
  return [...prepareFileTreeInput(filePaths).paths]
}

// The workspace and the explorer ask for the directories of the same path array,
// so the answer is kept per input identity rather than computed twice.
const directoryPathsByInput = new WeakMap<readonly string[], string[]>()

export function getDirectoryPaths(filePaths: readonly string[]): string[] {
  const cached = directoryPathsByInput.get(filePaths)
  if (cached != null) return cached

  // Prefixes come from slicing at each separator, and depth is recorded on the way
  // through. Building them with `split().slice().join()` and then sorting with a
  // comparator that re-split both operands and called `localeCompare` cost 133ms at
  // 40k paths against 25ms for this; the order only drives the collapse-then-expand
  // pass, so byte order is enough.
  const directories = new Map<string, number>()
  for (const filePath of filePaths) {
    let index = filePath.indexOf('/')
    let depth = 1
    while (index >= 0) {
      directories.set(filePath.slice(0, index), depth)
      depth += 1
      index = filePath.indexOf('/', index + 1)
    }
  }

  const ordered = [...directories].sort(
    (left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  )
  const directoryPaths = ordered.map((entry) => entry[0])
  directoryPathsByInput.set(filePaths, directoryPaths)
  return directoryPaths
}
