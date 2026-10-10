// Investor OS has no login of its own — the only way in is the SSO bridge from
// Founder OS (launchpad_v5's Dashboard → "Investor OS" → this app's /sso route).
// The bridged token is a 30-day JWT scoped to one startup (carries startupId claim)
// and is the ongoing credential sent on every call back to this app's own backend —
// there's no separate session system here, same model as mentor-os / ecosystem-os.
const TOKEN_KEY = 'investoros_token'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export const LAUNCHPAD_APP_URL = process.env.NEXT_PUBLIC_LAUNCHPAD_APP_URL || 'http://localhost:3000'
