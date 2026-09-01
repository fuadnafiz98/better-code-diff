import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_ENTRY_BYTES = 400 * 1024
const rendererDirectory = resolve('out/renderer')
const html = await readFile(resolve(rendererDirectory, 'index.html'), 'utf8')
const entryName = /<script[^>]+src="\.\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1]

if (entryName == null) throw new Error('Cannot find the renderer entry chunk in out/renderer/index.html.')

const entryPath = resolve(rendererDirectory, 'assets', entryName)
const [entry, metadata] = await Promise.all([
  readFile(entryPath, 'utf8'),
  stat(entryPath)
])

if (metadata.size > MAX_ENTRY_BYTES) {
  throw new Error(`Renderer entry is ${metadata.size} bytes; limit is ${MAX_ENTRY_BYTES} bytes.`)
}
if (entry.includes('WorkerPool')) {
  throw new Error('Renderer entry contains WorkerPool; diff infrastructure leaked into startup.')
}

console.log(`Renderer entry: ${entryName} · ${metadata.size} bytes · WorkerPool absent`)
