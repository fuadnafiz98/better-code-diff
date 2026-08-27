import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@pierre/diffs/edit'

import type { ReviewAnnotationMetadata } from '../ReviewComments'
import { EMPTY_CARET, readCaret, type CaretReadout } from './caret'
import { EDITOR_SHORTCUTS, formatEditorShortcut } from './editorKeymap'

interface EditorStatusBarProps {
  mode: 'read' | 'edit' | 'preview'
  dirty: boolean
  fileExtension?: string
  getEditor(): Editor<ReviewAnnotationMetadata> | null
}

export function EditorStatusBar({
  mode,
  dirty,
  fileExtension,
  getEditor
}: EditorStatusBarProps): React.JSX.Element {
  const [caret, setCaret] = useState<CaretReadout>(EMPTY_CARET)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const frameRef = useRef<number | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  const sampleCaret = useCallback(() => {
    frameRef.current = null
    setCaret((current) => {
      const next = readCaret(getEditor())
      return next.line === current.line
        && next.column === current.column
        && next.selectedLines === current.selectedLines
        && next.selectedCharacters === current.selectedCharacters
        ? current
        : next
    })
  }, [getEditor])

  // selectionchange fires far more often than the readout can change, so every
  // burst collapses into one frame.
  useEffect(() => {
    if (mode !== 'edit') {
      setCaret(EMPTY_CARET)
      return
    }
    const schedule = (): void => {
      if (frameRef.current != null) return
      frameRef.current = window.requestAnimationFrame(sampleCaret)
    }
    document.addEventListener('selectionchange', schedule)
    schedule()
    return () => {
      document.removeEventListener('selectionchange', schedule)
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [mode, sampleCaret])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    if (shortcutsOpen && !dialog.open) dialog.showModal()
    if (!shortcutsOpen && dialog.open) dialog.close()
  }, [shortcutsOpen])

  const editing = mode === 'edit'

  return (
    <footer className="editor-statusbar">
      <span>{mode === 'edit' ? 'Editing' : mode === 'preview' ? 'Draft preview' : 'Read only'}</span>
      {editing ? <span>{dirty ? 'Unsaved' : 'Saved'}</span> : null}
      {editing ? <span>Ln {caret.line}, Col {caret.column}</span> : null}
      {editing && caret.selectedLines > 0 ? (
        <span>{caret.selectedLines} lines selected</span>
      ) : editing && caret.selectedCharacters > 0 ? (
        <span>{caret.selectedCharacters} selected</span>
      ) : null}
      <span>UTF-8</span>
      <span>LF</span>
      {fileExtension != null ? <span>{fileExtension}</span> : null}
      {editing ? (
        <>
          <span>{formatEditorShortcut('cmdOrCtrl+f')} find</span>
          <span>⌘S save</span>
          <button type="button" onClick={() => setShortcutsOpen(true)}>Shortcuts…</button>
        </>
      ) : null}
      <dialog ref={dialogRef} className="editor-shortcuts-sheet" onClose={() => setShortcutsOpen(false)}
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
    </footer>
  )
}
