import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_PATH = process.env.HORUS_APP_PATH ?? join(homedir(), 'Applications/Horus.app')
const SAMPLE_COUNT = Number.parseInt(process.env.HORUS_STARTUP_SAMPLES ?? '5', 10)
const STARTUP_TIMEOUT_MS = Number.parseInt(process.env.HORUS_STARTUP_TIMEOUT_MS ?? '6000', 10)

async function run(command) {
  const childProcess = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return childProcess.exited
}

async function waitForExit() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await run(['pgrep', '-x', 'Horus']) !== 0) return
    await Bun.sleep(20)
  }
  throw new Error('Horus did not exit before the benchmark launch.')
}

async function quitHorus() {
  await run(['osascript', '-e', 'tell application "Horus" to quit'])
  await waitForExit()
}

async function waitForPage(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page')
        if (page != null) return page
      }
    } catch {
      // The remote-debugging endpoint appears after Chromium starts.
    }
    await Bun.sleep(10)
  }
  throw new Error(`No Horus page target appeared on port ${port}.`)
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    socket.onopen = () => resolve(socket)
    socket.onerror = () => reject(new Error('Could not connect to the Horus renderer.'))
  })
}

function evaluate(socket, state, expression) {
  return new Promise((resolve, reject) => {
    const id = ++state.lastCommandId
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error('The Horus renderer did not answer a benchmark probe.'))
    }, 2_000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      if (message.result?.exceptionDetails != null) {
        reject(new Error(message.result.exceptionDetails.text ?? 'Renderer probe failed.'))
        return
      }
      resolve(message.result.result.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }))
  })
}

function round(value) {
  return value == null ? null : Number(value.toFixed(1))
}

async function sampleStartup(sample) {
  await quitHorus()
  const port = 9460 + sample
  const processStartedAt = Date.now()
  await run([
    'open', '-na', APP_PATH, '--args',
    `--remote-debugging-port=${port}`
  ])

  const page = await waitForPage(port)
  const socket = await connect(page.webSocketDebuggerUrl)
  const state = { lastCommandId: 0 }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let observation
  let explorerUsableAt = null
  let reviewUsableAt = null

  while (Date.now() < deadline) {
    observation = await evaluate(socket, state, `({
      timeOrigin: performance.timeOrigin,
      paints: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })),
      navigation: performance.getEntriesByType('navigation')[0]?.startTime ?? 0,
      explorer: document.querySelector('#repository-explorer') != null,
      review: document.querySelector('.multi-file-review, .multi-file-code-view') != null
    })`)
    const observedAt = Date.now()
    if (observation.explorer && explorerUsableAt == null) explorerUsableAt = observedAt
    if (observation.review && reviewUsableAt == null) reviewUsableAt = observedAt
    if (explorerUsableAt != null && reviewUsableAt != null) break
    await Bun.sleep(3)
  }

  socket.close()
  if (observation == null || !observation.explorer || !observation.review) {
    throw new Error('The restored explorer and review surface did not become usable.')
  }

  const originOffset = observation.timeOrigin - processStartedAt
  const paints = Object.fromEntries(observation.paints.map(({ name, startTime }) => [name, startTime]))
  return {
    sample,
    navigationMs: round(originOffset + observation.navigation),
    firstPaintMs: round(originOffset + paints['first-paint']),
    firstContentfulPaintMs: round(originOffset + paints['first-contentful-paint']),
    explorerUsableMs: explorerUsableAt - processStartedAt,
    reviewUsableMs: reviewUsableAt - processStartedAt
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1) {
  throw new Error('HORUS_STARTUP_SAMPLES must be a positive integer.')
}

const samples = []
try {
  for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
    const result = await sampleStartup(sample)
    samples.push(result)
    console.log(JSON.stringify(result))
  }
} finally {
  await quitHorus()
}

const timingNames = [
  'navigationMs',
  'firstPaintMs',
  'firstContentfulPaintMs',
  'explorerUsableMs',
  'reviewUsableMs'
]
const medians = Object.fromEntries(timingNames.map((name) => [
  name,
  median(samples.map((sample) => sample[name]))
]))
console.log(JSON.stringify({ samples: samples.length, medians }))
