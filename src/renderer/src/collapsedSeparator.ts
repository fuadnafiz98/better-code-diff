export const CENTERED_COLLAPSED_SEPARATOR_CSS = `
  :host {
    container-type: inline-size;
  }

  /* Widths below are measured against the nearest container. In wrap mode the
     panes are display:contents, so that is the whole viewer and the label centres
     across both panes; in scroll mode each pane is a real scrolling box, which
     clips anything wider — there the label centres inside its own pane instead. */
  [data-code] {
    container-type: inline-size;
  }

  [data-separator="line-info-basic"] {
    border-block: 0;
    background: transparent;
  }

  [data-separator="line-info-basic"] [data-separator-wrapper] {
    width: 100cqi;
    grid-template-columns: 32px minmax(0, 1fr) 32px;
    /* Inherited rather than set: the wrapper covers the whole strip, and its own
       fill would otherwise show the page background through any cell no button
       occupies — a white notch at the end of the strip. */
    background: inherit;
  }

  [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
    grid-template-columns: 32px 32px minmax(0, 1fr) 32px 32px;
  }

  /* A collapsed run of lines reads as a seam in the file: one hairline across the
     strip, broken by the count. */
  [data-separator="line-info-basic"] [data-separator-content] {
    justify-content: center;
    gap: 8px;
    padding-inline: 12px;
    background: inherit;
  }

  [data-separator="line-info-basic"] [data-separator-content]::before,
  [data-separator="line-info-basic"] [data-separator-content]::after {
    content: "";
    flex: 1 1 0;
    height: 1px;
    background: color-mix(in srgb, var(--border) 72%, transparent);
  }

  [data-separator="line-info-basic"] [data-unmodified-lines] {
    flex: 0 1 auto;
    max-width: 46ch;
    border: 0;
    border-radius: 0;
    padding-inline: 4px;
    background: transparent;
    color: var(--faint);
    font-family: var(--font-ui);
    font-size: 10.5px;
    font-weight: 570;
    line-height: 16px;
    font-variant-numeric: tabular-nums;
  }

  /* Hovering the seam says it can be opened, which is otherwise discoverable only
     by finding the 32px chevron parked at the edge. */
  [data-separator="line-info-basic"]:hover [data-unmodified-lines] {
    color: var(--text-secondary);
  }

  /* Keep the vendor's full 32px allocation as the pointer target while drawing
     the ghost affordance two pixels inside it. Multi-button rows can therefore
     keep their vendor-managed split without a forced height. */
  [data-separator="line-info-basic"] [data-expand-button] {
    position: relative;
    min-width: 32px;
    border-block: 0;
    border-right: 0;
    background: transparent;
    color: var(--faint);
  }

  [data-separator="line-info-basic"] [data-expand-button]::before {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: var(--corner-compact);
    background: transparent;
    pointer-events: none;
  }

  [data-separator="line-info-basic"] [data-expand-button]:hover {
    background: transparent;
    color: var(--text-secondary);
  }

  [data-separator="line-info-basic"] [data-expand-button]:hover::before {
    background: var(--control-fill-hover);
  }

  [data-separator="line-info-basic"] [data-expand-button] [data-icon] {
    position: relative;
  }

  @media (pointer: fine) {
    [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
      grid-template-rows: 100%;
    }

    [data-separator="line-info-basic"] [data-separator-multi-button] [data-expand-up] {
      grid-area: 1 / 1;
    }

    [data-separator="line-info-basic"] [data-separator-multi-button] [data-expand-down] {
      grid-area: 1 / 2;
    }

    [data-separator="line-info-basic"] [data-separator-multi-button] [data-separator-content] {
      grid-area: 1 / 3 / 2 / 4;
    }
  }

  /* Centring the label means it overflows its own gutter column, so that column
     has to paint over the opposite pane and the split divider — otherwise the
     middle of the label disappears behind the other pane's line numbers. */
  [data-diff-type="split"] [data-deletions] > [data-gutter] {
    z-index: 9;
  }
`
