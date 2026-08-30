import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The opsz axis is what `font-optical-sizing: auto` in styles.css drives; the
// weight-only subset left that declaration inert. Latin subset delta: +24.1 KB.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/fira-code/wght.css'

import { App } from './App'
import { AppErrorBoundary } from './AppErrorBoundary'
import { getEditorThemeType, loadPreferences } from './preferences'
import { automaticWorkspaceView } from './workspaceMode'
import { preloadWorkspaceRoot, preloadWorkspaceViewer } from './workspaceBoot'
import { markRendererStartup } from './startupMetrics'
import './styles.css'

markRendererStartup('rendererLoaded')

const preferences = loadPreferences()
const sessionSnapshot = window.repository?.getSessionSnapshot() ?? Promise.resolve(null)

// The main process restores Git while Chromium boots. Start the matching UI
// chunks in parallel, but do not await them: Welcome must remain the first frame
// when there is no repository to restore.
if (preferences.restoreLastFolder) {
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
// paint, and whether to reopen the last folder while the renderer boots. Sending
// them at boot means the next launch starts in the right theme.
void window.repository?.setStartupPreferences({
  themeType: getEditorThemeType(preferences.editorTheme),
  restoreLastFolder: preferences.restoreLastFolder
}).catch((error) => console.warn('Could not send startup preferences to the main process:', error))
