export type AppCommand =
  | 'openFolder'
  | 'openCommandPalette'
  | 'goToFile'
  | 'searchContent'
  | 'toggleSidebar'
  | 'toggleWordWrap'
  | 'toggleFoldUnchanged'
  | 'toggleTerminal'
  | 'openSettings'

export type KeybindingMap = Record<AppCommand, string>

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  openFolder: 'Meta+KeyO',
  openCommandPalette: 'Meta+KeyK',
  goToFile: 'Meta+KeyP',
  searchContent: 'Meta+Shift+KeyF',
  toggleSidebar: 'Meta+KeyB',
  toggleWordWrap: 'Alt+KeyZ',
  // Not ⌘⌥F: that is the editor's own find-and-replace panel, and while the
  // caret is in the editor the editor wins, so the fold toggle would only work
  // some of the time.
  toggleFoldUnchanged: 'Meta+Alt+KeyU',
  toggleTerminal: 'Meta+KeyJ',
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
  { command: 'toggleTerminal', label: 'Toggle terminal', description: 'Show or hide the project terminal.' },
  { command: 'goToFile', label: 'Search repository', description: 'Search file names and repository content together.' },
  { command: 'searchContent', label: 'Search repository (alternate)', description: 'Open the same unified search with the code-search shortcut.' },
  { command: 'openFolder', label: 'Open folder', description: 'Open the macOS folder picker.' },
  { command: 'openSettings', label: 'Open settings', description: 'Open application settings.' }
]

const MODIFIER_CODES = new Set(['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight'])

export type ReviewCommand = 'nextReviewFile' | 'previousReviewFile' | 'toggleReviewViewed' | 'toggleReviewCollapsed'

export const REVIEW_KEYBINDINGS: ReadonlyArray<{ code: string; command: ReviewCommand; key: string; label: string }> = [
  { code: 'BracketRight', command: 'nextReviewFile', key: ']', label: 'Next file in review' },
  { code: 'BracketLeft', command: 'previousReviewFile', key: '[', label: 'Previous file in review' },
  { code: 'KeyV', command: 'toggleReviewViewed', key: 'V', label: 'Toggle viewed on the current file' },
  { code: 'KeyC', command: 'toggleReviewCollapsed', key: 'C', label: 'Collapse or expand the current file' }
]

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function isTypingElement(element: Element | null): boolean {
  if (element == null) return false
  if (TYPING_TAGS.has(element.tagName)) return true
  return (element as HTMLElement).isContentEditable === true
}

// Review comment fields live inside the diff shadow roots, so the focused element
// has to be resolved through every nested root before the guard can trust it.
export function deepActiveElement(root: DocumentOrShadowRoot): Element | null {
  let active = root.activeElement
  while (active?.shadowRoot?.activeElement != null) {
    active = active.shadowRoot.activeElement
  }
  return active
}

export function reviewCommandFromEvent(event: KeyboardEvent, activeElement: Element | null): ReviewCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (isTypingElement(activeElement)) return null
  return REVIEW_KEYBINDINGS.find((binding) => binding.code === event.code)?.command ?? null
}

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

/**
 * The terminal follows the platform convention while also accepting Ctrl+J.
 * This remains available when a saved custom binding exists from an older build.
 */
export function isTerminalToggleShortcut(event: KeyboardEvent, keybindings: KeybindingMap): boolean {
  const binding = keybindingFromEvent(event)
  return binding === 'Meta+KeyJ' || binding === 'Control+KeyJ' || binding === keybindings.toggleTerminal
}

export function formatTerminalToggleShortcut(): string {
  return '⌃J / ⌘J'
}

export function formatKeybinding(keybinding: string): string {
  const parts = keybinding.split('+')
  const code = parts.at(-1) ?? ''
  const key = code.startsWith('Key') ? code.slice(3)
    : code.startsWith('Digit') ? code.slice(5)
      : code === 'Comma' ? ','
        : code === 'Period' ? '.'
          : code === 'Slash' ? '/'
            : code === 'Backquote' ? '`'
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
