import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { DiffToolbar, type FileEditControls } from './AppView'

afterEach(cleanup)

function editControls(overrides: Partial<FileEditControls> = {}): FileEditControls {
  return {
    available: false,
    unavailableReason: 'Editing is unavailable for this file.',
    startLabel: 'Edit',
    mode: 'read',
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    unsavedPaths: [],
    onStart: () => {},
    onModeChange: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onCancel: () => {},
    onRevert: () => {},
    onSave: () => {},
    onOpenPath: () => {},
    ...overrides
  }
}

test('DiffToolbar explains why editing is unavailable', () => {
  render(<DiffToolbar comparison={null} selectedPath="image.png" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ unavailableReason: 'Binary files cannot be edited.' })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  const button = screen.getByRole('button', { name: 'Edit' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(button.getAttribute('title')).toBe('Binary files cannot be edited.')
})

describe('DiffToolbar editing controls', () => {
  test('keeps Save disabled until the draft is dirty', () => {
    render(<DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview={false}
      diffStyle="split" workspaceView="file" reviewFileCount={1} wordWrap={false} foldUnchanged
      fileEdit={editControls({ available: true, mode: 'edit' })}
      onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
