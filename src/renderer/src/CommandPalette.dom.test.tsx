import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'

import { CommandPaletteController, type CommandPaletteHandle } from './CommandPalette'
import { DEFAULT_KEYBINDINGS } from './keybindings'

afterEach(cleanup)

describe('CommandPaletteController', () => {
  test('runs application commands and closes', () => {
    const onRunCommand = mock(() => {})
    const ref = createRef<CommandPaletteHandle>()
    render(<CommandPaletteController ref={ref} gitRepositoryOpen projectOpen
      keybindings={DEFAULT_KEYBINDINGS} onOpenPullRequest={() => {}} onOpenRepository={() => {}}
      onOpenSettings={() => {}} onToggleTerminal={() => {}} onRunCommand={onRunCommand} />)

    act(() => ref.current?.toggle())
    fireEvent.click(screen.getByRole('button', { name: /Toggle explorer/ }))

    expect(onRunCommand).toHaveBeenCalledWith('toggleSidebar')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('does not run project commands when no project is open', () => {
    const onRunCommand = mock(() => {})
    const ref = createRef<CommandPaletteHandle>()
    render(<CommandPaletteController ref={ref} gitRepositoryOpen={false} projectOpen={false}
      keybindings={DEFAULT_KEYBINDINGS} onOpenPullRequest={() => {}} onOpenRepository={() => {}}
      onOpenSettings={() => {}} onToggleTerminal={() => {}} onRunCommand={onRunCommand} />)

    act(() => ref.current?.toggle())
    const button = screen.getByRole('button', { name: /Toggle explorer/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRunCommand).not.toHaveBeenCalled()
  })
})
