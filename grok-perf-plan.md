# Horus startup plan

Read-only investigation of packaged startup. No source was changed.
Planned against working tree on 2026-08-30, HEAD `caa1771`.
Codex’s packaged traces were reused; this document checks them against the
code and the last `out/` build.

## Verdict

Codex is right about the bottleneck. Git restore and bundle parse are not
what the user waits on. React 19 holds the workspace skeleton for **300 ms**
after `RepositoryWorkspace` has already loaded.

Do this, in order:

1. Crash guard: `cancelContentSearch` must no-op with no repository.
2. Stop using Suspense for the first workspace (and first viewer) reveal.
   Start those imports next to `getSessionSnapshot()`, store the resolved
   `default` exports, render them directly.
3. Move `ViewerProviders` / `@pierre/diffs/react` behind that workspace
   boundary so Welcome does not parse the diff runtime.
4. Add permanent startup marks so the next trace is not a DevTools probe.

Do not statically import `RepositoryWorkspace` from `App`. That also kills
the 300 ms delay, and it also forces Welcome to parse the workspace chunk.

Codex’s estimated result after (2) is the right target:

| Milestone | Now (median, warm cache) | After (2) |
|---|---:|---:|
| Renderer navigation | 316 ms | unchanged |
| First paint | 410 ms | slightly faster if (3) lands |
| Snapshot applied | 448 ms | ~same, fetch starts earlier |
| Explorer usable | 797 ms | **~500–550 ms** |
| Multi-file review usable | 909 ms | **~610–700 ms** |

(2) without preloading the *selected* viewer will not hit the review number.
`RepositoryWorkspace` has a nested Suspense around `MultiFileReview`. Today
that second 300 ms is hidden because the parent already burned 300 ms, during
which idle preload fetches both viewers. Remove only the parent boundary and
review waits on the nested one.

## Codex, claim by claim

| Claim | Verdict | Evidence |
|---|---|---|
| Restore ~40 ms, not the wait | Agree | Main starts `beginSessionRestore()` before `createMainWindow()`. Two git spawns (`ls-files --cached -z` + `status --porcelain=v2 --branch -z`). Renderer asks after first paint. |
| Index 796 KB, parse 12.6 ms, eval 14.8 ms | Agree on size | `out/renderer/assets/index-KjkoonKL.js` is **795.6 KB**. Parse times not re-measured here. |
| Workspace chunk parse 4.6 ms | Plausible | `RepositoryWorkspace-Kn3j7kXr.js` is **317.4 KB**. |
| React 19 Suspense throttle ~300 ms | **Confirmed** | `FALLBACK_THROTTLE_MS = 300` in `node_modules/react-dom/cjs/react-dom-client.development.js`. Same constant in the profiling build. |
| Idle preload of all three modules | Real, and too late on restore | `main.tsx:35` and `App.tsx:593` both `requestIdleCallback` import workspace + `DiffSurface` + `MultiFileReview`. Restore applies at ~448 ms, before idle. |
| `ViewerProviders` pulls `@pierre/diffs/react` into Welcome | **Confirmed** | Static import at `App.tsx:64`. Index bundle contains `WorkerPool` ×6. `DiffSurface-*.js` is only 24.9 KB because the runtime is already in index. |
| CSS 154 KB | Agree | `index-o0vm-3Rn.css` is **150.9 KB** (154 KB on disk with metadata). `styles.css` is 2110 lines. |
| Welcome `cancelContentSearch` crash | **Confirmed** | Caller `useRepositorySearch.ts:121`. Handler `index.ts:401` → `requireActive()`. First render is always Welcome (`snapshot === null`). Empty query always cancels. Restore launches throw too. |
| Static import would also remove the delay | True, but wrong | Drops the Welcome-fast path. Use a resolved-module loader. |
| Preload-then-`lazy()` is enough | **False** | `import()` of a cached module still returns a thenable. First `lazy()` render still suspends one microtask. That fallback starts the 300 ms clock. Render the resolved `default` export. No `lazy()` on the first reveal. |

Codex did not re-measure a cold-disk launch. Neither did this pass.
Warm-cache numbers only.

## Timeline (restore last folder, warm cache)

Main already overlaps git with window creation:

```
app.whenReady
  loadSessionState
  beginSessionRestore()          // git, ~40 ms warm
  createMainWindow()             // show:false, loadFile
  ready-to-show → window.show()  // first paint
```

Renderer today:

```
0     process start
316   navigation
~343  index parse + eval (~13 + ~15 ms)
410   first paint = Welcome (snapshot state is still null)
448   useEffect getSessionSnapshot → applySnapshot
      Suspense mounts, lazy() misses idle preload, skeleton commits
      workspace chunk loads in ~5 ms
      React holds the skeleton until 448+300
797   explorer commits
909   MultiFileReview commits (chunk + CodeView hydrate, not a second full throttle)
```

`getSessionSnapshot` is not started until after the Welcome commit
(`App.tsx:603`). Main already has the snapshot. That is a one-frame
waterfall, not the 300 ms, but it is free to fix in the same change.

## What is actually on the critical path

### 1. React Suspense throttle — ~300 ms — fix this

`App.tsx`:

```ts
const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace'))
```

```tsx
<Suspense fallback={<WorkspaceSkeleton />}>
  <ViewerProviders theme={...}>
    <RepositoryWorkspace key={...} ... />
  </ViewerProviders>
</Suspense>
```

Nested, `RepositoryWorkspace.tsx:754`:

```tsx
<Suspense fallback={<WorkspaceCodeSkeleton />}>
  {workspaceView === 'multi' ? <MultiFileReview ... /> : <DiffSurface ... />}
</Suspense>
```

React 19: once a fallback has committed, `globalMostRecentFallbackTime` keeps
the boundary from committing the resolved child until `FALLBACK_THROTTLE_MS`
(300) has elapsed. That is intentional flicker-prevention. It is the wrong
tool for “the chunk we already decided to load on restore”.

Fix shape:

- Create `src/renderer/src/workspaceBoot.ts` as the only caller of
  `import('./RepositoryWorkspace')`, `import('./MultiFileReview')`,
  `import('./DiffSurface')`.
- In `main.tsx`, *before* `createRoot`:
  - `loadPreferences()`
  - `const sessionRestore = startSessionRestore()` (one promise, passed into `App`)
  - if `restoreLastFolder`, `preloadRepositoryWorkspace()`
  - do **not** await either before `createRoot`
- Delete both `requestIdleCallback` preloads (`main.tsx` and `App.tsx`).
- `App` holds the resolved workspace component in state
  (`setWorkspace(() => module.default)`).
- Snapshot present, module null → `<WorkspaceSkeleton />` as a **normal
  child**, not a Suspense fallback.
- Snapshot present, module ready → render the component. No `lazy()`.
- On snapshot (restore, open folder, open recent), also
  `preloadViewer(automaticWorkspaceView(snapshot, null))`.
- `openFolder` / `openRecentFolder`: start `preloadRepositoryWorkspace()`
  *before* awaiting the IPC, so the chunk races the dialog / git.
- Inside `RepositoryWorkspace`, if `getViewer(workspaceView)` is already
  resolved, render it. Keep `lazy()` only for switching to the other viewer
  later.

`automaticWorkspaceView` (`workspaceMode.ts`): dirty git or a review →
`'multi'`; clean git or a folder → `'file'`. Call it as soon as the snapshot
exists, with `repositoryReview = null` on restore (same as today).

Do not idle-preload both viewers. Welcome-only users should not parse 317 +
25 + 388 KB of JS. Starting the workspace import on Open Folder is enough:
the file dialog is longer than the chunk.

### 2. Diff runtime in the Welcome bundle — parse + memory

`App.tsx:64` statically imports `ViewerProviders`.
`ViewerProviders.tsx:3` statically imports `@pierre/diffs/react`.

Last build:

| Chunk | Size |
|---|---:|
| `index-*.js` | 795.6 KB |
| `RepositoryWorkspace-*.js` | 317.4 KB |
| `MultiFileReview-*.js` | 388.4 KB |
| `DiffSurface-*.js` | 24.9 KB |
| `TerminalDock-*.js` | 440.1 KB (already lazy) |
| `index-*.css` | 150.9 KB |

`WorkerPool` appears in the index chunk. Shiki language files are split
(emacs-lisp 772 KB, cpp 767 KB, …) and are **not** parsed at startup. Leave
them.

Fix: add `WorkspaceRoot.tsx` as the dynamic-import target.

```tsx
export default function WorkspaceRoot(props) {
  const { theme, workspaceKey, ...workspaceProps } = props
  return (
    <ViewerProviders theme={theme}>
      <RepositoryWorkspace key={workspaceKey} {...workspaceProps} />
    </ViewerProviders>
  )
}
```

The world `key` (`root:worldId`) **must stay on `RepositoryWorkspace`**, not
on `WorkspaceRoot` / `ViewerProviders`. The pool and the editor undo stack
live in the providers. Keying the providers on world id wipes edits when a
PR opens. That constraint is already written in `App.tsx` and
`ViewerProviders.tsx`.

`workspaceBoot` then `import('./WorkspaceRoot')` instead of
`./RepositoryWorkspace`.

Also lazy-load `SettingsPage` (named export, same wrapper as `RepositoryPanel`):

```ts
const SettingsPage = lazy(async () => ({
  default: (await import('./SettingsPage')).SettingsPage
}))
```

`<Suspense fallback={null}>` is fine — settings is user-initiated.

Pass bar after `bun run build`: `index-*.js` **< 600 KB** and `WorkerPool`
does not appear in it. If the file shrinks but stays ≥ 600 KB, stop and
report the new graph; do not start a general splitting campaign.

### 3. Welcome crash on every launch

`useRepositorySearch.ts` content-search effect, deps `[onError, query]`:

```ts
if (query.trim().length < 2) {
  // ...
  window.repository?.cancelContentSearch()  // fires on mount, query === ''
  return
}
```

`src/main/index.ts:401`:

```ts
ipcMain.on(IPC_CHANNELS.cancelContentSearch, () =>
  repositorySessions.requireActive().cancelContentSearch())
```

`requireActive()` throws `'Open a repository before using this action.'`
First paint is always Welcome. Restore has not applied yet. Packaged
restore launches hit this too. Codex’s Welcome-only probe made it a dialog.

Fix both sides:

```ts
// repositorySessions.ts
cancelActiveContentSearch(): void {
  if (this.#activeRoot == null) return
  this.#sessions.get(this.#activeRoot)?.repository.cancelContentSearch()
}
```

```ts
ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => {
  repositorySessions.cancelActiveContentSearch()
})
```

Renderer: do not send cancel when `snapshot == null`. Add `snapshot` to the
effect deps. `RepositoryService.cancelContentSearch()` is already safe with
no in-flight ripgrep.

Leave `searchContent` (invoke) throwing without a repository. The field is
disabled until a snapshot exists.

### 4. Permanent startup marks

There are none today. `reviewMetrics.ts` counts workspace renders and
hydrated review files. `PerformanceHud` samples CPU/memory every 3 s after
the snapshot exists (`Titlebar` mounts it only then). Neither records boot.

Marks, offsets from a single epoch (`Date.now()` at process start in main,
`performance.timeOrigin` in the renderer — store both, do not mix them in
one column):

| Mark | Where |
|---|---|
| App ready | `app.whenReady` |
| Window created | end of `createMainWindow` |
| Restore settled | `beginSessionRestore` finally |
| Renderer loaded | top of `main.tsx` |
| React committed | `useLayoutEffect` in `App` |
| Snapshot restored | `applySnapshot` / `openWorkingTree` |
| Explorer committed | `useLayoutEffect` in `RepositoryWorkspace` |
| Viewer hydrated | first `MultiFileReview` / `DiffSurface` layout |

Expose them on the existing diagnostics disclosure in `PerformanceHud`
(when the popover is open). Do not `console.log` in production. Do not add
a second HUD.

This does not make startup faster. It makes the next regression visible
without a throwaway DevTools session.

## Lower leverage (do not do yet)

**Split `styles.css`.** 2110 lines, 151 KB built. Agent/review/settings
rules are real (268 / 116 / 57 class hits). Codex measured ~23 ms largest
layout and ~15 ms font fallback. That is not the 300 ms. Revisit after (2)
and (3) if Welcome first-paint still looks heavy.

**Preload Inter latin.** `font-display: swap`, unicode-range already
limits downloads. Latin woff2 is 71 KB; latin-ext is 130 KB and should not
download for ASCII UI. The 15 ms fallback is FOUT, not a missing file.

**Defer `PerformanceHud`’s first sample.** It mounts after snapshot and
immediately `getPerformanceMetrics()`. Minor IPC during explorer hydrate.
Not the wait.

**Block `createRoot` on snapshot + workspace.** First *meaningful* paint
would be the workspace, but a slow cold-disk git would show a blank window
longer. Keep Welcome / skeleton as a normal child.

**Static-import the workspace.** Simpler, Welcome pays 317 KB (+ trees)
every launch.

**`manualChunks` / vendor splitting in `electron.vite.config.ts`.** Cache
friendly for web. Packaged Electron reads from asar; extra round-trips can
hurt. Do not add this while chasing startup.

**Shiki language chunks / wasm.** Wasm is already stubbed
(`dropShikiWasmPlugin`). Languages are already split and loaded on
highlight. 12 MB of `out/renderer` is not the parse of `index-*.js`.

**Main-process Agent SDK.** Already lazy (`agentService.ts` comment: static
import cost ~79 ms / ~16 MB). Do not touch.

**Main size.** `out/main/index.js` is 112 KB, minified. Restore already
overlaps the renderer. Not the wait.

**StrictMode double-effects.** Packaged builds are production. Ignore.

## Implementation order

### A — Crash guard (S, do first)

Files: `src/main/repositorySessions.ts`, `src/main/repositorySessions.test.ts`,
`src/main/index.ts`, `src/renderer/src/useRepositorySearch.ts`.

Tests in `repositorySessions.test.ts`: cancel with no active root does not
throw; cancel after `open()` does not throw. Do not mock `ipcMain`.

`rg "requireActive\\(\\)\\.cancelContentSearch" src/main` must be empty.

### B — Resolved workspace + selected viewer (M, the speed win)

Files: create `src/renderer/src/workspaceBoot.ts` +
`workspaceBoot.test.ts`; edit `main.tsx`, `App.tsx`,
`RepositoryWorkspace.tsx`.

`workspaceBoot.test.ts` covers `automaticWorkspaceView` choice via a thin
wrapper: dirty git → `'multi'`; clean git / folder → `'file'`. Existing
`workspaceMode.test.ts` must still pass.

Grep done-criteria:

- no `lazy(() => import('./RepositoryWorkspace'))` in `App.tsx`
- no `fallback={<WorkspaceSkeleton` in `App.tsx`
- no `requestIdleCallback` importing both viewers in `main.tsx` or `App.tsx`
- `getSessionSnapshot()` started once in `main.tsx`, not again in `App`
- `bun run build` still emits separate `RepositoryWorkspace-*`,
  `MultiFileReview-*`, `DiffSurface-*` chunks

Do not put `ViewerProviders` in the workspace chunk in this step. That is C.

### C — Providers off Welcome (M, after B)

Files: create `src/renderer/src/WorkspaceRoot.tsx`; point `workspaceBoot` at
it; drop static `ViewerProviders` / `SettingsPage` from `App.tsx`.

Forbidden: wrapping `ViewerProviders` *inside* the keyed
`RepositoryWorkspace`. That resets the worker pool and undo stack on every
world change.

### D — Marks (S, parallel with B/C)

Renderer helper next to `reviewMetrics.ts`. Main records app-ready / window
/ restore. HUD diagnostics row when the popover is open.

## Commands

| Purpose | Command |
|---|---|
| Tests | `bun test` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Build | `bun run build` |

Package manager is bun. Do not use pnpm.

After B+C, a packaged warm-cache restore should be re-traced the same way
Codex did (five launches, same repo). Explorer under ~550 ms is the pass
bar. Do not declare victory from `bun run dev`.

## Out of scope for this document

- Runtime review scrolling, PR patch streaming, memory retention (those are
  separate work in `plans/`).
- Changing `automaticWorkspaceView` rules.
- Electron V8 code cache, asar layout, Gatekeeper, notarization.
- Cold-disk measurement (needs a cache purge / reboot). Record it when
  someone next packages.

## What was not re-measured here

- Packaged launch traces (Codex’s five samples were trusted after the code
  matched).
- Cold filesystem.
- A 100k-file repository. Tree reset in `useTreeContentSync` can add time
  after explorer “usable”; that is not the 300 ms throttle.
