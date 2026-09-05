import { useEffect, useRef } from 'react'

import { EDITOR_SHORTCUTS, formatEditorShortcut } from './editorKeymap'

export interface EditorShortcutsSheetProps {
  open: boolean
  onClose(): void
}

export function EditorShortcutsSheet({ open, onClose }: EditorShortcutsSheetProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={dialogRef} className="editor-shortcuts-sheet" onClose={onClose}
      aria-label="Editor keyboard shortcuts">
      <strong>Editor shortcuts</strong>
      <dl>
        {EDITOR_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.shortcut}>
            <dt><kbd>{formatEditorShortcut(shortcut.shortcut)}</kbd></dt>
            <dd>{shortcut.label}</dd>
          </div>
        ))}
      </dl>
      <form method="dialog">
        <button type="submit">Close</button>
      </form>
    </dialog>
  )
}
