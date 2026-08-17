export type AppCommand =
  | 'openFolder'
  | 'openCommandPalette'
  | 'goToFile'
  | 'searchContent'
  | 'toggleSidebar'
  | 'toggleWordWrap'
  | 'toggleFoldUnchanged'
  | 'toggleMultiFile'
  | 'openSettings'

export type KeybindingMap = Record<AppCommand, string>

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  openFolder: 'Meta+KeyO',
  openCommandPalette: 'Meta+KeyK',
  goToFile: 'Meta+KeyP',
  searchContent: 'Meta+Shift+KeyF',
  toggleSidebar: 'Meta+KeyB',
  toggleWordWrap: 'Alt+KeyZ',
  toggleFoldUnchanged: 'Meta+Alt+KeyF',
  toggleMultiFile: 'Meta+Shift+KeyM',
  openSettings: 'Meta+Comma'
}

export const KEYBINDING_COMMANDS: ReadonlyArray<{
  command: AppCommand
  label: string
  description: string
}> = [
  { command: 'openCommandPalette', label: 'Open command palette', description: 'Open a pull request or run an application command.' },
  { command: 'toggleSidebar', label: 'Toggle explorer', description: 'Show or hide the file explorer.' },
  { command: 'toggleWordWrap', label: 'Toggle word wrap', description: 'Wrap or scroll long code lines.' },
  { command: 'toggleFoldUnchanged', label: 'Toggle context folding', description: 'Fold or expand unchanged diff regions.' },
  { command: 'toggleMultiFile', label: 'Toggle review view', description: 'Switch between file and multi-file review.' },
  { command: 'goToFile', label: 'Go to file', description: 'Focus file search.' },
  { command: 'searchContent', label: 'Search contents', description: 'Focus repository content search.' },
  { command: 'openFolder', label: 'Open folder', description: 'Open the macOS folder picker.' },
  { command: 'openSettings', label: 'Open settings', description: 'Open application settings.' }
]

const MODIFIER_CODES = new Set(['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight'])

export function keybindingFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey
  if (!hasModifier && !event.code.startsWith('F')) return null
  return [
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    event.metaKey ? 'Meta' : null,
    event.code
  ].filter(Boolean).join('+')
}

export function commandFromEvent(event: KeyboardEvent, keybindings: KeybindingMap): AppCommand | null {
  const binding = keybindingFromEvent(event)
  if (binding == null) return null
  for (const { command } of KEYBINDING_COMMANDS) {
    if (keybindings[command] === binding) return command
  }
  return null
}

export function formatKeybinding(keybinding: string): string {
  const parts = keybinding.split('+')
  const code = parts.at(-1) ?? ''
  const key = code.startsWith('Key') ? code.slice(3)
    : code.startsWith('Digit') ? code.slice(5)
      : code === 'Comma' ? ','
        : code === 'Period' ? '.'
          : code === 'Slash' ? '/'
            : code === 'Space' ? 'Space'
              : code
  return `${parts.includes('Control') ? '⌃' : ''}${parts.includes('Alt') ? '⌥' : ''}${parts.includes('Shift') ? '⇧' : ''}${parts.includes('Meta') ? '⌘' : ''}${key}`
}

export function findKeybindingConflicts(keybindings: KeybindingMap): Set<AppCommand> {
  const commandsByBinding = new Map<string, AppCommand[]>()
  for (const { command } of KEYBINDING_COMMANDS) {
    const commands = commandsByBinding.get(keybindings[command]) ?? []
    commands.push(command)
    commandsByBinding.set(keybindings[command], commands)
  }
  return new Set(
    [...commandsByBinding.values()]
      .filter((commands) => commands.length > 1)
      .flat()
  )
}
