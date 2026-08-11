export type CodeFont = 'fira-code' | 'sf-mono' | 'menlo' | 'monaco'
export type InterfaceFont = 'inter' | 'system'
export type EditorTheme = 'pierre-dark' | 'pierre-dark-soft' | 'github-dark' | 'vitesse-dark'

export interface AppPreferences {
  codeFont: CodeFont
  codeFontSize: number
  codeLineHeight: number
  editorTheme: EditorTheme
  interfaceFont: InterfaceFont
  showLineNumbers: boolean
  wordWrap: boolean
}

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
  'vitesse-dark': 'Vitesse Dark'
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  codeFont: 'fira-code',
  codeFontSize: 13,
  codeLineHeight: 20,
  editorTheme: 'pierre-dark',
  interfaceFont: 'inter',
  showLineNumbers: true,
  wordWrap: false
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
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_PREFERENCES.wordWrap
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
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
