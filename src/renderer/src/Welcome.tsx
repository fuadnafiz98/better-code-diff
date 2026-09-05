import { useEffect, useState } from 'react'
import { IconBraces, IconFolder, IconRefresh, IconX } from '@pierre/icons'

import type { RecentFolder } from './recentFolders'
import { FolderPicker } from './FolderPicker'
import { preloadFolderCatalog } from './folderPickerModel'
import { formatKeybinding, type KeybindingMap } from './keybindings'

interface ShortcutHintProps {
  keys: string
  label: string
}

function ShortcutHint({ keys, label }: ShortcutHintProps): React.JSX.Element {
  return <kbd className="shortcut-hint" aria-label={label}>{keys}</kbd>
}

// The staged entrance runs once per app session, not on every return from Settings.
let welcomeEntranceShown = false

interface WelcomeProps {
  opening: boolean
  openingRecentPath: string | null
  recentFolders: readonly RecentFolder[]
  keybindings: KeybindingMap
  onOpen(): Promise<void>
  onOpenPickedFolder(path: string): void
  onRecentOpen(folder: RecentFolder): Promise<void>
  onRecentRemove(path: string): void
}

export function Welcome({
  onOpen,
  onOpenPickedFolder,
  opening,
  openingRecentPath,
  recentFolders,
  keybindings,
  onRecentOpen,
  onRecentRemove
}: WelcomeProps): React.JSX.Element {
  const [animateEntrance] = useState(() => !welcomeEntranceShown)
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    welcomeEntranceShown = true
  }, [])
  return (
    <section className="welcome" data-entrance={animateEntrance ? 'run' : 'off'}>
      <div className="welcome-layout">
        <header className="welcome-intro">
          <div className="welcome-identity"><IconBraces /><span>Horus</span></div>
          <h1>Your project tree,<br />built for review.</h1>
          <p className="welcome-copy">
            Open any folder. Select a file to read it, or compare its working copy with HEAD when Git is available.
          </p>
          <div className="folder-picker-host welcome-open-host">
            <button
              className="welcome-open"
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              onMouseEnter={preloadFolderCatalog}
              onFocus={preloadFolderCatalog}
              disabled={opening}
              aria-expanded={pickerOpen}
              aria-haspopup="dialog"
            >
              {opening ? <IconRefresh className="spin" /> : <IconFolder />}
              Open Folder
            </button>
            {pickerOpen ? (
              <FolderPicker
                recentFolders={recentFolders}
                openingPath={openingRecentPath}
                onClose={() => setPickerOpen(false)}
                onSelect={(path) => {
                  setPickerOpen(false)
                  onOpenPickedFolder(path)
                }}
                onUseExisting={() => {
                  setPickerOpen(false)
                  void onOpen()
                }}
              />
            ) : null}
          </div>
          <div className="shortcut-list" aria-label="Keyboard shortcuts">
            <span>Open folder</span><ShortcutHint keys={formatKeybinding(keybindings.openFolder)} label="Open folder shortcut" />
            <span>Go to file</span><ShortcutHint keys={formatKeybinding(keybindings.goToFile)} label="Go to file shortcut" />
            <span>Search contents</span><ShortcutHint keys={formatKeybinding(keybindings.searchContent)} label="Search contents shortcut" />
          </div>
        </header>

        <section className="recent-folders" aria-labelledby="recent-folders-title">
          <div className="recent-folders-heading">
            <strong id="recent-folders-title">Recent folders</strong>
            {recentFolders.length > 0 ? <span>{recentFolders.length}</span> : null}
          </div>
          {recentFolders.length > 0 ? (
            <div className="recent-folders-list">
              {recentFolders.map((folder) => (
                <div className="recent-folder" key={folder.path}>
                  <button className="recent-folder-open" type="button" title={folder.path} onClick={() => void onRecentOpen(folder)} disabled={openingRecentPath != null}>
                    {openingRecentPath === folder.path ? <IconRefresh className="spin" /> : <IconFolder />}
                    <span><strong>{folder.name}</strong><small>{folder.path}</small></span>
                  </button>
                  <button className="recent-folder-remove" type="button" onClick={() => onRecentRemove(folder.path)} aria-label={`Remove ${folder.name} from recent folders`} title="Remove from recent folders">
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="recent-folders-empty">
              <IconFolder />
              <div><strong>No recent folders</strong><span>Folders you open will appear here.</span></div>
            </div>
          )}
        </section>
      </div>
      <footer className="welcome-footer"><span>Git is optional</span><span>Local files only</span></footer>
    </section>
  )
}
