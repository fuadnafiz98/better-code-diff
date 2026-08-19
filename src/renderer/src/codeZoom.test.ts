import { describe, expect, it } from 'bun:test'

import {
  anchoredScrollOffset,
  MAX_CODE_ZOOM_FONT_SIZE,
  MIN_CODE_ZOOM_FONT_SIZE,
  nextCodeZoomFontSize
} from './codeZoom'

describe('code zoom', () => {
  it('zooms in and out continuously from trackpad wheel deltas', () => {
    expect(nextCodeZoomFontSize(13, -10)).toBeGreaterThan(13)
    expect(nextCodeZoomFontSize(13, 10)).toBeLessThan(13)
  })

  it('keeps the font size inside the readable range', () => {
    expect(nextCodeZoomFontSize(13, -10_000)).toBe(MAX_CODE_ZOOM_FONT_SIZE)
    expect(nextCodeZoomFontSize(13, 10_000)).toBe(MIN_CODE_ZOOM_FONT_SIZE)
  })

  it('keeps the content below the gesture focal point stationary', () => {
    expect(anchoredScrollOffset(400, 200, 1.5)).toBe(700)
    expect(anchoredScrollOffset(0, 100, 0.5)).toBe(0)
  })
})
