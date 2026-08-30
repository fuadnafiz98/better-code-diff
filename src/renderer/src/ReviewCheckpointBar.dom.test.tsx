import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ReviewCheckpointBar } from './ReviewCheckpointBar'

afterEach(cleanup)

test('requires an explicit checkpoint before Since is available', () => {
  const setCheckpoint = mock(() => {})
  const openSince = mock(() => {})
  render(<ReviewCheckpointBar checkpoint={null} changedFileCount={0} removedFileCount={0}
    reviewReady={true} onSetCheckpoint={setCheckpoint} onOpenSince={openSince} />)

  expect((screen.getByRole('button', { name: 'Since unavailable' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Set checkpoint' }))
  expect(setCheckpoint).toHaveBeenCalledTimes(1)
  expect(openSince).not.toHaveBeenCalled()
})

test('shows checkpoint changes and opens Since', () => {
  const openSince = mock(() => {})
  render(<ReviewCheckpointBar checkpoint={{
    version: 1,
    pullRequestUrl: 'https://github.com/acme/repo/pull/7',
    baseOid: '1'.repeat(40),
    headOid: '2'.repeat(40),
    createdAt: '2026-08-28T10:00:00Z',
    manifest: []
  }} changedFileCount={3} removedFileCount={1} reviewReady={true}
  onSetCheckpoint={() => {}} onOpenSince={openSince} />)

  fireEvent.click(screen.getByRole('button', { name: '3 since checkpoint · 1 removed' }))
  expect(openSince).toHaveBeenCalledTimes(1)
})
