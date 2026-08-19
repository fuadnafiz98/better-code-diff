export const CENTERED_COLLAPSED_SEPARATOR_CSS = `
  :host {
    container-type: inline-size;
  }

  [data-separator="line-info-basic"] [data-separator-wrapper] {
    width: 100cqi;
    grid-template-columns: 32px minmax(0, 1fr) 32px;
  }

  [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
    grid-template-columns: 32px 32px minmax(0, 1fr) 32px 32px;
  }

  [data-separator="line-info-basic"] [data-separator-content] {
    justify-content: center;
  }
`
