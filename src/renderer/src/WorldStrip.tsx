import { memo, useState } from 'react'
import {
  IconBrandGithub,
  IconBraces,
  IconClockArrow,
  IconCodeFolder,
  IconEllipsis,
  IconGlobe,
  IconPlus,
  IconWarningOctogonFill,
  IconX
} from '@pierre/icons'

import type { ReviewWorld } from './useReviewWorlds'

const MAX_VISIBLE_WORLDS = 7

export function partitionWorlds(
  worlds: readonly ReviewWorld[],
  activeWorldId: string | null
): { visible: readonly ReviewWorld[]; overflow: readonly ReviewWorld[] } {
  if (worlds.length <= MAX_VISIBLE_WORLDS) return { visible: worlds, overflow: [] }
  const visible = worlds.slice(0, MAX_VISIBLE_WORLDS)
  const activeWorld = worlds.find((world) => world.worldId === activeWorldId)
  if (activeWorld != null && !visible.includes(activeWorld)) visible[visible.length - 1] = activeWorld
  const visibleIds = new Set(visible.map((world) => world.worldId))
  return { visible, overflow: worlds.filter((world) => !visibleIds.has(world.worldId)) }
}

interface WorldStripProps {
  worlds: readonly ReviewWorld[]
  activeWorldId: string | null
  collisionCount: number
  onFocus(worldId: string): void | Promise<boolean>
  onClose(worldId: string): void
  onNew(): void
}

function TabIcon({ world }: { world: ReviewWorld }): React.JSX.Element {
  if (world.source === 'new') return world.pending ? <IconBrandGithub /> : <IconGlobe />
  if (world.source === 'desk') return <IconCodeFolder />
  if (world.source === 'since') return <IconClockArrow />
  return <IconBrandGithub />
}

function tabTitle(world: ReviewWorld): string {
  if (world.source === 'new') return world.pending
    ? `Opening ${world.locator}`
    : 'New tab · open a folder or GitHub pull request'
  if (world.source === 'desk') return `${world.snapshot.name} · live working tree\n${world.root}`
  if (world.source === 'since') {
    return `Files changed since ${world.checkpointHeadOid.slice(0, 8)} · ${new Date(world.checkpointCreatedAt).toLocaleString()}`
  }
  return `${world.review.kind === 'github' ? world.review.pullRequest.title : world.review.title}\n${world.baseOid.slice(0, 8)} → ${world.headOid.slice(0, 8)}`
}

function WorldTab({
  world,
  active,
  collisionCount,
  onFocus,
  onClose
}: {
  world: ReviewWorld
  active: boolean
  collisionCount: number
  onFocus(worldId: string): void | Promise<boolean>
  onClose(worldId: string): void
}): React.JSX.Element {
  return (
    <div className="world-tab" data-active={active ? 'true' : undefined}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        title={tabTitle(world)}
        onClick={() => void onFocus(world.worldId)}
      >
        <span className="world-source-icon" data-source={world.source} aria-hidden="true">
          <TabIcon world={world} />
        </span>
        <span className="world-label">{world.label}</span>
        {(world.source === 'patch' && world.loadStatus === 'loading') || (world.source === 'new' && world.pending) ? (
          <span className="world-load-signal" title="Loading patch" aria-label="Loading patch" />
        ) : null}
        {active && collisionCount > 0 ? (
          <span className="world-collision-count" title={`${collisionCount} paths also changed in the matching working tree`}>
            <IconWarningOctogonFill aria-hidden="true" />
            {collisionCount}
          </span>
        ) : null}
      </button>
      <button
        className="world-close"
        type="button"
        aria-label={`Close ${world.label} tab`}
        title={`Close ${world.label}`}
        onClick={() => onClose(world.worldId)}
      >
        <IconX />
      </button>
    </div>
  )
}

function OverflowMenu({
  worlds,
  onFocus
}: {
  worlds: readonly ReviewWorld[]
  onFocus(worldId: string): void | Promise<boolean>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleWorlds = normalizedQuery === ''
    ? worlds
    : worlds.filter((world) => world.label.toLowerCase().includes(normalizedQuery))
  return <details className="world-overflow">
    <summary aria-label={`${worlds.length} more tabs`} title="More tabs">
      <IconEllipsis />
      <span>{worlds.length}</span>
    </summary>
    <div className="world-overflow-menu">
      <label>
        <span className="sr-only">Search tabs</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tabs" />
      </label>
      <div role="menu">
        {visibleWorlds.map((world) => (
          <button key={world.worldId} type="button" role="menuitem" onClick={() => void onFocus(world.worldId)}>
            <span>{world.label}</span>
            <small>{world.source === 'new' ? 'New' : world.source === 'desk'
              ? 'Working tree'
              : world.source === 'since' ? 'Since' : world.headOid.slice(0, 8)}</small>
          </button>
        ))}
        {visibleWorlds.length === 0 ? <p>No matching tabs</p> : null}
      </div>
    </div>
  </details>
}

export const WorldStrip = memo(function WorldStrip({
  worlds,
  activeWorldId,
  collisionCount,
  onFocus,
  onClose,
  onNew
}: WorldStripProps): React.JSX.Element {
  const partition = partitionWorlds(worlds, activeWorldId)
  return (
    <nav className="world-strip" aria-label="Review tabs">
      <span className="world-strip-brand" aria-label="Horus Review"><IconBraces /><span>Review</span></span>
      <div className="world-tabs" role="tablist" aria-label="Review tabs">
        {partition.visible.map((world) => (
          <WorldTab
            key={world.worldId}
            world={world}
            active={world.worldId === activeWorldId}
            collisionCount={collisionCount}
            onFocus={onFocus}
            onClose={onClose}
          />
        ))}
      </div>
      {partition.overflow.length > 0 ? <OverflowMenu worlds={partition.overflow} onFocus={onFocus} /> : null}
      <button className="world-new" type="button" aria-label="New tab" title="New Tab (⌘T)" onClick={onNew}>
        <IconPlus />
      </button>
      <span className="world-shortcuts" aria-hidden="true">⌘⇧[ ]</span>
    </nav>
  )
})
