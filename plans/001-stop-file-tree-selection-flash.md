# 001 — Stop the file-tree selection flash

- **Status**: DONE
- **Commit**: f30b696
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 1 file, approximately 6 changed lines

## Problem

The file tree is a high-frequency navigation control. Its selected background is
currently animated independently on every row. When selection changes, the old
row fades out while the new row fades in, so two blue highlights are visible at
the same time. The result reads as a jump rather than one stable state change.

The selected row also receives a second press tint. Clicking the row that is
already selected temporarily replaces its selected color with `--accent-soft`,
then restores the selected color on release. This produces the reported blue
flash.

```css
/* src/renderer/src/RepositoryWorkspace.tsx:77 — current */
/* A full-width row answers a press with a tint; a ratio scale would squash it
   by 20px and read as the row being crushed. */
[data-type="item"]:active {
  scale: 1;
  background: var(--accent-soft);
}

[data-type="item"] {
  border-radius: var(--corner-compact);
  transition: background-color var(--duration-base) var(--ease-in-out);
}
```

`@pierre/trees` already owns the selected state. Its bundled stylesheet applies
`background-color: var(--trees-selected-bg)` to
`[data-item-selected="true"]`. The application-level transition above animates
that library state across separate row elements.

## Target

Selection must change immediately, with exactly one selected row visible on
every rendered frame. Do not animate the selected background. Keep the existing
press tint only for rows that are not selected.

```css
/* target: src/renderer/src/RepositoryWorkspace.tsx */
/* A full-width, unselected row answers a press with a tint; a ratio scale would
   squash it by 20px and read as the row being crushed. */
[data-type="item"]:active:not([data-item-selected="true"]) {
  scale: 1;
  background: var(--accent-soft);
}

[data-type="item"] {
  border-radius: var(--corner-compact);
}
```

Do not replace the removed transition with another duration or easing. The
animation audit requires no animation for a navigation state used 100+ times
per day.

## Repo conventions to follow

- Tree overrides live in the `TREE_STYLES` template literal in
  `src/renderer/src/RepositoryWorkspace.tsx` because the tree renders inside a
  shadow root.
- The repository already makes another high-frequency sidebar action instant:

```css
/* src/renderer/src/styles.css:212 — existing exemplar */
/* The sidebar toggle is a 100+/day shortcut; its swap is deliberately instant. */
.sidebar-icon-swap > svg { transition: none; }
```

- Preserve `--corner-compact`, `--accent-soft`, and the library-owned
  `--trees-selected-bg`. Do not introduce a new color or motion token.

## Steps

1. In `src/renderer/src/RepositoryWorkspace.tsx`, change the active-row selector
   from `[data-type="item"]:active` to
   `[data-type="item"]:active:not([data-item-selected="true"])`.
2. Update the adjacent comment to state that the press tint applies to an
   unselected row.
3. In the `[data-type="item"]` rule, delete
   `transition: background-color var(--duration-base) var(--ease-in-out);`.
4. Do not change the pointer-focus rule at lines 89–95. It preserves the focus
   outline for keyboard navigation and suppresses it only for pointer clicks.

## Boundaries

- Do NOT modify `node_modules/@pierre/trees`.
- Do NOT change file-tree markup, row height, spacing, colors, selection logic,
  scroll-follow behavior, or focus behavior.
- Do NOT remove button press feedback from other controls.
- Do NOT add a shared sliding highlight, View Transition, animation library, or
  dependency.
- If the selectors or library state attribute differ from this commit-stamped
  plan, STOP and report the drift instead of improvising.

## Verification

- **Mechanical**: from the repository root, run `bun run lint`,
  `bun run typecheck`, `bun test`, and `git diff --check`. All commands must exit
  with status 0. Then run `bun run update:mac` and confirm it reports
  `Installed Horus 0.1.0 in /Users/fuadnafiz98/Applications/Horus.app.`
- **Feel check**: open the installed app with a repository that has adjacent
  files in the Explorer. Confirm:
  - Clicking the already-selected file does not change or flash its blue fill.
  - Clicking an adjacent file shows exactly one blue selected row on every frame.
  - Holding the pointer down on an unselected row can still show the subtle press
    tint, but the tint disappears as soon as selection commits.
  - Arrow-key navigation retains the visible keyboard focus outline and changes
    selection immediately.
  - In DevTools, set animation playback to 10%. Repeated selection changes must
    not reveal any background-color animation or two-row crossfade.
  - Emulate `prefers-reduced-motion: reduce`. Selection behavior must be
    identical because this high-frequency state has no movement to reduce.
- **Done when**: a frame-by-frame recording of repeated pointer and keyboard
  selection shows one stable blue row with no tint flash and no crossfade.
