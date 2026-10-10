'use client'

import { useEffect, useState } from 'react'
import { getToken, LAUNCHPAD_APP_URL } from '../../lib/auth'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!getToken()) {
      window.location.href = `${LAUNCHPAD_APP_URL}/dashboard`
      return
    }
    setReady(true)
  }, [])

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" />
      </div>
    )
  }

  return <>{children}</>
}
