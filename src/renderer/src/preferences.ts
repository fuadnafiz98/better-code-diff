import { DEFAULT_KEYBINDINGS, type KeybindingMap } from './keybindings'

export type CodeFont = 'fira-code' | 'sf-mono' | 'menlo' | 'monaco'
export type InterfaceFont = 'inter' | 'system'
export type EditorTheme =
  | 'pierre-dark'
  | 'pierre-dark-soft'
  | 'github-dark'
  | 'vitesse-dark'
  | 'pierre-light'
  | 'github-light'
  | 'vitesse-light'
  | 'light-plus'
export type EditorThemeType = 'dark' | 'light'

export interface AppPreferences {
  codeFont: CodeFont
  codeFontSize: number
  codeLineHeight: number
  editorTheme: EditorTheme
  interfaceFont: InterfaceFont
  showLineNumbers: boolean
  wordWrap: boolean
  foldUnchanged: boolean
  autosaveOnBlur: boolean
  terminalScrollback: number
  restoreLastFolder: boolean
  keybindings: KeybindingMap
  // Bumped when a default shortcut is retired, so the migration that drops the
  // old default from storage runs once instead of on every load.
  keybindingsVersion: number
}

export const KEYBINDINGS_VERSION = 2

export const CODE_FONTS: Record<CodeFont, { label: string; fontFamily: string }> = {
  'fira-code': {
    label: 'Fira Code',
    fontFamily: '"Fira Code Variable", "Fira Code", monospace'
  },
  'sf-mono': {
    label: 'SF Mono',
    fontFamily: '"SF Mono", ui-monospace, monospace'
  },
  menlo: {
    label: 'Menlo',
    fontFamily: 'Menlo, ui-monospace, monospace'
  },
  monaco: {
    label: 'Monaco',
    fontFamily: 'Monaco, ui-monospace, monospace'
  }
}

export const INTERFACE_FONTS: Record<InterfaceFont, { label: string; fontFamily: string }> = {
  inter: {
    label: 'Inter',
    fontFamily: '"Inter Variable", Inter, ui-sans-serif, -apple-system, sans-serif'
  },
  system: {
    label: 'System',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  }
}

export const EDITOR_THEMES: Record<EditorTheme, string> = {
  'pierre-dark': 'Pierre Dark',
  'pierre-dark-soft': 'Pierre Dark Soft',
  'github-dark': 'GitHub Dark',
  'vitesse-dark': 'Vitesse Dark',
  'pierre-light': 'Pierre Light',
  'github-light': 'GitHub Light',
  'vitesse-light': 'Vitesse Light',
  'light-plus': 'Light Plus'
}

export const EDITOR_THEME_GROUPS: ReadonlyArray<{
  label: string
  themes: readonly EditorTheme[]
}> = [
  { label: 'Light', themes: ['pierre-light', 'github-light', 'vitesse-light', 'light-plus'] },
  { label: 'Dark', themes: ['pierre-dark', 'pierre-dark-soft', 'github-dark', 'vitesse-dark'] }
]

export function getEditorThemeType(theme: EditorTheme): EditorThemeType {
  return theme.endsWith('-light') || theme === 'light-plus' ? 'light' : 'dark'
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  codeFont: 'fira-code',
  codeFontSize: 13,
  codeLineHeight: 20,
  editorTheme: 'pierre-dark',
  interfaceFont: 'inter',
  showLineNumbers: true,
  wordWrap: false,
  foldUnchanged: true,
  autosaveOnBlur: false,
  terminalScrollback: 5_000,
  restoreLastFolder: true,
  keybindings: DEFAULT_KEYBINDINGS,
  keybindingsVersion: KEYBINDINGS_VERSION
}

const STORAGE_KEY = 'better-code-diff:preferences:v1'

export function loadPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored == null) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(stored) as Partial<AppPreferences>
    return {
      codeFont: parsed.codeFont != null && Object.hasOwn(CODE_FONTS, parsed.codeFont)
        ? parsed.codeFont
        : DEFAULT_PREFERENCES.codeFont,
      codeFontSize: clampNumber(parsed.codeFontSize, 10, 20, DEFAULT_PREFERENCES.codeFontSize),
      codeLineHeight: clampNumber(parsed.codeLineHeight, 16, 32, DEFAULT_PREFERENCES.codeLineHeight),
      editorTheme: parsed.editorTheme != null && Object.hasOwn(EDITOR_THEMES, parsed.editorTheme)
        ? parsed.editorTheme
        : DEFAULT_PREFERENCES.editorTheme,
      interfaceFont: parsed.interfaceFont != null && Object.hasOwn(INTERFACE_FONTS, parsed.interfaceFont)
        ? parsed.interfaceFont
        : DEFAULT_PREFERENCES.interfaceFont,
      showLineNumbers: typeof parsed.showLineNumbers === 'boolean'
        ? parsed.showLineNumbers
        : DEFAULT_PREFERENCES.showLineNumbers,
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_PREFERENCES.wordWrap,
      foldUnchanged: typeof parsed.foldUnchanged === 'boolean' ? parsed.foldUnchanged : DEFAULT_PREFERENCES.foldUnchanged,
      autosaveOnBlur: typeof parsed.autosaveOnBlur === 'boolean'
        ? parsed.autosaveOnBlur
        : DEFAULT_PREFERENCES.autosaveOnBlur,
      terminalScrollback: clampNumber(
        parsed.terminalScrollback,
        1_000,
        50_000,
        DEFAULT_PREFERENCES.terminalScrollback
      ),
      restoreLastFolder: typeof parsed.restoreLastFolder === 'boolean'
        ? parsed.restoreLastFolder
        : DEFAULT_PREFERENCES.restoreLastFolder,
      keybindings: loadKeybindings(parsed.keybindings, parsed.keybindingsVersion),
      keybindingsVersion: KEYBINDINGS_VERSION
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

// ⌘⌥F now belongs to the editor's find-in-selection, so the fold shortcut moved
// to ⌘⌥U. Anyone who never rebound it kept the old default in localStorage.
const RETIRED_DEFAULT_KEYBINDINGS: Partial<Record<keyof KeybindingMap, string>> = {
  toggleFoldUnchanged: 'Meta+Alt+KeyF'
}

export function loadKeybindings(
  value: Partial<KeybindingMap> | undefined,
  savedVersion: number | undefined
): KeybindingMap {
  if (value == null || typeof value !== 'object') return DEFAULT_KEYBINDINGS
  // The retired defaults are dropped exactly once. Without the version check,
  // deliberately binding fold back onto ⌘⌥F would be undone on every launch.
  const migrating = savedVersion !== KEYBINDINGS_VERSION
  const keybindings = { ...DEFAULT_KEYBINDINGS }
  for (const command of Object.keys(DEFAULT_KEYBINDINGS) as Array<keyof KeybindingMap>) {
    const saved = value[command]
    if (typeof saved !== 'string') continue
    if (migrating && saved === RETIRED_DEFAULT_KEYBINDINGS[command]) continue
    keybindings[command] = saved
  }
  return keybindings
}

export function savePreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Preferences remain active for the current session when storage is unavailable.
  }
}

function clampNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
}
