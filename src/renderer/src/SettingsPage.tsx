import { useMemo, useState, type CSSProperties } from 'react'
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

interface SettingsPageProps {
  preferences: AppPreferences
  onChange(preferences: AppPreferences): void
  onClose(): void
}

type SettingsSection = 'appearance' | 'editor' | 'keyboard'

export function SettingsPage({ preferences, onChange, onClose }: SettingsPageProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance')
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

  return (
    <section className="settings-page" aria-label="Settings">
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
          <div className="settings-heading">
            <h1>{activeSection === 'appearance' ? 'Appearance' : activeSection === 'editor' ? 'Editor' : 'Keyboard'}</h1>
            <p>{activeSection === 'appearance'
              ? 'Choose how Horus looks.'
              : activeSection === 'editor'
                ? 'Configure code rendering and comparison behavior.'
                : 'Customize shortcuts for frequent actions.'}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close Settings"><IconX /></button>
        </header>

        <div className="settings-scroll">
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
                <SettingRow label="Interface font" description="Used by the title bar, explorer, settings, and controls.">
                  <SelectControl>
                    <select name="interface-font" aria-label="Interface font" value={preferences.interfaceFont} onChange={(event) => update('interfaceFont', event.target.value as InterfaceFont)}>
                      {Object.entries(INTERFACE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
                    </select>
                  </SelectControl>
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
                <SettingRow label="Code font" description="Fira Code is bundled with the app and does not depend on a system installation.">
                  <SelectControl>
                    <select name="code-font" aria-label="Code font" value={preferences.codeFont} onChange={(event) => update('codeFont', event.target.value as CodeFont)}>
                      {Object.entries(CODE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
                    </select>
                  </SelectControl>
                </SettingRow>
                <SettingRow label="Font size" description={`${preferences.codeFontSize} pixels`}>
                  <RangeControl name="code-font-size" label="Code font size" min={10} max={20}
                    value={preferences.codeFontSize} onChange={(value) => update('codeFontSize', value)} />
                  <output>{preferences.codeFontSize}</output>
                </SettingRow>
                <SettingRow label="Line height" description={`${preferences.codeLineHeight} pixels`}>
                  <RangeControl name="code-line-height" label="Code line height" min={16} max={32}
                    value={preferences.codeLineHeight} onChange={(value) => update('codeLineHeight', value)} />
                  <output>{preferences.codeLineHeight}</output>
                </SettingRow>
              </section>
              <section className="settings-block settings-list-block">
                <div className="settings-block-heading"><h2>Comparison</h2></div>
                <SettingRow label="Line numbers" description="Show line numbers in previews and comparisons."><Toggle checked={preferences.showLineNumbers} label="Show line numbers" onChange={(checked) => update('showLineNumbers', checked)} /></SettingRow>
                <SettingRow label="Word wrap" description="Wrap long lines instead of using horizontal scrolling."><Toggle checked={preferences.wordWrap} label="Wrap long lines" onChange={(checked) => update('wordWrap', checked)} /></SettingRow>
                <SettingRow label="Context folding" description="Collapse unchanged regions in Git comparisons."><Toggle checked={preferences.foldUnchanged} label="Fold unchanged regions" onChange={(checked) => update('foldUnchanged', checked)} /></SettingRow>
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
                        conflict={keybindingConflicts.has(command)} onChange={(keybinding) => update('keybindings', {
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
    </section>
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

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="setting-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="setting-control">{children}</span>
    </div>
  )
}

function KeybindingRecorder({
  command,
  keybinding,
  conflict,
  onChange
}: {
  command: AppCommand
  keybinding: string
  conflict: boolean
  onChange(keybinding: string): void
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)

  return (
    <div className="keybinding-recorder">
      {conflict ? <span className="keybinding-conflict" role="status">Conflict</span> : null}
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
function RangeControl({ name, label, min, max, value, onChange }: {
  name: string
  label: string
  min: number
  max: number
  value: number
  onChange(value: number): void
}): React.JSX.Element {
  return (
    <input
      className="range-control"
      name={name}
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(checked: boolean): void }): React.JSX.Element {
  return (
    <input
      className="settings-toggle"
      name={label.toLowerCase().replaceAll(' ', '-')}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}
