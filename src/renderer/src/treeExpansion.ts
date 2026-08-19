import { prepareFileTreeInput } from '@pierre/trees'

export interface TreeFollowBehavior {
  offset: 'nearest' | 'center'
  animate: boolean
}

export function getTreeFollowBehavior(source: 'direct-navigation' | 'review-scroll'): TreeFollowBehavior {
  return source === 'direct-navigation'
    ? { offset: 'nearest', animate: false }
    : { offset: 'center', animate: true }
}

export function orderPathsForTree(filePaths: readonly string[]): string[] {
  return [...prepareFileTreeInput(filePaths).paths]
}

export function getDirectoryPaths(filePaths: readonly string[]): string[] {
  const directories = new Set<string>()

  for (const filePath of filePaths) {
    const segments = filePath.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'))
    }
  }

  return [...directories].sort((left, right) => {
    const depthDifference = left.split('/').length - right.split('/').length
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right)
  })
}
