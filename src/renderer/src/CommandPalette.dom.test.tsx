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

  test('clamps the active row when the result list shrinks', () => {
    const recentFiles = Array.from({ length: 5 }, (_, index) => `src/file-${index}.ts`)
    const ref = createRef<CommandPaletteHandle>()
    render(<CommandPaletteController ref={ref} gitRepositoryOpen projectOpen
      keybindings={DEFAULT_KEYBINDINGS} recentFiles={recentFiles}
      onOpenPullRequest={() => {}} onOpenRepository={() => {}}
      onOpenSettings={() => {}} onToggleTerminal={() => {}} onOpenFile={() => {}} />)

    act(() => ref.current?.toggle())
    const input = screen.getByPlaceholderText('Search files, commands, or a pull request')
    for (let step = 0; step < 40; step += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    fireEvent.change(input, { target: { value: 'zzzz-no-palette-match' } })
    expect(screen.getByText('No matching files or commands')).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    const highlighted = document.querySelector('.primary-result')
    expect(highlighted).toBeTruthy()
  })

  test('lists repository file matches while typing', () => {
    const onOpenFile = mock(() => {})
    const onQueryChange = mock(() => {})
    const ref = createRef<CommandPaletteHandle>()
    render(<CommandPaletteController ref={ref} gitRepositoryOpen projectOpen
      keybindings={DEFAULT_KEYBINDINGS} fileResults={['src/app.ts']}
      onOpenPullRequest={() => {}} onOpenRepository={() => {}}
      onOpenSettings={() => {}} onToggleTerminal={() => {}}
      onOpenFile={onOpenFile} onQueryChange={onQueryChange} />)

    act(() => ref.current?.toggle())
    fireEvent.change(screen.getByPlaceholderText('Search files, commands, or a pull request'), {
      target: { value: 'app' }
    })
    expect(onQueryChange).toHaveBeenCalledWith('app')
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }))
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('a leading > keeps the palette on commands', () => {
    const onQueryChange = mock(() => {})
    const ref = createRef<CommandPaletteHandle>()
    render(<CommandPaletteController ref={ref} gitRepositoryOpen projectOpen
      keybindings={DEFAULT_KEYBINDINGS} fileResults={['src/app.ts']}
      onOpenPullRequest={() => {}} onOpenRepository={() => {}}
      onOpenSettings={() => {}} onToggleTerminal={() => {}}
      onRunCommand={() => {}} onOpenFile={() => {}} onQueryChange={onQueryChange} />)

    act(() => ref.current?.toggle())
    fireEvent.change(screen.getByPlaceholderText('Search files, commands, or a pull request'), {
      target: { value: '>wrap' }
    })
    expect(onQueryChange).toHaveBeenCalledWith('')
    expect(screen.getByRole('button', { name: /Toggle word wrap/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /app\.ts/ })).toBeNull()
  })
})
