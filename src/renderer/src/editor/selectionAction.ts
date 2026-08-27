import type { Range } from '@pierre/diffs/edit'

/**
 * The subset of the library's `SelectionActionContext` this app uses. The type
 * is not re-exported from `@pierre/diffs/edit`, and the callback is supplied
 * structurally.
 */
export interface SelectionActionContext {
  selection: Range
  getSelectionText(): string
  close(): void
}

export interface SelectionAction {
  label: string
  run(context: SelectionActionContext): void
}

/**
 * One-based inclusive line range for a selection. A selection that ends at
 * character zero stops on the previous line's break, so the trailing line is
 * not part of what the user highlighted.
 */
export function selectionLineRange(selection: Range): { startLine: number; endLine: number } {
  const startLine = selection.start.line + 1
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1
  return { startLine, endLine }
}

export function createSelectionActionElement(
  actions: readonly SelectionAction[],
  context: SelectionActionContext
): HTMLElement {
  const container = document.createElement('div')
  container.dataset.selectionAction = 'true'
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    // Without this the click blurs the editor first, which collapses the very
    // selection the action is about to read.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      action.run(context)
      context.close()
    })
    container.append(button)
  }
  return container
}
