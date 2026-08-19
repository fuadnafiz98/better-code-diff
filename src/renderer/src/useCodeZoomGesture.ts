import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { anchoredScrollOffset, nextCodeZoomFontSize } from './codeZoom'

interface ScrollTarget {
  element: HTMLElement
  offset: number
}

interface PendingZoomAnchor {
  horizontal: ScrollTarget | null
  vertical: ScrollTarget | null
}

interface CodeZoomGesture {
  codeFontSize: number
  codeLineHeight: number
  surfaceRef: RefObject<HTMLElement | null>
}

interface CodeZoomState {
  baseFontSize: number
  fontSize: number
}

const ZOOM_LAYOUT_SETTLE_MS = 1_200

function overflowAllowsScrolling(element: HTMLElement, axis: 'horizontal' | 'vertical'): boolean {
  const style = window.getComputedStyle(element)
  const overflow = axis === 'horizontal' ? style.overflowX : style.overflowY
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
}

function findScrollElement(event: WheelEvent, axis: 'horizontal' | 'vertical'): HTMLElement | null {
  const elements = event.composedPath().filter((target): target is HTMLElement => target instanceof HTMLElement)
  if (axis === 'vertical') {
    const viewerScroll = elements.find((element) => (
      element.classList.contains('diff-scroll') || element.classList.contains('multi-file-code-view')
    ))
    if (viewerScroll != null) return viewerScroll
  }
  const hasOverflow = (element: HTMLElement): boolean => axis === 'horizontal'
    ? element.scrollWidth > element.clientWidth + 1
    : element.scrollHeight > element.clientHeight + 1
  return elements.find((element) => overflowAllowsScrolling(element, axis) && hasOverflow(element))
    ?? elements.find((element) => overflowAllowsScrolling(element, axis))
    ?? null
}

function pointerOffsetWithin(element: HTMLElement, clientPosition: number, axis: 'horizontal' | 'vertical'): number {
  const bounds = element.getBoundingClientRect()
  const start = axis === 'horizontal' ? bounds.left : bounds.top
  const size = axis === 'horizontal' ? bounds.width : bounds.height
  return Math.min(size, Math.max(0, clientPosition - start))
}

export function useCodeZoomGesture(baseFontSize: number, baseLineHeight: number): CodeZoomGesture {
  const surfaceRef = useRef<HTMLElement>(null)
  const [zoom, setZoom] = useState<CodeZoomState>({ baseFontSize, fontSize: baseFontSize })
  const codeFontSize = zoom.baseFontSize === baseFontSize ? zoom.fontSize : baseFontSize
  const currentFontSizeRef = useRef(codeFontSize)
  const baseFontSizeRef = useRef(baseFontSize)
  const activeAnchorRef = useRef<PendingZoomAnchor | null>(null)
  const anchorFrameRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    currentFontSizeRef.current = codeFontSize
    baseFontSizeRef.current = baseFontSize
  }, [baseFontSize, codeFontSize])

  useEffect(() => {
    const surface = surfaceRef.current
    if (surface == null) return
    let anchorRestoreQueued = false
    const cancelAnchor = (): void => {
      activeAnchorRef.current = null
      if (anchorFrameRef.current != null) window.cancelAnimationFrame(anchorFrameRef.current)
      anchorFrameRef.current = null
    }
    const restoreActiveAnchor = (event: Event): void => {
      const target = event.target
      const anchor = activeAnchorRef.current
      if (!(target instanceof HTMLElement) || anchor == null || anchorRestoreQueued) return
      if (anchor.horizontal?.element !== target && anchor.vertical?.element !== target) return
      anchorRestoreQueued = true
      queueMicrotask(() => {
        anchorRestoreQueued = false
        const currentAnchor = activeAnchorRef.current
        if (currentAnchor?.horizontal?.element === target
          && Math.abs(target.scrollLeft - currentAnchor.horizontal.offset) > 0.5) {
          target.scrollLeft = currentAnchor.horizontal.offset
        }
        if (currentAnchor?.vertical?.element === target
          && Math.abs(target.scrollTop - currentAnchor.vertical.offset) > 0.5) {
          target.scrollTop = currentAnchor.vertical.offset
        }
      })
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        cancelAnchor()
        return
      }
      if (event.deltaY === 0) return
      event.preventDefault()

      const currentFontSize = currentFontSizeRef.current
      const nextFontSize = nextCodeZoomFontSize(currentFontSize, event.deltaY, event.deltaMode, window.innerHeight)
      if (nextFontSize === currentFontSize) return

      const ratio = nextFontSize / currentFontSize
      const previousAnchor = activeAnchorRef.current
      const verticalElement = findScrollElement(event, 'vertical')
      const horizontalElement = findScrollElement(event, 'horizontal')
      const verticalOffset = verticalElement == null
        ? null
        : anchoredScrollOffset(
            previousAnchor?.vertical?.element === verticalElement ? previousAnchor.vertical.offset : verticalElement.scrollTop,
            pointerOffsetWithin(verticalElement, event.clientY, 'vertical'),
            ratio
          )
      const horizontalOffset = horizontalElement == null
        ? null
        : anchoredScrollOffset(
            previousAnchor?.horizontal?.element === horizontalElement ? previousAnchor.horizontal.offset : horizontalElement.scrollLeft,
            pointerOffsetWithin(horizontalElement, event.clientX, 'horizontal'),
            ratio
          )

      activeAnchorRef.current = {
        horizontal: horizontalElement == null || horizontalOffset == null
          ? null
          : { element: horizontalElement, offset: horizontalOffset },
        vertical: verticalElement == null || verticalOffset == null
          ? null
          : { element: verticalElement, offset: verticalOffset }
      }
      currentFontSizeRef.current = nextFontSize
      setZoom({ baseFontSize: baseFontSizeRef.current, fontSize: nextFontSize })
    }
    surface.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    surface.addEventListener('pointerdown', cancelAnchor, { capture: true })
    surface.addEventListener('scroll', restoreActiveAnchor, { capture: true })
    return () => {
      cancelAnchor()
      surface.removeEventListener('wheel', handleWheel, { capture: true })
      surface.removeEventListener('pointerdown', cancelAnchor, { capture: true })
      surface.removeEventListener('scroll', restoreActiveAnchor, { capture: true })
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = activeAnchorRef.current
    if (anchor == null) return
    if (anchorFrameRef.current != null) window.cancelAnimationFrame(anchorFrameRef.current)
    const startedAt = performance.now()
    let frameId: number | null = null
    const holdAnchor = (): void => {
      if (activeAnchorRef.current !== anchor) return
      if (anchor.horizontal != null && Math.abs(anchor.horizontal.element.scrollLeft - anchor.horizontal.offset) > 0.5) {
        anchor.horizontal.element.scrollLeft = anchor.horizontal.offset
      }
      if (anchor.vertical != null && Math.abs(anchor.vertical.element.scrollTop - anchor.vertical.offset) > 0.5) {
        anchor.vertical.element.scrollTop = anchor.vertical.offset
      }
      if (performance.now() - startedAt < ZOOM_LAYOUT_SETTLE_MS) {
        frameId = window.requestAnimationFrame(holdAnchor)
        anchorFrameRef.current = frameId
      } else {
        activeAnchorRef.current = null
        anchorFrameRef.current = null
      }
    }
    holdAnchor()
    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId)
      if (anchorFrameRef.current === frameId) anchorFrameRef.current = null
    }
  }, [codeFontSize])

  const codeLineHeight = useMemo(
    () => Math.round(baseLineHeight * (codeFontSize / baseFontSize) * 100) / 100,
    [baseFontSize, baseLineHeight, codeFontSize]
  )

  return { codeFontSize, codeLineHeight, surfaceRef }
}
