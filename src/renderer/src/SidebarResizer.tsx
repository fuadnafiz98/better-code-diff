import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'

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

  const resizeFromPointer = useCallback((resizer: HTMLDivElement, pointerX: number) => {
    const workspace = getWorkspace(resizer)
    if (workspace == null) return
    const bounds = workspace.getBoundingClientRect()
    const width = clampSidebarWidth(pointerX - bounds.left, bounds.width)
    liveWidthRef.current = width
    applyWidth(workspace, width)
  }, [])

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
        resizeFromPointer(event.currentTarget, event.clientX)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        resizeFromPointer(event.currentTarget, event.clientX)
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const workspace = getWorkspace(event.currentTarget)
        event.currentTarget.releasePointerCapture(event.pointerId)
        if (workspace != null) delete workspace.dataset.resizing
        commitWidth(liveWidthRef.current)
      }}
      onPointerCancel={(event) => {
        const workspace = getWorkspace(event.currentTarget)
        if (workspace != null) delete workspace.dataset.resizing
        commitWidth(liveWidthRef.current)
      }}
      onDoubleClick={(event) => {
        const workspace = getWorkspace(event.currentTarget)
        if (workspace == null) return
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
