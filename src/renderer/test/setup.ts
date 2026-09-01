import { Window } from 'happy-dom'

if (globalThis.document == null) {
  const browser = new Window({ url: 'http://localhost/' })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browser },
    document: { configurable: true, value: browser.document },
    navigator: { configurable: true, value: browser.navigator },
    localStorage: { configurable: true, value: browser.localStorage },
    HTMLElement: { configurable: true, value: browser.HTMLElement },
    HTMLDivElement: { configurable: true, value: browser.HTMLDivElement },
    HTMLTemplateElement: { configurable: true, value: browser.HTMLTemplateElement },
    HTMLDialogElement: { configurable: true, value: browser.HTMLDialogElement },
    Element: { configurable: true, value: browser.Element },
    Node: { configurable: true, value: browser.Node },
    ShadowRoot: { configurable: true, value: browser.ShadowRoot },
    DocumentFragment: { configurable: true, value: browser.DocumentFragment },
    customElements: { configurable: true, value: browser.customElements },
    Event: { configurable: true, value: browser.Event },
    KeyboardEvent: { configurable: true, value: browser.KeyboardEvent },
    PointerEvent: { configurable: true, value: browser.PointerEvent },
    CustomEvent: { configurable: true, value: browser.CustomEvent },
    MutationObserver: { configurable: true, value: browser.MutationObserver },
    ResizeObserver: { configurable: true, value: browser.ResizeObserver },
    requestAnimationFrame: { configurable: true, value: browser.requestAnimationFrame.bind(browser) },
    cancelAnimationFrame: { configurable: true, value: browser.cancelAnimationFrame.bind(browser) },
    getComputedStyle: { configurable: true, value: browser.getComputedStyle.bind(browser) }
  })
}
