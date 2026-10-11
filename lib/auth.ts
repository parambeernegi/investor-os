// Investor OS has no login of its own — the only way in is the SSO bridge from
// Founder OS (launchpad_v5's Dashboard → "Investor OS" → this app's /sso route).
// The bridged token is a 30-day JWT scoped to one startup (carries startupId claim)
// and is the ongoing credential sent on every call back to this app's own backend —
// there's no separate session system here, same model as mentor-os / ecosystem-os.
const TOKEN_KEY = 'investoros_token'
const HIDDEN_PAGES_KEY = 'investoros_hiddenPages'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
  setHiddenPages(decodeHiddenPages(token))
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(HIDDEN_PAGES_KEY)
}

// The bridge token's hiddenPages claim (set by launchpad_v5's admin "Plan Features" panel,
// per plan tier) decides which of our own nav items this account can't see. Decoded
// client-side, not re-verified — it's a UI hint for nav filtering, not an access-control
// boundary; real authorization still happens server-side per API call via authMiddleware.
function decodeHiddenPages(token: string): string[] {
  try {
    const payload = token.split('.')[1]
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return Array.isArray(json.hiddenPages) ? json.hiddenPages : []
  } catch {
    return []
  }
}

function setHiddenPages(pages: string[]) {
  localStorage.setItem(HIDDEN_PAGES_KEY, JSON.stringify(pages))
}

export function getHiddenPages(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_PAGES_KEY) || '[]')
  } catch {
    return []
  }
}

export const LAUNCHPAD_APP_URL = process.env.NEXT_PUBLIC_LAUNCHPAD_APP_URL || 'http://localhost:3000'
