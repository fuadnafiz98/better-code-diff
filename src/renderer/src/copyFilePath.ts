import { showToast } from './toast'

export const COPY_FILE_PATH_CSS = `
  [data-diffs-header] [data-title],
  [data-diffs-header] [data-prev-name] {
    cursor: copy;
  }

  [data-diffs-header] [data-title]:hover,
  [data-diffs-header] [data-prev-name]:hover {
    text-decoration: underline dotted color-mix(in srgb, var(--diffs-fg) 45%, transparent);
    text-underline-offset: 3px;
  }
`

interface CopyPathBinding {
  onCopied: (path: string, copied: boolean) => void
  teardown(): void
}

const bindings = new WeakMap<HTMLElement, CopyPathBinding>()

function nameFromEvent(event: Event): string | null {
  const target = event.composedPath().find(
    (node): node is HTMLElement => node instanceof HTMLElement
      && (node.hasAttribute('data-title') || node.hasAttribute('data-prev-name'))
  )
  const name = target?.textContent?.trim()
  return name == null || name === '' ? null : name
}

export function copyTextToClipboard(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(() => true, () => false)
}

/**
 * Double-clicking a file name in a diff header copies its path. Only listeners
 * are attached here: writing into the item's rendered subtree during a render
 * pass desynchronizes the viewer's height accounting.
 */
export function syncCopyFilePathLifecycle(
  node: HTMLElement,
  phase: string,
  onCopied: (path: string, copied: boolean) => void
): void {
  if (phase === 'unmount') {
    bindings.get(node)?.teardown()
    bindings.delete(node)
    return
  }

  const existing = bindings.get(node)
  if (existing != null) {
    existing.onCopied = onCopied
    return
  }
  const root = node.shadowRoot
  if (root == null) return

  const binding: CopyPathBinding = { onCopied, teardown: () => undefined }

  const onDoubleClick = (event: Event): void => {
    const name = nameFromEvent(event)
    if (name == null) return
    event.preventDefault()
    event.stopPropagation()
    // The browser has already selected the word under the pointer by now, and
    // leaving that selection behind reads as if the copy did not happen.
    window.getSelection()?.removeAllRanges()
    void copyTextToClipboard(name).then((success) => binding.onCopied(name, success))
  }

  root.addEventListener('dblclick', onDoubleClick, true)
  binding.teardown = () => root.removeEventListener('dblclick', onDoubleClick, true)
  bindings.set(node, binding)
}

export function reportCopiedPath(path: string, copied: boolean): void {
  const name = path.split('/').at(-1) ?? path
  showToast(copied ? `Copied path · ${name}` : 'Could not copy path')
}
