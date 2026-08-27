import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'

import { withResistance } from './rubberband'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth
} from './sidebarWidth'

const KEYBOARD_RESIZE_STEP = 16

function getWorkspace(resizer: HTMLDivElement): HTMLDivElement | null {
  return resizer.parentElement instanceof HTMLDivElement ? resizer.parentElement : null
}

function applyWidth(workspace: HTMLDivElement, width: number): void {
  workspace.style.setProperty('--sidebar-width', `${width}px`)
}

export const SidebarResizer = memo(function SidebarResizer(): React.JSX.Element {
  const resizerRef = useRef<HTMLDivElement>(null)
  const [committedWidth, setCommittedWidth] = useState(loadSidebarWidth)
  const liveWidthRef = useRef(committedWidth)

  useLayoutEffect(() => {
    const workspace = resizerRef.current == null ? null : getWorkspace(resizerRef.current)
    if (workspace == null) return

    const boundedWidth = clampSidebarWidth(
      committedWidth,
      workspace.getBoundingClientRect().width
    )
    liveWidthRef.current = boundedWidth
    applyWidth(workspace, boundedWidth)
    if (boundedWidth !== committedWidth) {
      setCommittedWidth(boundedWidth)
      saveSidebarWidth(boundedWidth)
    }
  }, [committedWidth])

  const commitWidth = useCallback((width: number) => {
    liveWidthRef.current = width
    setCommittedWidth(width)
    saveSidebarWidth(width)
  }, [])

  // Mapping pointer X straight onto the width snaps the divider to the pointer on
  // the first frame, by however far from its edge the 5px handle was grabbed.
  // Carrying the grab offset keeps the drag 1:1 from the moment it starts.
  const dragRef = useRef<{ pointerX: number; width: number } | null>(null)

  // Past a bound the pointer keeps moving while a hard clamp freezes the divider,
  // which reads as the app hanging. Resistance during the drag says "nothing more
  // here"; the value that is committed on release is still hard-clamped.
  const resizeFromPointer = useCallback((resizer: HTMLDivElement, pointerX: number) => {
    const workspace = getWorkspace(resizer)
    const drag = dragRef.current
    if (workspace == null || drag == null) return
    const bounds = workspace.getBoundingClientRect()
    const raw = drag.width + (pointerX - drag.pointerX)
    const maximum = clampSidebarWidth(MAX_SIDEBAR_WIDTH, bounds.width)
    liveWidthRef.current = clampSidebarWidth(raw, bounds.width)
    applyWidth(workspace, Math.round(withResistance(raw, MIN_SIDEBAR_WIDTH, maximum, bounds.width)))
  }, [])

  const endDrag = useCallback((resizer: HTMLDivElement) => {
    if (dragRef.current == null) return
    dragRef.current = null
    const workspace = getWorkspace(resizer)
    if (workspace == null) return
    delete workspace.dataset.resizing
    // The overshoot has to be written back or the sidebar stays stretched.
    applyWidth(workspace, liveWidthRef.current)
    commitWidth(liveWidthRef.current)
  }, [commitWidth])

  return (
    <div
      ref={resizerRef}
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize file explorer"
      aria-controls="repository-explorer repository-diff"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={committedWidth}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const workspace = getWorkspace(event.currentTarget)
        if (workspace == null) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        workspace.dataset.resizing = 'sidebar'
        dragRef.current = { pointerX: event.clientX, width: liveWidthRef.current }
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        resizeFromPointer(event.currentTarget, event.clientX)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        endDrag(event.currentTarget)
      }}
      onPointerCancel={(event) => endDrag(event.currentTarget)}
      // Losing capture without a pointerup would otherwise strand the col-resize
      // cursor on the whole workspace and drop the width the user dragged to.
      onLostPointerCapture={(event) => endDrag(event.currentTarget)}
      onDoubleClick={(event) => {
        const workspace = getWorkspace(event.currentTarget)
        if (workspace == null) return
        dragRef.current = null
        applyWidth(workspace, DEFAULT_SIDEBAR_WIDTH)
        commitWidth(DEFAULT_SIDEBAR_WIDTH)
      }}
      onKeyDown={(event) => {
        const workspace = getWorkspace(event.currentTarget)
        if (workspace == null) return
        const workspaceWidth = workspace.getBoundingClientRect().width
        let nextWidth = committedWidth

        if (event.key === 'ArrowLeft') nextWidth -= KEYBOARD_RESIZE_STEP
        else if (event.key === 'ArrowRight') nextWidth += KEYBOARD_RESIZE_STEP
        else if (event.key === 'Home') nextWidth = MIN_SIDEBAR_WIDTH
        else if (event.key === 'End') nextWidth = MAX_SIDEBAR_WIDTH
        else return

        event.preventDefault()
        nextWidth = clampSidebarWidth(nextWidth, workspaceWidth)
        applyWidth(workspace, nextWidth)
        commitWidth(nextWidth)
      }}
    />
  )
})
