export interface SessionRestoreHint {
  lastRoot: string | null
  restoreLastFolder: boolean
  themeType: 'dark' | 'light'
  folderPresent: boolean
  restoring: boolean
}

export const RESTORE_HINT_ARG_PREFIX = '--horus-restore='

export const EMPTY_RESTORE_HINT: SessionRestoreHint = {
  lastRoot: null,
  restoreLastFolder: true,
  themeType: 'dark',
  folderPresent: false,
  restoring: false
}

export function shouldRestoreLastFolder(input: {
  startHidden: boolean
  restoreLastFolder: boolean
  lastRoot: string | null
  folderPresent: boolean
}): boolean {
  return !input.startHidden && input.restoreLastFolder && input.lastRoot != null && input.folderPresent
}

export function parseRestoreHint(raw: unknown): SessionRestoreHint {
  if (typeof raw !== 'object' || raw == null) return EMPTY_RESTORE_HINT
  const { lastRoot, restoreLastFolder, themeType, folderPresent, restoring } = raw as Record<string, unknown>
  const parsedLastRoot = typeof lastRoot === 'string' && lastRoot !== '' ? lastRoot : null
  const parsedRestore = typeof restoreLastFolder === 'boolean' ? restoreLastFolder : true
  const parsedPresent = parsedLastRoot != null && folderPresent === true
  return {
    lastRoot: parsedLastRoot,
    restoreLastFolder: parsedRestore,
    themeType: themeType === 'light' ? 'light' : 'dark',
    folderPresent: parsedPresent,
    restoring: restoring === true && parsedPresent && parsedRestore
  }
}

export function sessionRestoreExpected(hint: SessionRestoreHint | null | undefined): boolean {
  return hint != null && hint.restoring
}

export function restorePendingFromHint(
  hint: SessionRestoreHint | null | undefined,
  restoreLastFolderPreference: boolean
): boolean {
  if (sessionRestoreExpected(hint)) return true
  if (hint == null || hint.lastRoot == null) return restoreLastFolderPreference
  return false
}

export function encodeRestoreHintArgument(hint: SessionRestoreHint): string {
  return `${RESTORE_HINT_ARG_PREFIX}${encodeURIComponent(JSON.stringify(hint))}`
}

export function restoreHintFromArgv(argv: readonly string[]): SessionRestoreHint | null {
  const encoded = argv.find((arg) => arg.startsWith(RESTORE_HINT_ARG_PREFIX))?.slice(RESTORE_HINT_ARG_PREFIX.length)
  if (encoded == null || encoded === '') return null
  try {
    return parseRestoreHint(JSON.parse(decodeURIComponent(encoded)))
  } catch {
    return null
  }
}

export type SessionWorkspaceStage = 'welcome' | 'opening' | 'workspace'

export function sessionWorkspaceStage(input: {
  hasNewWorld: boolean
  snapshot: { root: string } | null
  restorePending: boolean
  pullRequestPending: boolean
}): SessionWorkspaceStage {
  // Cmd+H / horus:// opens a New tab. Restore must not cover that with the
  // opening canvas or the last-folder workspace.
  if (input.hasNewWorld && input.pullRequestPending) return 'welcome'
  // A cached snapshot is the real workspace. Paint it even if worlds still
  // hold a leftover new tab.
  if (input.snapshot != null && !input.pullRequestPending) return 'workspace'
  if (input.restorePending && input.snapshot == null) return 'opening'
  if (input.hasNewWorld) return 'welcome'
  if (input.snapshot != null) return 'opening'
  return 'welcome'
}

export type StartupSnapshotAction = 'apply' | 'welcome' | 'ignore'

export function startupSnapshotAction(input: {
  cancelled: boolean
  snapshot: { root: string } | null
  paintedSnapshot?: { root: string } | null
}): StartupSnapshotAction {
  if (input.cancelled) return 'ignore'
  if (input.snapshot != null) return 'apply'
  // A cached first paint already reopened the folder. A null live snapshot
  // must not look like a missing folder — that is how we toasted after
  // materialsx-core-3 was already on screen.
  if (input.paintedSnapshot != null) return 'ignore'
  return 'welcome'
}

export function shouldReportRestoreFailure(input: {
  action: StartupSnapshotAction
  restoreExpected: boolean
}): boolean {
  return input.action === 'welcome' && input.restoreExpected
}

export function effectiveLastRoot(
  sessionLastRoot: string | null | undefined,
  cacheLastRoot?: string | null
): string | null {
  if (sessionLastRoot != null && sessionLastRoot !== '') return sessionLastRoot
  if (cacheLastRoot != null && cacheLastRoot !== '') return cacheLastRoot
  return null
}

export function isPrematureSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Open a repository before using this action')
}

export function applyRestoreHintToDocument(
  documentElement: { dataset: Record<string, string | undefined> } | null | undefined,
  hint: SessionRestoreHint | null | undefined
): void {
  if (documentElement == null) return
  const resolved = hint ?? EMPTY_RESTORE_HINT
  documentElement.dataset.horusTheme = resolved.themeType
  documentElement.dataset.horusRestore = sessionRestoreExpected(resolved) ? 'folder' : 'welcome'
}
