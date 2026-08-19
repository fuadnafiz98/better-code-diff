export const MIN_CODE_ZOOM_FONT_SIZE = 8
export const MAX_CODE_ZOOM_FONT_SIZE = 32

const CODE_ZOOM_SENSITIVITY = 0.01
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

export function nextCodeZoomFontSize(
  currentFontSize: number,
  deltaY: number,
  deltaMode = 0,
  viewportHeight = 800
): number {
  const pixelDelta = deltaMode === DOM_DELTA_LINE
    ? deltaY * 16
    : deltaMode === DOM_DELTA_PAGE
      ? deltaY * viewportHeight
      : deltaY
  const nextFontSize = currentFontSize * Math.exp(-pixelDelta * CODE_ZOOM_SENSITIVITY)
  return Math.round(Math.min(MAX_CODE_ZOOM_FONT_SIZE, Math.max(MIN_CODE_ZOOM_FONT_SIZE, nextFontSize)) * 100) / 100
}

export function anchoredScrollOffset(scrollOffset: number, pointerOffset: number, scaleRatio: number): number {
  return Math.max(0, (scrollOffset + pointerOffset) * scaleRatio - pointerOffset)
}
