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
export const REDUCED_MOTION_CSS = `
  @media (prefers-reduced-motion: reduce) {
    button {
      transition-property: background-color, color, border-color !important;
      transition-duration: 160ms !important;
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
    transition: scale 110ms var(--ease-out), background-color 100ms var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, 100ms;
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
  ${REDUCED_MOTION_CSS}
`

/** Styles the popover the editor renders for a ranged selection. */
export const SELECTION_ACTION_CSS = `
  [data-selection-action] {
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--corner-control);
    background: var(--floating-surface);
    box-shadow: var(--elev-1);
  }

  /* Concentric: the shell's radius minus its 3px inset. */
  [data-selection-action] button {
    border: 0;
    border-radius: calc(var(--corner-control) - 3px);
    padding: 4px 8px;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  [data-selection-action] button:hover {
    background: var(--control-fill-hover);
    color: var(--text);
  }
`
