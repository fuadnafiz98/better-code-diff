import { IconGear, IconReload, IconX } from '@pierre/icons'

import {
  CODE_FONTS,
  DEFAULT_PREFERENCES,
  EDITOR_THEMES,
  INTERFACE_FONTS,
  type AppPreferences,
  type CodeFont,
  type EditorTheme,
  type InterfaceFont
} from './preferences'

interface SettingsPageProps {
  preferences: AppPreferences
  onChange(preferences: AppPreferences): void
  onClose(): void
}

export function SettingsPage({ preferences, onChange, onClose }: SettingsPageProps): React.JSX.Element {
  const update = <Key extends keyof AppPreferences>(key: Key, value: AppPreferences[Key]): void => {
    onChange({ ...preferences, [key]: value })
  }

  const codeStyle = {
    fontFamily: CODE_FONTS[preferences.codeFont].fontFamily,
    fontSize: `${preferences.codeFontSize}px`,
    lineHeight: `${preferences.codeLineHeight}px`
  }

  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-content">
        <header className="settings-header">
          <div className="settings-heading">
            <span><IconGear />Settings</span>
            <h1>Editor appearance</h1>
            <p>Changes apply immediately and persist on this Mac.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings" title="Close Settings"><IconX /></button>
        </header>

        <div className="settings-scroll">
          <div className="settings-group">
            <h2>Interface</h2>
            <SettingRow label="Code color theme" description="Controls syntax colors and diff surfaces.">
              <select name="editor-theme" aria-label="Code color theme" value={preferences.editorTheme} onChange={(event) => update('editorTheme', event.target.value as EditorTheme)}>
                {Object.entries(EDITOR_THEMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </SettingRow>
            <SettingRow label="Interface font" description="Used by the title bar, explorer, settings, and controls.">
              <select name="interface-font" aria-label="Interface font" value={preferences.interfaceFont} onChange={(event) => update('interfaceFont', event.target.value as InterfaceFont)}>
                {Object.entries(INTERFACE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
              </select>
            </SettingRow>
          </div>

          <div className="settings-group">
            <h2>Editor</h2>
            <SettingRow label="Code font" description="Fira Code is bundled with the app and does not depend on a system installation.">
              <select name="code-font" aria-label="Code font" value={preferences.codeFont} onChange={(event) => update('codeFont', event.target.value as CodeFont)}>
                {Object.entries(CODE_FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
              </select>
            </SettingRow>
            <SettingRow label="Font size" description={`${preferences.codeFontSize} pixels`}>
              <input name="code-font-size" aria-label="Code font size" type="range" min="10" max="20" step="1" value={preferences.codeFontSize} onChange={(event) => update('codeFontSize', Number(event.target.value))} />
              <output>{preferences.codeFontSize}</output>
            </SettingRow>
            <SettingRow label="Line height" description={`${preferences.codeLineHeight} pixels`}>
              <input name="code-line-height" aria-label="Code line height" type="range" min="16" max="32" step="1" value={preferences.codeLineHeight} onChange={(event) => update('codeLineHeight', Number(event.target.value))} />
              <output>{preferences.codeLineHeight}</output>
            </SettingRow>
            <SettingRow label="Line numbers" description="Show line numbers in previews and comparisons.">
              <Toggle checked={preferences.showLineNumbers} label="Show line numbers" onChange={(checked) => update('showLineNumbers', checked)} />
            </SettingRow>
            <SettingRow label="Word wrap" description="Wrap long lines instead of using horizontal scrolling.">
              <Toggle checked={preferences.wordWrap} label="Wrap long lines" onChange={(checked) => update('wordWrap', checked)} />
            </SettingRow>
          </div>

          <div className="settings-preview">
            <span>Font preview</span>
            <pre style={codeStyle}><code><i>const</i> message = <b>'{CODE_FONTS[preferences.codeFont].label} → diff-first'</b>{'\n'}console.log(message)</code></pre>
          </div>

          <button className="settings-reset" type="button" onClick={() => onChange(DEFAULT_PREFERENCES)}><IconReload />Reset Defaults</button>
        </div>
      </div>
    </section>
  )
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="setting-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="setting-control">{children}</span>
    </label>
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
