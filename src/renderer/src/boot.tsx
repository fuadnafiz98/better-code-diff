import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { RepositorySnapshot } from '../../shared/contracts'
import { initialWorkspacePaint } from '../../shared/workspaceCache'
import { App } from './App'
import { AppErrorBoundary } from './AppErrorBoundary'
import { getEditorThemeType, loadPreferences } from './preferences'
import { automaticWorkspaceView } from './workspaceMode'
import { preloadWorkspaceRoot, preloadWorkspaceViewer } from './workspaceBoot'
import './styles.css'

export async function mountApp(sessionSnapshot: Promise<RepositorySnapshot | null>): Promise<void> {
  void import('@fontsource-variable/inter/opsz.css')
  void import('@fontsource-variable/fira-code/wght.css')

  const preferences = loadPreferences()
  const cachedPaint = initialWorkspacePaint(window.repository?.cachedWorkspace ?? null)

  if (cachedPaint.snapshot != null) {
    await Promise.all([
      preloadWorkspaceRoot().catch(() => undefined),
      preloadWorkspaceViewer(cachedPaint.workspaceView).catch(() => undefined)
    ])
  } else if (preferences.restoreLastFolder) {
    void preloadWorkspaceRoot().catch(() => undefined)
    void sessionSnapshot.then((snapshot) => snapshot == null
      ? undefined
      : preloadWorkspaceViewer(automaticWorkspaceView(snapshot, null))).catch(() => undefined)
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <App initialPreferences={preferences} sessionSnapshot={sessionSnapshot} />
      </AppErrorBoundary>
    </StrictMode>
  )

  // Preferences live in renderer storage, but main needs two of them before a
  // window exists: the background colour it paints during resize and before first
  // paint, and whether to reopen the last folder while the renderer boots.
  void window.repository?.setStartupPreferences({
    themeType: getEditorThemeType(preferences.editorTheme),
    restoreLastFolder: preferences.restoreLastFolder
  }).catch((error) => console.warn('Could not send startup preferences to the main process:', error))
}
