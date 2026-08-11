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
