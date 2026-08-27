import type { DiffFileContents } from '../../../shared/contracts'

export interface DraftText {
  /** cacheKey of the file the draft was typed against. */
  baseCacheKey: string
  contents: string
}

/**
 * What the surface should render for an edit session's file.
 *
 * The library keeps the rendered DOM and the diff in sync from the editor's own
 * text document while a session is attached, and rebuilds that document (losing
 * undo history) whenever the file's `cacheKey` moves. So the file object is
 * pinned for the session, and a draft is only substituted at a boundary — and
 * only when it was typed against this exact file, or an external write would be
 * silently overwritten by stale text.
 */
export function resolveDraftFile(
  file: DiffFileContents,
  draft: DraftText | undefined
): DiffFileContents {
  if (draft == null || draft.baseCacheKey !== file.cacheKey) return file
  if (draft.contents === file.contents) return file
  return { ...file, contents: draft.contents }
}

export type DiskState = 'unchanged' | 'adopt' | 'conflict'

/**
 * How a session should react to the revision currently on disk. A clean session
 * takes the new revision; a dirty one has to ask, because either answer loses
 * somebody's work.
 */
export function resolveDiskState(
  session: { sourceCacheKey: string; dirty: boolean } | null,
  diskFile: DiffFileContents | null
): DiskState {
  if (session == null || diskFile == null) return 'unchanged'
  if (diskFile.cacheKey === session.sourceCacheKey) return 'unchanged'
  return session.dirty ? 'conflict' : 'adopt'
}
