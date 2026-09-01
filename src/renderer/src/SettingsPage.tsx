import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { IconBraces, IconFileCode, IconGear, IconReload, IconX } from '@pierre/icons'

import { SelectControl } from './SelectControl'

import {
  CODE_FONTS,
  DEFAULT_PREFERENCES,
  EDITOR_THEME_GROUPS,
  EDITOR_THEMES,
  getEditorThemeType,
  INTERFACE_FONTS,
  type AppPreferences,
  type CodeFont,
  type EditorTheme,
  type InterfaceFont
} from './preferences'
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_COMMANDS,
  findKeybindingConflicts,
  formatKeybinding,
  keybindingFromEvent,
  type AppCommand
} from './keybindings'
import { EDITOR_SHORTCUTS, findEditorKeymapConflicts } from './editor/editorKeymap'

interface SettingsPageProps {
  preferences: AppPreferences
  onChange(preferences: AppPreferences): void
  onClose(): void
}

type SettingsSection = 'appearance' | 'editor' | 'keyboard'

const SETTINGS_EXIT_MS = 160

export function SettingsPage({ preferences, onChange, onClose }: SettingsPageProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
  const [closing, setClosing] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeTimerRef = useRef(0)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    // showModal contains focus and dims the titlebar behind the scrim, which is
    // what the overlay already looked like it was doing.
    if (dialog != null && !dialog.open) dialog.showModal()
    return () => {
      window.clearTimeout(closeTimerRef.current)
      if (dialog?.open) dialog.close()
    }
  }, [])

  // The parent unmounts this surface, so the exit has to finish before it is told
  // the overlay is closed.
  const requestClose = useCallback(() => {
    if (closeTimerRef.current !== 0) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(onClose, SETTINGS_EXIT_MS)
  }, [onClose])

  const update = <Key extends keyof AppPreferences>(key: Key, value: AppPreferences[Key]): void => {
    const nextPreferences = { ...preferences, [key]: value }
    if (key !== 'editorTheme') {
      onChange(nextPreferences)
      return
    }
    document.documentElement.dataset.themeSwitching = 'true'
    flushSync(() => onChange(nextPreferences))
    void document.body.offsetHeight
    requestAnimationFrame(() => requestAnimationFrame(() => {
      delete document.documentElement.dataset.themeSwitching
    }))
  }

  const codeStyle = {
    fontFamily: CODE_FONTS[preferences.codeFont].fontFamily,
    fontSize: `${preferences.codeFontSize}px`,
    lineHeight: `${preferences.codeLineHeight}px`
  }
  const keybindingConflicts = useMemo(
    () => findKeybindingConflicts(preferences.keybindings),
    [preferences.keybindings]
  )
  // An app shortcut rebound onto ⌘F/⌘D/⌘⌥F/⌘Z/⌘/ only works outside the editor,
  // because while the caret is in the editor its own command wins.
  const editorConflicts = useMemo(() => {
    const labels = new Map<AppCommand, string>()
    for (const { command, shortcut, editorCommand } of findEditorKeymapConflicts(preferences.keybindings)) {
      const hint = EDITOR_SHORTCUTS.find((entry) => entry.shortcut === shortcut)
      labels.set(command, hint?.label ?? editorCommand)
    }
    return labels
  }, [preferences.keybindings])

  return (
    <dialog
      ref={dialogRef}
      className="settings-page"
      aria-label="Settings"
      data-state={closing ? 'closing' : undefined}
      onCancel={(event) => {
        event.preventDefault()
        requestClose()
      }}
    >
      <aside className="settings-sidebar">
        <header><IconGear /><strong>Settings</strong></header>
        <nav aria-label="Settings sections">
          <button className={activeSection === 'appearance' ? 'active' : undefined} type="button" onClick={() => setActiveSection('appearance')}><IconGear />Appearance</button>
          <button className={activeSection === 'editor' ? 'active' : undefined} type="button" onClick={() => setActiveSection('editor')}><IconFileCode />Editor</button>
          <button className={activeSection === 'keyboard' ? 'active' : undefined} type="button" onClick={() => setActiveSection('keyboard')}><IconBraces />Keyboard</button>
        </nav>
        <button className="settings-reset" type="button" onClick={() => onChange(DEFAULT_PREFERENCES)}><IconReload />Reset defaults</button>
      </aside>

      <div className="settings-content">
        <header className="settings-header">
          <div>
            <h1>{activeSection === 'appearance' ? 'Appearance' : activeSection === 'editor' ? 'Editor' : 'Keyboard'}</h1>
            <p>{activeSection === 'appearance'
              ? 'Choose how Horus looks.'
              : activeSection === 'editor'
                ? 'Configure code rendering and comparison behavior.'
                : 'Customize shortcuts for frequent actions.'}</p>
          </div>
          <button className="icon-button" type="button" onClick={requestClose} aria-label="Close settings" title="Close Settings"><IconX /></button>
        </header>

        <div className="settings-scroll" key={activeSection}>
          {activeSection === 'appearance' ? (
            <div className="settings-section">
              <section className="settings-block">
                <div className="settings-block-heading"><h2>Theme</h2><p>Changes apply immediately and persist on this Mac.</p></div>
                {EDITOR_THEME_GROUPS.map((group) => (
                  <div className="theme-group" key={group.label}>
                    <h3>{group.label}</h3>
                    <div className="theme-gallery" role="radiogroup" aria-label={`${group.label} themes`}>
                      {group.themes.map((theme) => (
                        <ThemeCard key={theme} theme={theme} selected={preferences.editorTheme === theme} onSelect={() => update('editorTheme', theme)} />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
              <section className="settings-block settings-list-block">
                <div className="settings-block-heading"><h2>Interface</h2></div>
                <SettingRow controlId="interface-font" label="Interface font" description="Used by the title bar, explorer, settings, and controls.">
                  <SelectControl>
                    <select id="interface-font" name="interface-font" value={preferences.interfaceFont} onChange={(event) => update('interfaceFont', event.target.value as InterfaceFont)}>
                      {Object.entries(INTERFACE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
                    </select>
                  </SelectControl>
                </SettingRow>
                <SettingRow controlId="restore-last-folder" label="Reopen the last folder on launch" description="Only if it still exists; otherwise Horus starts on the welcome screen.">
                  <Toggle id="restore-last-folder" checked={preferences.restoreLastFolder} label="Reopen the last folder on launch" onChange={(checked) => update('restoreLastFolder', checked)} />
                </SettingRow>
              </section>
            </div>
          ) : null}

          {activeSection === 'editor' ? (
            <div className="settings-section">
              <section className="settings-preview">
                <header><span>Live preview</span><strong>{CODE_FONTS[preferences.codeFont].label} · {preferences.codeFontSize}px</strong></header>
                <pre style={codeStyle}><code><span>1</span> <i>const</i> review = <b>'diff-first'</b>{'\n'}<span>2</span> <i>if</i> (review) openComparison()</code></pre>
              </section>
              <section className="settings-block settings-list-block">
                <div className="settings-block-heading"><h2>Typography</h2></div>
                <SettingRow controlId="code-font" label="Code font" description="Fira Code is bundled with the app and does not depend on a system installation.">
                  <SelectControl>
                    <select id="code-font" name="code-font" value={preferences.codeFont} onChange={(event) => update('codeFont', event.target.value as CodeFont)}>
                      {Object.entries(CODE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
                    </select>
                  </SelectControl>
                </SettingRow>
                <SettingRow controlId="code-font-size" label="Font size" description={`${preferences.codeFontSize} pixels`}>
                  <RangeControl name="code-font-size" label="Code font size" min={10} max={20}
                    value={preferences.codeFontSize} onChange={(value) => update('codeFontSize', value)} />
                  <output>{preferences.codeFontSize}</output>
                </SettingRow>
                <SettingRow controlId="code-line-height" label="Line height" description={`${preferences.codeLineHeight} pixels`}>
                  <RangeControl name="code-line-height" label="Code line height" min={16} max={32}
                    value={preferences.codeLineHeight} onChange={(value) => update('codeLineHeight', value)} />
                  <output>{preferences.codeLineHeight}</output>
                </SettingRow>
              </section>
              <section className="settings-block settings-list-block">
                <div className="settings-block-heading"><h2>Comparison</h2></div>
                <SettingRow controlId="show-line-numbers" label="Line numbers" description="Show line numbers in previews and comparisons."><Toggle id="show-line-numbers" checked={preferences.showLineNumbers} label="Show line numbers" onChange={(checked) => update('showLineNumbers', checked)} /></SettingRow>
                <SettingRow controlId="word-wrap" label="Word wrap" description="Wrap long lines instead of using horizontal scrolling."><Toggle id="word-wrap" checked={preferences.wordWrap} label="Wrap long lines" onChange={(checked) => update('wordWrap', checked)} /></SettingRow>
                <SettingRow controlId="fold-unchanged" label="Context folding" description="Collapse unchanged regions in Git comparisons."><Toggle id="fold-unchanged" checked={preferences.foldUnchanged} label="Fold unchanged regions" onChange={(checked) => update('foldUnchanged', checked)} /></SettingRow>
                <SettingRow controlId="autosave-on-blur" label="Save when focus leaves the editor" description="Optional. Disk conflicts still require your decision."><Toggle id="autosave-on-blur" checked={preferences.autosaveOnBlur} label="Save when focus leaves the editor" onChange={(checked) => update('autosaveOnBlur', checked)} /></SettingRow>
                <SettingRow controlId="terminal-scrollback" label="Terminal scrollback" description={`${preferences.terminalScrollback.toLocaleString()} lines`}>
                  <RangeControl name="terminal-scrollback" label="Terminal scrollback lines" min={1_000} max={50_000}
                    step={1_000} value={preferences.terminalScrollback} onChange={(value) => update('terminalScrollback', value)} />
                  <output>{preferences.terminalScrollback.toLocaleString()}</output>
                </SettingRow>
              </section>
            </div>
          ) : null}

          {activeSection === 'keyboard' ? (
            <div className="settings-section">
              <section className="settings-block settings-list-block">
                <div className="settings-block-heading"><h2>Keyboard shortcuts</h2><p>Select a shortcut, then press a new key combination. Conflicts appear immediately.</p></div>
                <div className="keybinding-list">
                  {KEYBINDING_COMMANDS.map(({ command, label, description }) => (
                    <SettingRow key={command} label={label} description={description}>
                      <KeybindingRecorder command={command} keybinding={preferences.keybindings[command]}
                        conflict={keybindingConflicts.has(command)}
                        editorConflict={editorConflicts.get(command)}
                        onChange={(keybinding) => update('keybindings', {
                          ...preferences.keybindings, [command]: keybinding
                        })} />
                    </SettingRow>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </dialog>
  )
}

function ThemeCard({ theme, selected, onSelect }: { theme: EditorTheme; selected: boolean; onSelect(): void }): React.JSX.Element {
  const themeType = getEditorThemeType(theme)
  return (
    <button className={`theme-card ${themeType} ${selected ? 'selected' : ''}`} data-theme={theme} type="button" role="radio"
      aria-checked={selected} onClick={onSelect}>
      <span className="theme-card-preview" aria-hidden="true">
        <span className="theme-preview-sidebar"><i /><i /><i /></span>
        <span className="theme-preview-editor"><i /><i /><i /><i /></span>
      </span>
      <span className="theme-card-label"><strong>{EDITOR_THEMES[theme]}</strong><i aria-hidden="true" /></span>
    </button>
  )
}

// A row whose control is labelable gets a real <label for>, so the whole 68px
// row activates it the way a macOS System Settings row does. Rows whose control
// is a button pair (the keybinding recorder) keep the inert span.
function SettingRow({ controlId, label, description, children }: {
  controlId?: string
  label: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-row">
      {controlId == null
        ? <span><strong>{label}</strong><small>{description}</small></span>
        : <label htmlFor={controlId}><strong>{label}</strong><small>{description}</small></label>}
      <span className="setting-control">{children}</span>
    </div>
  )
}

function KeybindingRecorder({
  command,
  keybinding,
  conflict,
  editorConflict,
  onChange
}: {
  command: AppCommand
  keybinding: string
  conflict: boolean
  editorConflict?: string
  onChange(keybinding: string): void
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)

  return (
    <div className="keybinding-recorder">
      {conflict ? <span className="keybinding-conflict" role="status">Conflict</span> : null}
      {!conflict && editorConflict != null ? (
        <span className="keybinding-conflict" role="status" title={`The editor uses this for ${editorConflict}.`}>
          Editor: {editorConflict}
        </span>
      ) : null}
      <button
        type="button"
        className={recording ? 'recording' : undefined}
        aria-label={`Change ${command} shortcut`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            setRecording(false)
            return
          }
          const nextKeybinding = keybindingFromEvent(event.nativeEvent)
          if (nextKeybinding == null) return
          onChange(nextKeybinding)
          setRecording(false)
        }}
      >
        <kbd>{recording ? 'Press shortcut' : formatKeybinding(keybinding)}</kbd>
      </button>
      <button
        type="button"
        className="keybinding-reset"
        onClick={() => onChange(DEFAULT_KEYBINDINGS[command])}
        disabled={keybinding === DEFAULT_KEYBINDINGS[command]}
      >
        Reset
      </button>
    </div>
  )
}

// Clearing the native appearance is what lets the thumb be a squircle, and it
// also removes the platform fill, so the filled portion is handed to CSS as a
// percentage instead.
function RangeControl({ name, label, min, max, step, value, onChange }: {
  name: string
  label: string
  min: number
  max: number
  step?: number
  value: number
  onChange(value: number): void
}): React.JSX.Element {
  return (
    <input
      className="range-control"
      id={name}
      name={name}
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={step ?? 1}
      value={value}
      style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

function Toggle({ id, checked, label, onChange }: { id: string; checked: boolean; label: string; onChange(checked: boolean): void }): React.JSX.Element {
  return (
    <input
      className="settings-toggle"
      id={id}
      name={id}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}
