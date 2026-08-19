const DEFAULT_SPLIT_PERCENT = 50
const MIN_SPLIT_PERCENT = 25
const MAX_SPLIT_PERCENT = 75
const KEYBOARD_STEP = 2
const LARGE_KEYBOARD_STEP = 10

export const SPLIT_DIFF_RESIZE_CSS = `
  [data-diff-type="split"] {
    position: relative;
  }

  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns:
      minmax(0, var(--horus-split-before, 50fr))
      minmax(0, var(--horus-split-after, 50fr));
  }

  [data-diff-type="split"][data-overflow="wrap"],
  [data-dehydrated][data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns:
      var(--diffs-grid-number-column-width)
      minmax(0, var(--horus-split-before, 50fr))
      var(--diffs-grid-number-column-width)
      minmax(0, var(--horus-split-after, 50fr));
  }

  /* The handle rides the split grid itself, never the rendered code inside it:
     mutating a pane's content subtree between the viewer's layout and measure
     passes made its height accounting oscillate and scrolling snap backwards.
     Placing it in a column with no row placement keeps the grid track for the
     inline axis and the container's padding box for the block axis. */
  [data-split-resize-handle] {
    position: absolute;
    grid-column: 2;
    z-index: 8;
    inset-block: 0;
    inset-inline-start: -6px;
    width: 12px;
    min-height: 24px;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    user-select: none;
  }

  [data-diff-type="split"][data-overflow="wrap"] > [data-split-resize-handle],
  [data-dehydrated][data-diff-type="split"] > [data-split-resize-handle] {
    grid-column: 3;
  }

  [data-split-resize-handle]::after {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-start: 5px;
    width: 1px;
    background: color-mix(in srgb, var(--diffs-fg) 16%, transparent);
  }

  [data-split-resize-handle]:hover::after,
  [data-split-resize-handle]:focus-visible::after,
  [data-split-resize-handle][data-dragging]::after {
    width: 2px;
    background: var(--diffs-modified-base);
  }

  [data-split-resize-handle]:focus-visible::before {
    content: "";
    position: absolute;
    inset-block: 4px;
    inset-inline-start: 1px;
    width: 10px;
    border: 1px solid var(--diffs-modified-base);
    border-radius: 5px;
  }
`

interface SplitResizeBinding {
  teardown(): void
}

const bindings = new WeakMap<HTMLElement, SplitResizeBinding>()
const splitPercentages = new WeakMap<HTMLElement, number>()

export function clampSplitPercentage(value: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, value))
}

export function splitPercentageFromPointer(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_SPLIT_PERCENT
  return clampSplitPercentage(((clientX - left) / width) * 100)
}

function findSurface(node: HTMLElement): HTMLElement {
  return node.closest<HTMLElement>('.diff-panel') ?? node.parentElement ?? node
}

function applySplitPercentage(surface: HTMLElement, value: number): number {
  const percentage = clampSplitPercentage(value)
  splitPercentages.set(surface, percentage)
  surface.style.setProperty('--horus-split-before', `${percentage}fr`)
  surface.style.setProperty('--horus-split-after', `${100 - percentage}fr`)
  surface.dispatchEvent(new CustomEvent<number>('horus:split-resize', { detail: percentage }))
  return percentage
}

function createHandle(root: ShadowRoot, percentage: number): HTMLElement | null {
  const split = root.querySelector<HTMLElement>('[data-diff-type="split"]')
  if (split == null) return null

  const existing = split.querySelector<HTMLElement>('[data-split-resize-handle]')
  if (existing != null) {
    if (existing.parentElement !== split) split.append(existing)
    return existing
  }

  const handle = document.createElement('div')
  handle.dataset.splitResizeHandle = ''
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-label', 'Resize old and new code panes')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-valuemin', String(MIN_SPLIT_PERCENT))
  handle.setAttribute('aria-valuemax', String(MAX_SPLIT_PERCENT))
  handle.setAttribute('aria-valuenow', String(Math.round(percentage)))
  handle.setAttribute('title', 'Drag to resize · Double-click to reset')
  handle.tabIndex = 0
  split.append(handle)
  return handle
}

function eventHandle(event: Event): HTMLElement | null {
  return event.composedPath().find(
    (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-split-resize-handle')
  ) ?? null
}

export function syncSplitDiffResizeLifecycle(node: HTMLElement, phase: string): void {
  if (phase === 'unmount') {
    bindings.get(node)?.teardown()
    bindings.delete(node)
    return
  }

  const surface = findSurface(node)
  const percentage = splitPercentages.get(surface) ?? DEFAULT_SPLIT_PERCENT
  const root = node.shadowRoot
  if (root == null) return
  const existingBinding = bindings.get(node)
  if (existingBinding != null) {
    createHandle(root, percentage)
    return
  }
  let activePointer: number | null = null
  let activeHandle: HTMLElement | null = null

  const updateFromPointer = (event: PointerEvent): void => {
    const bounds = node.getBoundingClientRect()
    applySplitPercentage(surface, splitPercentageFromPointer(event.clientX, bounds.left, bounds.width))
  }

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const handle = eventHandle(event)
    if (handle == null || (pointerEvent.button !== 0 && pointerEvent.pointerType !== 'touch')) return

    event.preventDefault()
    activePointer = pointerEvent.pointerId
    activeHandle = handle
    handle.dataset.dragging = ''
    handle.setPointerCapture?.(pointerEvent.pointerId)
    updateFromPointer(pointerEvent)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (activePointer !== pointerEvent.pointerId) return
    event.preventDefault()
    updateFromPointer(pointerEvent)
  }

  const finishPointer = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (activePointer !== pointerEvent.pointerId) return
    if (activeHandle?.hasPointerCapture?.(pointerEvent.pointerId)) {
      activeHandle.releasePointerCapture(pointerEvent.pointerId)
    }
    activeHandle?.removeAttribute('data-dragging')
    activePointer = null
    activeHandle = null
  }

  const onDoubleClick = (event: Event): void => {
    if (eventHandle(event) == null) return
    event.preventDefault()
    applySplitPercentage(surface, DEFAULT_SPLIT_PERCENT)
  }

  const onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent
    if (eventHandle(event) == null) return

    const current = splitPercentages.get(surface) ?? DEFAULT_SPLIT_PERCENT
    const step = keyboardEvent.shiftKey ? LARGE_KEYBOARD_STEP : KEYBOARD_STEP
    const next = keyboardEvent.key === 'ArrowLeft'
      ? current - step
      : keyboardEvent.key === 'ArrowRight'
        ? current + step
        : keyboardEvent.key === 'Home'
          ? MIN_SPLIT_PERCENT
          : keyboardEvent.key === 'End'
            ? MAX_SPLIT_PERCENT
            : keyboardEvent.key === 'Enter'
              ? DEFAULT_SPLIT_PERCENT
              : null
    if (next == null) return

    event.preventDefault()
    applySplitPercentage(surface, next)
  }

  const onSplitResize = (event: Event): void => {
    const nextPercentage = (event as CustomEvent<number>).detail
    const handle = createHandle(root, nextPercentage)
    handle?.setAttribute('aria-valuenow', String(Math.round(nextPercentage)))
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', finishPointer, true)
  root.addEventListener('pointercancel', finishPointer, true)
  root.addEventListener('dblclick', onDoubleClick, true)
  root.addEventListener('keydown', onKeyDown, true)
  surface.addEventListener('horus:split-resize', onSplitResize)
  createHandle(root, percentage)

  bindings.set(node, {
    teardown: () => {
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('pointermove', onPointerMove, true)
      root.removeEventListener('pointerup', finishPointer, true)
      root.removeEventListener('pointercancel', finishPointer, true)
      root.removeEventListener('dblclick', onDoubleClick, true)
      root.removeEventListener('keydown', onKeyDown, true)
      surface.removeEventListener('horus:split-resize', onSplitResize)
    }
  })
}
