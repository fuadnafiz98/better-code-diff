import { afterEach, describe, expect, it } from 'bun:test'

import { DEFAULT_KEYBINDINGS } from './keybindings'
import { getEditorThemeType, KEYBINDINGS_VERSION, loadKeybindings, loadPreferences } from './preferences'

afterEach(() => localStorage.clear())

describe('getEditorThemeType', () => {
  it('classifies bundled light and dark themes', () => {
    expect(getEditorThemeType('pierre-light')).toBe('light')
    expect(getEditorThemeType('light-plus')).toBe('light')
    expect(getEditorThemeType('pierre-dark-soft')).toBe('dark')
  })
})

describe('loadPreferences', () => {
  it('loads autosave and clamps terminal scrollback', () => {
    localStorage.setItem('better-code-diff:preferences:v1', JSON.stringify({
      autosaveOnBlur: true,
      terminalScrollback: 100_000
    }))
    const preferences = loadPreferences()
    expect(preferences.autosaveOnBlur).toBe(true)
    expect(preferences.terminalScrollback).toBe(50_000)
  })
})

describe('loadKeybindings', () => {
  it('keeps a rebound shortcut', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Shift+KeyY' }, undefined).toggleFoldUnchanged)
      .toBe('Meta+Shift+KeyY')
  })

  it('migrates a saved copy of a retired default to the new default', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Alt+KeyF' }, undefined).toggleFoldUnchanged)
      .toBe(DEFAULT_KEYBINDINGS.toggleFoldUnchanged)
  })

  it('keeps ⌘⌥F once the migration has already run', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Alt+KeyF' }, KEYBINDINGS_VERSION).toggleFoldUnchanged)
      .toBe('Meta+Alt+KeyF')
  })

  it('falls back to the defaults when nothing was saved', () => {
    expect(loadKeybindings(undefined, undefined)).toEqual(DEFAULT_KEYBINDINGS)
  })
})
