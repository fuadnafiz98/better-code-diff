import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DEFAULT_KEYBINDINGS } from './keybindings'
import type { RecentFolder } from './recentFolders'
import { Welcome } from './Welcome'

afterEach(cleanup)

const recentFolders: readonly RecentFolder[] = [
  { name: 'horus', path: '/Users/reader/horus', lastOpenedAt: 2 },
  { name: 'core-3', path: '/Users/reader/core-3', lastOpenedAt: 1 }
]

function renderWelcome(overrides: Partial<React.ComponentProps<typeof Welcome>> = {}): void {
  render(<Welcome
    opening={false}
    openingRecentPath={null}
    recentFolders={recentFolders}
    keybindings={DEFAULT_KEYBINDINGS}
    onOpen={async () => {}}
    onOpenPickedFolder={() => {}}
    onRecentOpen={async () => {}}
    onRecentRemove={() => {}}
    {...overrides}
  />)
}

test('lists recent folders and opens the one that is clicked', () => {
  const onRecentOpen = mock(async () => {})
  renderWelcome({ onRecentOpen })

  expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  fireEvent.click(screen.getByTitle('/Users/reader/core-3'))

  expect(onRecentOpen).toHaveBeenCalledWith(recentFolders[1])
})

test('removes a recent folder without opening it', () => {
  const onRecentOpen = mock(async () => {})
  const onRecentRemove = mock(() => {})
  renderWelcome({ onRecentOpen, onRecentRemove })

  fireEvent.click(screen.getByLabelText('Remove horus from recent folders'))

  expect(onRecentRemove).toHaveBeenCalledWith('/Users/reader/horus')
  expect(onRecentOpen).not.toHaveBeenCalled()
})

test('shows the empty state when there is no history', () => {
  renderWelcome({ recentFolders: [] })

  expect(screen.getByText('No recent folders')).toBeTruthy()
})
