import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileContents } from '@pierre/diffs'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'

import type { DiffFileContents, FileComparison, RepositoryReview } from '../../shared/contracts'
import type { FileEditControls, WorkspaceView } from './AppView'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import { showToast } from './toast'

export function createDiffEditor<LAnnotation>(options: EditorOptions<LAnnotation>): Editor<LAnnotation> {
  return new Editor(options)
}

interface FileEditSession {
  path: string
  mode: 'edit' | 'preview'
  sourceCacheKey: string
  sourceContents: string
  draftFile: DiffFileContents
  draftRevision: number
  dirty: boolean
}

interface UseFileEditingOptions {
  comparison: FileComparison | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  repositoryReview: RepositoryReview | null
  onWorkspaceViewChange(view: WorkspaceView): void
  onSelectPath(path: string): void
  onComparisonChange(comparison: FileComparison): void
  onError(message: string | null): void
}

interface FileEditingController {
  activeSession: FileEditSession | null
  renderedComparison: FileComparison | null
  controls: FileEditControls
  attachEditor(editor: Editor<ReviewAnnotationMetadata>): void
  updateDraftFile(file: FileContents): void
}

function createSession(comparison: FileComparison): FileEditSession | null {
  const file = comparison.newFile
  if (file == null || comparison.binary || comparison.oversized) return null
  return {
    path: comparison.path,
    mode: 'edit',
    sourceCacheKey: file.cacheKey,
    sourceContents: file.contents,
    draftFile: file,
    draftRevision: 0,
    dirty: false
  }
}

export function useFileEditing({
  comparison,
  selectedPath,
  workspaceView,
  repositoryReview,
  onWorkspaceViewChange,
  onSelectPath,
  onComparisonChange,
  onError
}: UseFileEditingOptions): FileEditingController {
  const [session, setSession] = useState<FileEditSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const editorRef = useRef<Editor<ReviewAnnotationMetadata> | null>(null)
  const savingRef = useRef(false)
  const editRequestRef = useRef(0)
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => {
    selectedPathRef.current = selectedPath
  }, [selectedPath])
  const activeSession = session?.path === comparison?.path ? session : null
  const renderedComparison = activeSession == null || comparison == null
    ? comparison
    : { ...comparison, newFile: activeSession.draftFile }
  const canEditLoadedFile = comparison?.newFile != null
    && !comparison.binary
    && !comparison.oversized
  const canRequestEdit = repositoryReview == null
    && selectedPath != null
    && (workspaceView === 'multi' || canEditLoadedFile)

  const syncHistory = useCallback(() => {
    const editor = editorRef.current
    setHistory({ canUndo: editor?.canUndo ?? false, canRedo: editor?.canRedo ?? false })
  }, [])
  const attachEditor = useCallback((editor: Editor<ReviewAnnotationMetadata>) => {
    editorRef.current = editor
    syncHistory()
    window.requestAnimationFrame(() => editor.focus({ lineNumber: 'first-visible' }))
  }, [syncHistory])
  const updateDraftFile = useCallback((file: FileContents) => {
    setSession((current) => {
      if (current == null || current.path !== file.name) return current
      const draftRevision = current.draftRevision + 1
      return {
        ...current,
        draftRevision,
        dirty: file.contents !== current.sourceContents,
        draftFile: {
          name: file.name,
          contents: file.contents,
          cacheKey: `${current.sourceCacheKey}:draft:${draftRevision}`
        }
      }
    })
    queueMicrotask(syncHistory)
  }, [syncHistory])
  const startEditing = useCallback(async () => {
    if (session != null && activeSession == null) {
      onSelectPath(session.path)
      onWorkspaceViewChange('file')
      return
    }
    if (repositoryReview != null || selectedPath == null) return
    if (workspaceView === 'multi') {
      const requestId = editRequestRef.current + 1
      editRequestRef.current = requestId
      onError(null)
      try {
        const loadedComparison = await requireRepositoryApi().getComparison(selectedPath)
        if (requestId !== editRequestRef.current || selectedPathRef.current !== selectedPath) return
        const nextSession = createSession(loadedComparison)
        if (nextSession == null) throw new Error('This working file is not editable.')
        onComparisonChange(loadedComparison)
        setSession(nextSession)
        onWorkspaceViewChange('file')
      } catch (error) {
        onError(getErrorMessage(error))
      }
      return
    }
    if (comparison == null) return
    const nextSession = createSession(comparison)
    if (nextSession != null) setSession(nextSession)
  }, [activeSession, comparison, onComparisonChange, onError, onSelectPath, onWorkspaceViewChange,
    repositoryReview, selectedPath, session, workspaceView])
  const setMode = useCallback((mode: 'edit' | 'preview') => {
    setSession((current) => current == null ? null : { ...current, mode })
  }, [])
  const cancel = useCallback(() => {
    editorRef.current = null
    setHistory({ canUndo: false, canRedo: false })
    setSession(null)
  }, [])
  const undo = useCallback(() => {
    editorRef.current?.undo()
    queueMicrotask(syncHistory)
  }, [syncHistory])
  const redo = useCallback(() => {
    editorRef.current?.redo()
    queueMicrotask(syncHistory)
  }, [syncHistory])
  const save = useCallback(async () => {
    if (activeSession == null || !activeSession.dirty || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    onError(null)
    try {
      const savedComparison = await requireRepositoryApi().saveWorkingFile({
        path: activeSession.path,
        contents: activeSession.draftFile.contents,
        expectedCacheKey: activeSession.sourceCacheKey
      })
      editorRef.current = null
      setHistory({ canUndo: false, canRedo: false })
      setSession(null)
      onComparisonChange(savedComparison)
      showToast(`Saved ${activeSession.path}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [activeSession, onComparisonChange, onError])

  useEffect(() => {
    if (activeSession == null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeSession, save])
  useEffect(() => {
    if (!session?.dirty) return
    const confirmClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', confirmClose)
    return () => window.removeEventListener('beforeunload', confirmClose)
  }, [session?.dirty])

  const controls = useMemo<FileEditControls>(() => ({
    available: canRequestEdit || session != null,
    startLabel: session != null && activeSession == null ? 'Resume draft' : 'Edit',
    mode: activeSession?.mode ?? 'read',
    dirty: activeSession?.dirty ?? false,
    saving,
    canUndo: activeSession?.mode === 'edit' && history.canUndo,
    canRedo: activeSession?.mode === 'edit' && history.canRedo,
    onStart: () => { void startEditing() },
    onModeChange: setMode,
    onUndo: undo,
    onRedo: redo,
    onCancel: cancel,
    onSave: () => { void save() }
  }), [activeSession, canRequestEdit, cancel, history, redo, save, saving, session,
    setMode, startEditing, undo])

  return { activeSession, renderedComparison, controls, attachEditor, updateDraftFile }
}
