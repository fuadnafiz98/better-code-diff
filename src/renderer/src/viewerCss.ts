import { CENTERED_COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import { COPY_FILE_PATH_CSS } from './copyFilePath'
import { DRAG_SELECTION_CSS } from './dragSelection'
import { SPLIT_DIFF_RESIZE_CSS } from './splitDiffResize'
import { REVIEW_CARET_CSS } from './reviewCaret'

/**
 * A document stylesheet cannot match inside a shadow root, so styles.css's
 * reduced-motion block never reached the two surfaces a keyboard user spends the
 * whole session in. Degrading identically inside and outside the viewer means the
 * scale drops and the background tint stays as the confirmation.
 */
export const IMAGE_DIFF_PREVIEW_CSS = `
  .image-diff-preview {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: start;
    gap: 16px;
    padding: 16px 18px 24px;
  }

  .image-diff-preview.is-compare {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .image-diff-side {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .image-diff-side figcaption {
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-strong);
  }

  .image-diff-side img {
    max-width: 100%;
    max-height: min(70vh, 720px);
    height: auto;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--corner-card);
    background:
      linear-gradient(45deg, var(--panel-subtle) 25%, transparent 25%) 0 0 / 12px 12px,
      linear-gradient(-45deg, var(--panel-subtle) 25%, transparent 25%) 0 6px / 12px 12px,
      var(--canvas);
  }
`

export const REDUCED_MOTION_CSS = `
  @media (prefers-reduced-motion: reduce) {
    button {
      transition-property: background-color, color, border-color !important;
      transition-duration: var(--duration-base) !important;
      transition-timing-function: ease !important;
    }

    button:active:not(:disabled) {
      scale: 1 !important;
      transform: none !important;
    }

    [data-collapse-chevron],
    [data-expand-button] {
      transition: none !important;
    }
  }
`

/**
 * Pierre injects annotations as a row after the line. A pointer on that row is
 * mapped to the previous line, then data-selected-line is copied onto this row
 * and the paired split column — the “section” on the left and right.
 * The slotted card is also left-flush against the number gutter / split
 * divider, so a white card edge disappears into the white rule.
 */
export const ANNOTATION_LAYOUT_CSS = `
  [data-annotation-content] {
    padding: 8px 12px 10px;
    box-sizing: border-box;
  }

  [data-line-annotation][data-selected-line],
  [data-gutter-buffer="annotation"][data-selected-line] {
    --mix-selection-light: 100%;
    --mix-selection-dark: 100%;
    --diffs-selection-mix-target: var(--diffs-computed-decoration-bg);
    --diffs-computed-selected-line-bg: var(--diffs-computed-decoration-bg);
  }

  [data-line-annotation][data-hovered],
  [data-gutter-buffer="annotation"][data-hovered] {
    --diffs-computed-hovered-line-bg: var(--diffs-computed-decoration-bg);
  }
`

/**
 * Rules every diff shadow root needs. The single-file and multi-file viewers
 * used to carry their own near-identical copy and had already drifted (the
 * expand button was 24% in one and 22% in the other); both now take the absolute
 * --corner-compact token, because a percentage radius on a non-square button
 * resolves to stretched ellipses rather than a squircle.
 */
export const VIEWER_BASE_CSS = `
  /* Superellipse on every token span and line was paid on each virtual window.
     Chrome that actually rounds a corner still gets the app curve. */
  button,
  [data-expand-button],
  [data-utility-button],
  [data-separator-wrapper],
  [data-selection-action] {
    corner-shape: squircle;
  }

  /* Custom properties cross the shadow boundary, so the curve is the app's one
     curve rather than a fourth copy of the literal that drifts when it is retuned.
     Same press model as the light DOM: lands on pointer-down, eases on release,
     and rides the standalone scale property so a library transform cannot take
     the slot. */
  button {
    touch-action: manipulation;
    transition: scale var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, var(--duration-fast);
  }

  [data-separator="line-info-basic"] {
    border-block: 1px solid var(--border);
    background: var(--control-fill);
  }

  /* A percentage radius resolves horizontally against width and vertically
     against height, so on this non-square button it drew stretched ellipses
     rather than a squircle. */
  [data-expand-button] {
    border-radius: var(--corner-compact) !important;
    corner-shape: squircle !important;
  }

  [data-expand-button]:hover {
    background: var(--accent-soft);
    color: var(--path-text);
  }

  ${DRAG_SELECTION_CSS}
  ${CENTERED_COLLAPSED_SEPARATOR_CSS}
  ${SPLIT_DIFF_RESIZE_CSS}
  ${COPY_FILE_PATH_CSS}
  ${REVIEW_CARET_CSS}
  ${IMAGE_DIFF_PREVIEW_CSS}
  ${ANNOTATION_LAYOUT_CSS}
  ${REDUCED_MOTION_CSS}
`

/** Styles the popover the editor renders for a ranged selection. */
export const SELECTION_ACTION_CSS = `
  [data-selection-action] {
    display: flex;
    gap: 4px;
    padding: 4px;
    border: 0;
    border-radius: var(--corner-control);
    background: var(--floating-surface);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent);
  }

  /* Concentric: the shell's radius minus its 4px inset. */
  [data-selection-action] button {
    border: 0;
    border-radius: calc(var(--corner-control) - 4px);
    padding: 6px 10px;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  [data-selection-action] button:first-child {
    background: var(--accent-soft);
    color: var(--path-text);
  }

  [data-selection-action] button:hover {
    background: var(--control-fill-hover);
    color: var(--text);
  }

  [data-selection-action] button:active:not(:disabled) {
    scale: 0.97;
  }
`
