import type { SelectedLineRange } from '@pierre/diffs'

export const DRAG_SELECTION_CSS = `
  [data-selected-line],
  [data-drag-range] {
    background: rgba(64, 139, 230, 0.16) !important;
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
    background: #58a6ff;
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
    border-radius: 7px;
    corner-shape: squircle;
    background: #58a6ff;
    color: #07111f;
  }
`

interface DragLine {
  index: number
  lineNumber: number
}

interface DragGuideState {
  side: HTMLElement
  sideName: 'additions' | 'deletions'
  start: DragLine
  current: DragLine
  moved: boolean
  pointerId: number
  captureTarget: HTMLElement
}

interface DragGuideBinding {
  onRangeSelected(range: SelectedLineRange): void
  teardown(): void
}

const dragGuideBindings = new WeakMap<HTMLElement, DragGuideBinding>()

function findClosestGutterLine(side: HTMLElement, pointerY: number): DragLine | null {
  const lines = [...side.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')]
  let closest: { distance: number; line: DragLine } | null = null

  for (const element of lines) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    const lineNumber = Number(element.dataset.columnNumber)
    if (!Number.isFinite(index) || !Number.isFinite(lineNumber)) continue

    const bounds = element.getBoundingClientRect()
    const distance = Math.abs(pointerY - (bounds.top + bounds.height / 2))
    if (closest == null || distance < closest.distance) {
      closest = { distance, line: { index, lineNumber } }
    }
  }

  return closest?.line ?? null
}

function renderDragGuide(side: HTMLElement, startIndex: number, endIndex: number): void {
  const firstIndex = Math.min(startIndex, endIndex)
  const lastIndex = Math.max(startIndex, endIndex)

  for (const element of side.querySelectorAll<HTMLElement>('[data-line-index]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    if (index < firstIndex || index > lastIndex) {
      element.removeAttribute('data-drag-range')
      continue
    }

    const boundary = firstIndex === lastIndex
      ? 'single'
      : index === firstIndex
        ? 'first'
        : index === lastIndex
          ? 'last'
          : ''
    element.setAttribute('data-drag-range', boundary)
  }
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
    return
  }
  if (node.shadowRoot == null) return

  const root = node.shadowRoot
  let drag: DragGuideState | null = null
  let suppressClick = false
  const binding: DragGuideBinding = {
    onRangeSelected,
    teardown: () => undefined
  }

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const utilityButton = pointerEvent.composedPath().find(
      (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-utility-button')
    )
    if (utilityButton == null) return

    const side = utilityButton.closest<HTMLElement>('[data-additions], [data-deletions]')
    if (side == null) return
    const start = findClosestGutterLine(side, pointerEvent.clientY)
    if (start == null) return

    drag = {
      side,
      sideName: side.hasAttribute('data-deletions') ? 'deletions' : 'additions',
      start,
      current: start,
      moved: false,
      pointerId: pointerEvent.pointerId,
      captureTarget: utilityButton
    }
    utilityButton.setPointerCapture?.(pointerEvent.pointerId)
    renderDragGuide(side, start.index, start.index)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    const current = findClosestGutterLine(drag.side, pointerEvent.clientY)
    if (current == null) return

    pointerEvent.preventDefault()
    drag.current = current
    drag.moved ||= current.index !== drag.start.index
    renderDragGuide(drag.side, drag.start.index, current.index)
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

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', onPointerUp, true)
  root.addEventListener('pointercancel', onPointerCancel, true)
  root.addEventListener('click', onClick, true)

  binding.teardown = () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', onPointerUp, true)
    root.removeEventListener('pointercancel', onPointerCancel, true)
    root.removeEventListener('click', onClick, true)
    clearDragGuide(root)
  }
  dragGuideBindings.set(node, binding)
}
