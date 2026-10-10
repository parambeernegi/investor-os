import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const LAUNCHPAD_JWT_SECRET = process.env.LAUNCHPAD_JWT_SECRET || ''
if (!LAUNCHPAD_JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('LAUNCHPAD_JWT_SECRET is required in production — must match launchpad_v5 backend/.env\'s JWT_SECRET')
}

export interface AuthRequest extends Request {
  userId?: string
  userEmail?: string
  userRole?: string
  startupId?: string
}

// Verifies the bridge token minted by launchpad_v5's GET /api/investor-os/bridge —
// a 30-day JWT signed with launchpad's own JWT_SECRET, carrying a startupId claim.
// Investor OS has no login of its own, so this is the only way in, and every route
// here is scoped to that one startup.
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  try {
    const decoded = jwt.verify(token, LAUNCHPAD_JWT_SECRET) as any
    if (!decoded.startupId) return res.status(401).json({ error: 'Token missing startup scope' })
    req.userId = decoded.id
    req.userEmail = decoded.email
    req.userRole = decoded.role
    req.startupId = decoded.startupId
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
