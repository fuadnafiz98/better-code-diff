const TOAST_HOST_ID = 'horus-toast-host'
const TOAST_LIFETIME_MS = 1_600
const TOAST_FADE_MS = 180
const MAX_VISIBLE_TOASTS = 3

function toastHost(): HTMLElement {
  const existing = document.getElementById(TOAST_HOST_ID)
  if (existing != null) return existing
  const host = document.createElement('div')
  host.id = TOAST_HOST_ID
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  // Theme tokens are declared on the shell, not the document root, so a toast
  // parked on the body would always render in the dark palette.
  const shell = document.querySelector('.app-shell')
  ;(shell ?? document.body).append(host)
  return host
}

// Toasts live outside React: the diff viewer's shadow-root listeners are the
// main callers, and routing them through app state would rebuild the viewer.
export function showToast(message: string): void {
  const host = toastHost()
  while (host.childElementCount >= MAX_VISIBLE_TOASTS) host.firstElementChild?.remove()

  const toast = document.createElement('div')
  toast.className = 'horus-toast'
  toast.textContent = message
  host.append(toast)
  // Entering from the removal state keeps the transition symmetric.
  toast.dataset.state = 'entering'
  window.requestAnimationFrame(() => {
    toast.dataset.state = 'visible'
  })

  window.setTimeout(() => {
    toast.dataset.state = 'leaving'
    window.setTimeout(() => toast.remove(), TOAST_FADE_MS)
  }, TOAST_LIFETIME_MS)
}
