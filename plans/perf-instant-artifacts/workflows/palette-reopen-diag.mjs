import { guardExit, launch, quit, settle } from '/Users/fuadnafiz98/Developer/vibes/better-code-diff/scripts/perf/cdp.mjs'
guardExit()
const { cdp } = await launch(9540)
try {
  await settle(cdp); await Bun.sleep(600)
  await cdp.send('Runtime.enable', {})
  const errors = []
  cdp.on?.('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description ?? 'exception'))
  for (let i = 0; i < 3; i += 1) {
    await cdp.combo('p', 'KeyP', 80, 4)
    await Bun.sleep(400)
    const snap = await cdp.tryEval(`(() => { const r = document.querySelector('.command-palette-results'); const dlg = document.querySelector('dialog.command-palette-layer'); return { dialog: dlg != null, dialogOpen: dlg?.open ?? null, results: r != null, buttons: document.querySelectorAll('.command-palette-results button').length, rows: r ? r.children.length : null, html: r ? r.innerHTML.slice(0, 300) : null, input: document.querySelector('#command-palette-input')?.value ?? null, focused: document.activeElement?.id ?? null } })()`)
    console.log(JSON.stringify({ open: i + 1, ...snap }))
    await cdp.escape(); await Bun.sleep(500)
    const after = await cdp.tryEval(`({ dialogs: document.querySelectorAll('dialog.command-palette-layer').length, palettes: document.querySelectorAll('.command-palette').length })`)
    console.log(JSON.stringify({ afterClose: after }))
  }
  console.log(JSON.stringify({ errors }))
} finally { cdp.socket.close(); await quit() }
