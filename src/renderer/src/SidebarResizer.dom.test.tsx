import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { SidebarResizer } from './SidebarResizer'

afterEach(cleanup)

function workspaceRect(): DOMRect {
  return {
    bottom: 800,
    height: 800,
    left: 0,
    right: 1_200,
    top: 0,
    width: 1_200,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }
}

test('captures workspace bounds once on pointer-down and never on pointer-move', () => {
  const { container } = render(
    <div className="workspace">
      <SidebarResizer />
    </div>
  )
  const workspace = container.querySelector('.workspace')
  const resizer = container.querySelector('.sidebar-resizer')
  if (!(workspace instanceof HTMLDivElement) || !(resizer instanceof HTMLDivElement)) {
    throw new Error('Sidebar resizer did not render inside a workspace.')
  }

  let boundReads = 0
  workspace.getBoundingClientRect = () => {
    boundReads += 1
    return workspaceRect()
  }
  const captured = new Set<number>()
  resizer.setPointerCapture = (pointerId) => { captured.add(pointerId) }
  resizer.releasePointerCapture = (pointerId) => { captured.delete(pointerId) }
  resizer.hasPointerCapture = (pointerId) => captured.has(pointerId)

  boundReads = 0
  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 280,
      pointerId: 1
    }))
  })
  expect(boundReads).toBe(1)

  act(() => {
    for (let index = 0; index < 20; index += 1) {
      resizer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 300 + index * 4,
        pointerId: 1
      }))
    }
  })
  expect(boundReads).toBe(1)
})
