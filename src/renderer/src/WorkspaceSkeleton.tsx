/**
 * Placeholder for the lazy `RepositoryWorkspace` chunk. It reuses the real
 * layout classes so the grid, the sidebar and the toolbar are already in their
 * final position at first paint: loading the chunk then fills the shell in
 * rather than replacing a centred line of text with a whole new structure.
 */

// Deterministic so the shell does not reshuffle between renders. Depth is the
// tree indent level; width is a fraction of the row.
interface SkeletonRow {
  id: string
  depth: number
  width: number
}

const TREE_ROWS: readonly SkeletonRow[] = [
  { id: 'tree-a', depth: 0, width: 0.52 },
  { id: 'tree-b', depth: 1, width: 0.68 },
  { id: 'tree-c', depth: 1, width: 0.44 },
  { id: 'tree-d', depth: 2, width: 0.61 },
  { id: 'tree-e', depth: 2, width: 0.5 },
  { id: 'tree-f', depth: 1, width: 0.73 },
  { id: 'tree-g', depth: 0, width: 0.4 },
  { id: 'tree-h', depth: 1, width: 0.58 },
  { id: 'tree-i', depth: 1, width: 0.66 },
  { id: 'tree-j', depth: 2, width: 0.47 },
  { id: 'tree-k', depth: 0, width: 0.55 },
  { id: 'tree-l', depth: 1, width: 0.62 }
]

const CODE_ROWS: readonly SkeletonRow[] = [
  0.72, 0.41, 0.58, 0.86, 0.33, 0.64, 0.5, 0.78, 0.29, 0.69, 0.55, 0.83, 0.38, 0.6, 0.47, 0.74
].map((width, index) => ({ id: `code-${index}`, depth: 0, width }))

const SKELETON_CSS = `
.workspace-skeleton { min-width: 0; min-height: 0; }
.workspace-skeleton-rows { flex: 1; min-height: 0; overflow: hidden; padding: 6px 12px; display: flex; flex-direction: column; gap: 10px; }
.workspace-skeleton-code { padding: 16px var(--gutter); gap: 9px; }
.workspace-skeleton-bar { height: 9px; flex: none; border-radius: 4px; corner-shape: squircle; background: var(--control-fill); position: relative; overflow: hidden; }
.workspace-skeleton-toolbar { display: flex; align-items: center; gap: 10px; }
.workspace-skeleton-toolbar .workspace-skeleton-bar:first-child { width: 168px; }
.workspace-skeleton-toolbar .workspace-skeleton-bar:last-child { width: 96px; height: 8px; }
.workspace-skeleton-bar::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, var(--control-fill-hover) 50%, transparent 100%);
  transform: translateX(-100%);
  animation: workspace-skeleton-sweep 1400ms linear infinite;
}
@keyframes workspace-skeleton-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .workspace-skeleton-bar::after { animation: workspace-skeleton-fade 1600ms ease-in-out infinite; animation-duration: 1600ms !important; animation-iteration-count: infinite !important; transform: none; }
  @keyframes workspace-skeleton-fade { 0%, 100% { opacity: 0; } 50% { opacity: 0.5; } }
}
`

function SkeletonBar({ width, indent }: { width: number; indent?: number }): React.JSX.Element {
  return <div className="workspace-skeleton-bar"
    style={{ width: `${Math.round(width * 100)}%`, marginInlineStart: indent == null ? undefined : `${indent}px` }} />
}

/**
 * Just the code rows — the fallback for the viewer chunk inside an already
 * mounted workspace, where the sidebar and toolbar are real.
 */
export function WorkspaceCodeSkeleton(): React.JSX.Element {
  return (
    <>
      <style href="workspace-skeleton" precedence="medium">{SKELETON_CSS}</style>
      <div className="workspace-skeleton-rows workspace-skeleton-code" role="status">
        <span className="sr-only">Preparing viewer…</span>
        {CODE_ROWS.map((row) => (
          <SkeletonBar key={row.id} width={row.width} />
        ))}
      </div>
    </>
  )
}

export function WorkspaceSkeleton(): React.JSX.Element {
  return (
    <>
      <style href="workspace-skeleton" precedence="medium">{SKELETON_CSS}</style>
      <aside className="sidebar workspace-skeleton" aria-hidden="true">
        <div className="sidebar-heading">
          <div className="sidebar-heading-identity">
            <div className="workspace-skeleton-bar" style={{ width: 24, height: 24, borderRadius: 7 }} />
          </div>
          <div className="sidebar-heading-actions">
            <div className="workspace-skeleton-bar" style={{ width: 28, height: 10 }} />
            <div className="workspace-skeleton-bar" style={{ width: 30, height: 30, borderRadius: 9 }} />
            <div className="workspace-skeleton-bar" style={{ width: 30, height: 30, borderRadius: 9 }} />
            <div className="workspace-skeleton-bar" style={{ width: 30, height: 30, borderRadius: 9 }} />
          </div>
        </div>
        <div className="workspace-skeleton-rows">
          {TREE_ROWS.map((row) => (
            <SkeletonBar key={row.id} width={row.width} indent={row.depth * 14} />
          ))}
        </div>
      </aside>
      <div className="sidebar-resizer" aria-hidden="true" />
      <section className="diff-panel workspace-skeleton">
        <div className="diff-toolbar" aria-hidden="true">
          <div className="diff-toolbar-context workspace-skeleton-toolbar">
            <div className="workspace-skeleton-bar" />
            <div className="workspace-skeleton-bar" />
          </div>
          <div className="diff-controls" style={{ minInlineSize: 336 }} />
        </div>
        <div className="workspace-skeleton-rows workspace-skeleton-code" role="status">
          <span className="sr-only">Preparing workspace…</span>
          {CODE_ROWS.map((row) => (
            <SkeletonBar key={row.id} width={row.width} />
          ))}
        </div>
      </section>
    </>
  )
}
