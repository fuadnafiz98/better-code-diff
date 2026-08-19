import { describe, expect, it, test } from 'bun:test'

import {
  DEFAULT_KEYBINDINGS,
  commandFromEvent,
  findKeybindingConflicts,
  reviewCommandFromEvent,
  formatKeybinding,
  keybindingFromEvent
} from './keybindings'

function keyboardEvent(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers } as KeyboardEvent
}

describe('keybindings', () => {
  test('normalizes and matches macOS shortcuts', () => {
    const event = keyboardEvent('KeyB', { metaKey: true })
    expect(keybindingFromEvent(event)).toBe('Meta+KeyB')
    expect(commandFromEvent(event, DEFAULT_KEYBINDINGS)).toBe('toggleSidebar')
    expect(formatKeybinding('Meta+Shift+KeyF')).toBe('⇧⌘F')
    expect(commandFromEvent(keyboardEvent('KeyK', { metaKey: true }), DEFAULT_KEYBINDINGS)).toBe('openCommandPalette')
  })

  test('rejects unmodified typing keys', () => {
    expect(keybindingFromEvent(keyboardEvent('KeyB'))).toBeNull()
  })

  test('reports both commands that share a shortcut', () => {
    const conflicts = findKeybindingConflicts({
      ...DEFAULT_KEYBINDINGS,
      openFolder: DEFAULT_KEYBINDINGS.toggleSidebar
    })
    expect(conflicts).toEqual(new Set(['openFolder', 'toggleSidebar']))
  })
})

describe('reviewCommandFromEvent', () => {
  const event = (code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent

  it('maps the review shortcut keys', () => {
    expect(reviewCommandFromEvent(event('BracketRight'), null)).toBe('nextReviewFile')
    expect(reviewCommandFromEvent(event('BracketLeft'), null)).toBe('previousReviewFile')
    expect(reviewCommandFromEvent(event('KeyV'), null)).toBe('toggleReviewViewed')
    expect(reviewCommandFromEvent(event('KeyC'), null)).toBe('toggleReviewCollapsed')
  })

  it('ignores unmapped keys and modified presses', () => {
    expect(reviewCommandFromEvent(event('KeyX'), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyC', { metaKey: true }), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV', { shiftKey: true }), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyC', { altKey: true }), null)).toBeNull()
  })

  it('yields to typing surfaces', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as Element
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as Element
    const editable = { tagName: 'DIV', isContentEditable: true } as unknown as Element
    const button = { tagName: 'BUTTON', isContentEditable: false } as unknown as Element
    expect(reviewCommandFromEvent(event('KeyV'), textarea)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), input)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), editable)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), button)).toBe('toggleReviewViewed')
  })
})
