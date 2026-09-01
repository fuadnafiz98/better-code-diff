import type { SelectedLineRange } from '@pierre/diffs'

export const DRAG_SELECTION_CSS = `
  [data-selected-line],
  [data-drag-range] {
    background: color-mix(in srgb, var(--accent) 16%, transparent) !important;
  }

  [data-gutter] [data-drag-range] {
    position: relative;
  }

  [data-gutter] [data-drag-range]::after {
    content: "";
    position: absolute;
    z-index: 2;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
    pointer-events: none;
  }

  [data-gutter] [data-drag-range="first"]::after {
    top: 50%;
  }

  [data-gutter] [data-drag-range="last"]::after {
    bottom: 50%;
  }

  [data-gutter] [data-drag-range="single"]::after {
    display: none;
  }

  [data-utility-button] {
    position: relative;
    border-radius: var(--corner-compact);
    corner-shape: squircle;
    background: var(--accent);
    color: var(--accent-contrast);
  }
`

interface DragLine {
  index: number
  lineNumber: number
}

export interface DragLineGeometry extends DragLine {
  top: number
  bottom: number
}

interface MeasuredDragLine extends DragLineGeometry {
  element: HTMLElement
}

interface DragGuideState {
  side: HTMLElement
  sideName: 'additions' | 'deletions'
  start: DragLine
  current: DragLine
  lines: MeasuredDragLine[]
  elementsByIndex: Map<number, HTMLElement[]>
  renderedRange: { first: number; last: number } | null
  geometryStale: boolean
  moved: boolean
  pointerId: number
  captureTarget: HTMLElement
}

interface DragGuideBinding {
  onRangeSelected(range: SelectedLineRange): void
  invalidateGeometry(): void
  teardown(): void
}

const dragGuideBindings = new WeakMap<HTMLElement, DragGuideBinding>()

function measureDragLines(side: HTMLElement): {
  lines: MeasuredDragLine[]
  elementsByIndex: Map<number, HTMLElement[]>
} {
  const lines: MeasuredDragLine[] = []
  for (const element of side.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    const lineNumber = Number(element.dataset.columnNumber)
    if (!Number.isFinite(index) || !Number.isFinite(lineNumber)) continue
    const bounds = element.getBoundingClientRect()
    lines.push({ index, lineNumber, top: bounds.top, bottom: bounds.bottom, element })
  }
  lines.sort((left, right) => left.top - right.top)

  const elementsByIndex = new Map<number, HTMLElement[]>()
  for (const element of side.querySelectorAll<HTMLElement>('[data-line-index]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    if (!Number.isFinite(index)) continue
    const elements = elementsByIndex.get(index)
    if (elements == null) elementsByIndex.set(index, [element])
    else elements.push(element)
  }
  return { lines, elementsByIndex }
}

export function findClosestDragLine(
  lines: readonly DragLineGeometry[],
  pointerY: number
): DragLine | null {
  if (lines.length === 0) return null
  let low = 0
  let high = lines.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const line = lines[middle]!
    const center = line.top + (line.bottom - line.top) / 2
    if (center < pointerY) low = middle + 1
    else high = middle
  }
  if (low === 0) return lines[0]!
  if (low === lines.length) return lines[lines.length - 1]!
  const before = lines[low - 1]!
  const after = lines[low]!
  const beforeCenter = before.top + (before.bottom - before.top) / 2
  const afterCenter = after.top + (after.bottom - after.top) / 2
  return pointerY - beforeCenter <= afterCenter - pointerY ? before : after
}

function renderDragGuide(drag: DragGuideState, endIndex: number): void {
  const startIndex = drag.start.index
  const firstIndex = Math.min(startIndex, endIndex)
  const lastIndex = Math.max(startIndex, endIndex)

  for (const [index, elements] of drag.elementsByIndex) {
    const boundary = index < firstIndex || index > lastIndex
      ? null
      : firstIndex === lastIndex
        ? 'single'
        : index === firstIndex
          ? 'first'
          : index === lastIndex
            ? 'last'
            : ''
    const wasInRange = drag.renderedRange != null
      && index >= drag.renderedRange.first
      && index <= drag.renderedRange.last
    if (boundary == null && !wasInRange) continue
    for (const element of elements) {
      if (boundary == null) {
        if (element.hasAttribute('data-drag-range')) element.removeAttribute('data-drag-range')
      } else if (element.getAttribute('data-drag-range') !== boundary) {
        element.setAttribute('data-drag-range', boundary)
      }
    }
  }
  drag.renderedRange = { first: firstIndex, last: lastIndex }
}

function clearDragGuide(root: ShadowRoot): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-drag-range]')) {
    element.removeAttribute('data-drag-range')
  }
}

export function syncDragGuideLifecycle(
  node: HTMLElement,
  phase: string,
  onRangeSelected: (range: SelectedLineRange) => void
): void {
  if (phase === 'unmount') {
    dragGuideBindings.get(node)?.teardown()
    dragGuideBindings.delete(node)
    return
  }
  const existingBinding = dragGuideBindings.get(node)
  if (existingBinding != null) {
    existingBinding.onRangeSelected = onRangeSelected
    if (phase === 'update') existingBinding.invalidateGeometry()
    return
  }
  if (node.shadowRoot == null) return

  const root = node.shadowRoot
  let drag: DragGuideState | null = null
  let suppressClick = false
  const binding: DragGuideBinding = {
    onRangeSelected,
    invalidateGeometry: () => {
      if (drag != null) drag.geometryStale = true
    },
    teardown: () => undefined
  }

  const refreshGeometry = (current: DragGuideState): boolean => {
    const measured = measureDragLines(current.side)
    if (measured.lines.length === 0) return false
    current.lines = measured.lines
    current.elementsByIndex = measured.elementsByIndex
    current.geometryStale = false
    return true
  }

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const utilityButton = pointerEvent.composedPath().find(
      (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-utility-button')
    )
    if (utilityButton == null) return

    const side = utilityButton.closest<HTMLElement>('[data-additions], [data-deletions]')
    if (side == null) return
    const measured = measureDragLines(side)
    const start = findClosestDragLine(measured.lines, pointerEvent.clientY)
    if (start == null) return

    drag = {
      side,
      sideName: side.hasAttribute('data-deletions') ? 'deletions' : 'additions',
      start,
      current: start,
      lines: measured.lines,
      elementsByIndex: measured.elementsByIndex,
      renderedRange: null,
      geometryStale: false,
      moved: false,
      pointerId: pointerEvent.pointerId,
      captureTarget: utilityButton
    }
    utilityButton.setPointerCapture?.(pointerEvent.pointerId)
    renderDragGuide(drag, start.index)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    if (drag.geometryStale && !refreshGeometry(drag)) return
    const current = findClosestDragLine(drag.lines, pointerEvent.clientY)
    if (current == null) return

    pointerEvent.preventDefault()
    drag.current = current
    drag.moved ||= current.index !== drag.start.index
    renderDragGuide(drag, current.index)
  }

  const onPointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    const completedDrag = drag
    drag = null
    if (completedDrag.captureTarget.hasPointerCapture?.(completedDrag.pointerId)) {
      completedDrag.captureTarget.releasePointerCapture(completedDrag.pointerId)
    }

    if (completedDrag.moved) {
      suppressClick = true
      event.preventDefault()
      event.stopImmediatePropagation()
      binding.onRangeSelected({
        start: Math.min(completedDrag.start.lineNumber, completedDrag.current.lineNumber),
        end: Math.max(completedDrag.start.lineNumber, completedDrag.current.lineNumber),
        side: completedDrag.sideName
      })
      window.setTimeout(() => { suppressClick = false }, 0)
    }

    window.requestAnimationFrame(() => clearDragGuide(root))
  }

  const onPointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    drag = null
    window.requestAnimationFrame(() => clearDragGuide(root))
  }

  const onClick = (event: Event): void => {
    if (!suppressClick) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const scrollContainer = node.closest<HTMLElement>('.multi-file-code-view, .diff-scroll')
  const onScroll = (): void => {
    if (drag != null) drag.geometryStale = true
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', onPointerUp, true)
  root.addEventListener('pointercancel', onPointerCancel, true)
  root.addEventListener('click', onClick, true)
  scrollContainer?.addEventListener('scroll', onScroll, { passive: true })

  binding.teardown = () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', onPointerUp, true)
    root.removeEventListener('pointercancel', onPointerCancel, true)
    root.removeEventListener('click', onClick, true)
    scrollContainer?.removeEventListener('scroll', onScroll)
    clearDragGuide(root)
  }
  dragGuideBindings.set(node, binding)
}
