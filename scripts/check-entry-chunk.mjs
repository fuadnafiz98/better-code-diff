import { resolve } from 'node:path'

import { bootChunkContains, closureChunksInGroup, measurePremountClosure } from './premountClosure.mjs'

// Everything the renderer parses and runs before a repository is on screen:
// the entry, the boot chunk and the workspace/viewer chunks, plus every chunk
// they import statically. Lower it whenever a section shrinks the closure —
// the number only goes down.
const MAX_PREMOUNT_BYTES = 1_403_000

// The entry is a shim that dynamically imports boot. Anything Rollup lets leak
// into its *static* closure is fetched and evaluated before boot starts, which
// is how a vendor chunk once ended up in front of the first paint.
const MAX_ENTRY_CLOSURE_BYTES = 64 * 1024

const TOP_CHUNKS = 15

const rendererDirectory = resolve('out/renderer')
const closure = await measurePremountClosure(rendererDirectory)

console.log(`Pre-mount closure: ${closure.totalBytes.toLocaleString()} bytes across ${closure.chunkCount} chunks (limit ${MAX_PREMOUNT_BYTES.toLocaleString()})`)
for (const chunk of closure.largest.slice(0, TOP_CHUNKS)) {
  console.log(`  ${String(chunk.bytes).padStart(9)}  ${chunk.name}`)
}
console.log(`Entry closure: ${closure.entryClosure.totalBytes.toLocaleString()} bytes across ${closure.entryClosure.chunkCount} chunks (limit ${MAX_ENTRY_CLOSURE_BYTES.toLocaleString()})`)

// The diff worker pool belongs to the viewer graph; it must not be in the chunk
// that runs before React mounts.
const leaked = await bootChunkContains(rendererDirectory, closure.bootChunks, 'WorkerPool')
if (leaked != null) {
  throw new Error(`Boot chunk ${leaked} contains WorkerPool; diff infrastructure leaked into startup.`)
}

// The shiki engine (tokenizer + oniguruma, ~143 KB) is reached through an async
// import inside the highlighter (P31). A dependency bump that re-links it
// statically would put it back in front of the first paint, so it is named here
// rather than left to the byte budget to notice. `vendor-shiki-langs` is a
// different chunk: 31 KB of dynamic-import table that @pierre/diffs links
// statically, and it loads no grammar until a file is highlighted.
const shikiChunks = closureChunksInGroup(closure, 'vendor-shiki', ['vendor-shiki-langs'])
if (shikiChunks.length > 0) {
  throw new Error(`Pre-mount closure contains ${shikiChunks.join(', ')}; the shiki engine must stay lazy.`)
}

if (closure.entryClosure.totalBytes > MAX_ENTRY_CLOSURE_BYTES) {
  const names = closure.entryClosure.largest.map((chunk) => `${chunk.name} (${chunk.bytes})`).join(', ')
  throw new Error(`Entry closure is ${closure.entryClosure.totalBytes} bytes; limit is ${MAX_ENTRY_CLOSURE_BYTES}. Chunks: ${names}`)
}

if (closure.totalBytes > MAX_PREMOUNT_BYTES) {
  throw new Error(`Pre-mount closure is ${closure.totalBytes} bytes; limit is ${MAX_PREMOUNT_BYTES} bytes.`)
}

console.log(`Boot chunk${closure.bootChunks.length === 1 ? '' : 's'}: ${closure.bootChunks.join(', ')} · WorkerPool absent · no vendor-shiki engine chunk in the pre-mount closure`)
