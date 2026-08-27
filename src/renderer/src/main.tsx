import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The opsz axis is what `font-optical-sizing: auto` in styles.css drives; the
// weight-only subset left that declaration inert. Latin subset delta: +24.1 KB.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/fira-code/wght.css'

import { App } from './App'
import { AppErrorBoundary } from './AppErrorBoundary'
import { getEditorThemeType, loadPreferences } from './preferences'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
)

// Preferences live in renderer storage, but main needs two of them before a
// window exists: the background colour it paints during resize and before first
// paint, and whether to reopen the last folder while the renderer boots. Sending
// them at boot means the next launch starts in the right theme.
const preferences = loadPreferences()
void window.repository?.setStartupPreferences({
  themeType: getEditorThemeType(preferences.editorTheme),
  restoreLastFolder: preferences.restoreLastFolder
}).catch((error) => console.warn('Could not send startup preferences to the main process:', error))

// The workspace and its two viewers are lazy so the Welcome screen paints
// without them, which means opening a folder otherwise waits on an 800 KB chunk
// fetch and parse before the first git call even starts. Idle time on the
// Welcome screen is free; never do this synchronously.
requestIdleCallback(() => {
  void import('./RepositoryWorkspace')
  void import('./DiffSurface')
  void import('./MultiFileReview')
})
