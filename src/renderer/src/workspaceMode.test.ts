import { describe, expect, it } from 'bun:test'

import type { RepositoryReview } from '../../shared/contracts'
import { automaticWorkspaceView, workspaceViewForTreePath } from './workspaceMode'

describe('automaticWorkspaceView', () => {
  it('uses one continuous review when the working tree has changes', () => {
    expect(automaticWorkspaceView({ kind: 'git', statuses: [{ path: 'src/app.ts', status: 'modified' }] }, null))
      .toBe('multi')
  })

  it('uses file preview for a clean repository or a plain folder', () => {
    expect(automaticWorkspaceView({ kind: 'git', statuses: [] }, null)).toBe('file')
    expect(automaticWorkspaceView({ kind: 'folder', statuses: [] }, null)).toBe('file')
  })

  it('keeps an external review in multi-file mode even when the working tree is clean', () => {
    expect(automaticWorkspaceView(
      { kind: 'git', statuses: [] },
      { kind: 'local' } as RepositoryReview
    )).toBe('multi')
  })
})

describe('workspaceViewForTreePath', () => {
  it('opens files outside the current review as full-file previews', () => {
    expect(workspaceViewForTreePath('multi', false, false)).toBe('file')
  })

  it('returns to the review when a changed file is selected', () => {
    expect(workspaceViewForTreePath('file', true, false)).toBe('multi')
  })

  it('does not interrupt an active edit session', () => {
    expect(workspaceViewForTreePath('file', true, true)).toBe('file')
  })
})
