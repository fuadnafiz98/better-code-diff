import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_KEYBINDINGS,
  commandFromEvent,
  findKeybindingConflicts,
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
