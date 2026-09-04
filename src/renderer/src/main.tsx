import { applyRestoreHintToDocument } from '../../shared/sessionRestore'
import { markRendererStartup } from './startupMetrics'

markRendererStartup('rendererLoaded')
applyRestoreHintToDocument(document.documentElement, window.repository?.restoreHint)

// Kick the restore IPC before the App chunk arrives so it overlaps the download.
const sessionSnapshot = window.repository?.getSessionSnapshot() ?? Promise.resolve(null)
void import('./boot').then(({ mountApp }) => mountApp(sessionSnapshot))
