import { performance } from 'node:perf_hooks'

const pageCount = Number(process.argv[2] ?? 130)
const pageBytes = Number(process.argv[3] ?? 100_000)
const samples = Number(process.argv[4] ?? 9)
const seamBytes = 4_096

function createPages() {
  return Array.from({ length: pageCount }, (_unused, index) => {
    const prefix = `diff --git a/file-${index}.txt b/file-${index}.txt\n`
    return `${prefix}${String(index % 10).repeat(Math.max(0, pageBytes - prefix.length))}`
  })
}

function oldStringStorage(pages) {
  let patch = ''
  let parsedLength = 0
  let parsedTail = ''
  let checksum = 0
  for (const page of pages) {
    patch = `${patch}${page}`
    if (!patch.startsWith(parsedTail, parsedLength - parsedTail.length)) throw new Error('Invalid seam')
    const pending = patch.slice(parsedLength)
    checksum += pending.charCodeAt(pending.length - 1)
    parsedLength = patch.length
    parsedTail = patch.slice(Math.max(0, patch.length - seamBytes))
  }
  return checksum + patch.length
}

function pagedStorage(pages) {
  let storedPages = []
  let parsedPages = []
  let patchLength = 0
  let checksum = 0
  for (const page of pages) {
    storedPages = [...storedPages, page]
    if (!parsedPages.every((parsedPage, index) => storedPages[index] === parsedPage)) {
      throw new Error('Invalid page prefix')
    }
    checksum += page.charCodeAt(page.length - 1)
    parsedPages = [...storedPages]
    patchLength += page.length
  }
  return checksum + patchLength
}

function measure(run, pages) {
  const durations = []
  let checksum = 0
  for (let sample = 0; sample < samples + 2; sample += 1) {
    const startedAt = performance.now()
    checksum ^= run(pages)
    const duration = performance.now() - startedAt
    if (sample >= 2) durations.push(duration)
  }
  durations.sort((left, right) => left - right)
  return { medianMs: durations[Math.floor(durations.length / 2)], checksum }
}

const pages = createPages()
const oldResult = measure(oldStringStorage, pages)
const pagedResult = measure(pagedStorage, pages)
const totalBytes = pages.reduce((total, page) => total + page.length, 0)
const oldCopiedCharacters = pages.reduce(
  (total, _page, index) => total + pageBytes * (index + 1),
  0
)

console.log(JSON.stringify({
  pageCount,
  pageBytes,
  totalPatchMegabytes: totalBytes / 1_000_000,
  samples,
  oldStringStorage: oldResult,
  pagedStorage: pagedResult,
  speedup: oldResult.medianMs / pagedResult.medianMs,
  oldConcatenationMegacharacters: oldCopiedCharacters / 1_000_000,
  pagedConcatenationMegacharacters: 0
}))
