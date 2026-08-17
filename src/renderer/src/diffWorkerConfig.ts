export const DIFF_WORKER_COUNT = 1

export const DIFF_WORKER_POOL_OPTIONS = {
  poolSize: DIFF_WORKER_COUNT,
  totalASTLRUCacheSize: 8,
  workerFactory: () =>
    new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
      type: 'module'
    })
}

export const DIFF_HIGHLIGHTER_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'rust',
  'go',
  'java',
  'shellscript',
  'yaml'
]

export const DIFF_HIGHLIGHTER_LIMITS = {
  tokenizeMaxLineLength: 2_000,
  maxLineDiffLength: 1_000
}
