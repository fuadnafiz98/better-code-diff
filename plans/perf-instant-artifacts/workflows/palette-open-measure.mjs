// Ad hoc: app-side Cmd+P open-to-focus via the `horus:palette-open-to-focus` measure (Wave 3 G2).
// Usage: bun scratchpad/bench/palette-open-measure.mjs   (uses scripts/perf/cdp.mjs from the repo)
import { guardExit, launch, quit, settle } from '/Users/fuadnafiz98/Developer/vibes/better-code-diff/scripts/perf/cdp.mjs'

const OPENS = Number(process.env.OPENS ?? '4')
guardExit()
const { cdp } = await launch(9530)
try {
  await settle(cdp)
  await Bun.sleep(600)
  const results = []
  for (let i = 0; i < OPENS; i += 1) {
    const before = Date.now()
    await cdp.combo('p', 'KeyP', 80, 4)
    const focused = await cdp.waitFor(`(() => { const i = document.querySelector('#command-palette-input'); return i != null && document.activeElement === i })()`, 5_000, 3)
    const probeMs = focused.at == null ? null : focused.at - before
    await Bun.sleep(250)
    const app = await cdp.tryEval(`(() => { const e = performance.getEntriesByName('horus:palette-open-to-focus'); return e.length ? e[e.length - 1].duration : null })()`)
    const panel = await cdp.tryEval(`document.querySelectorAll('.command-palette-results button').length`)
    results.push({ open: i + 1, probeMs, appMs: app == null ? null : Math.round(app * 10) / 10, rows: panel })
    await cdp.escape()
    await Bun.sleep(400)
  }
  console.log(JSON.stringify(results))
} finally {
  cdp.socket.close()
  await quit()
}
