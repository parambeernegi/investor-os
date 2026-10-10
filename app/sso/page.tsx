'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { setToken, LAUNCHPAD_APP_URL } from '../../lib/auth'

// Landing point for the bridge link minted by launchpad_v5's
// GET /api/investor-os/bridge. The token is a 30-day JWT scoped to one startup —
// see backend/src/routes/investoros/index.ts in launchpad_v5 for where it's minted.
function SsoInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) {
      setError('Missing sign-in token.')
      return
    }
    setToken(token)
    router.replace('/')
  }, [params, router])

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, fontFamily: 'Inter, sans-serif' }}>
        <p style={{ color: 'var(--red-text)' }}>{error}</p>
        <a href={`${LAUNCHPAD_APP_URL}/dashboard`} className="btn btn-primary">← Back to Founder OS</a>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  )
}

export default function SsoPage() {
  return (
    <Suspense fallback={null}>
      <SsoInner />
    </Suspense>
  )
}
