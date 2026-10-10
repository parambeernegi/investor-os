import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

const NODE_ENV = process.env.NODE_ENV || 'development'

const prodEnvPath = path.resolve(__dirname, '../../.env.production')
const devEnvPath = path.resolve(__dirname, '../../.env')
const envPath = NODE_ENV === 'production' && fs.existsSync(prodEnvPath) ? prodEnvPath : devEnvPath

dotenv.config({ path: envPath })

const REQUIRED_VARS: Record<string, string[]> = {
  production: ['DATABASE_URL', 'LAUNCHPAD_JWT_SECRET', 'ANTHROPIC_API_KEY', 'ALLOWED_ORIGINS'],
  development: ['DATABASE_URL', 'LAUNCHPAD_JWT_SECRET'],
  test: ['DATABASE_URL', 'LAUNCHPAD_JWT_SECRET'],
}

const missing = (REQUIRED_VARS[NODE_ENV] || REQUIRED_VARS.development).filter(k => !process.env[k])
if (missing.length) {
  throw new Error(
    `Missing required environment variable(s) for NODE_ENV=${NODE_ENV}: ${missing.join(', ')}\n` +
    `Loaded from: ${envPath}`
  )
}

if (NODE_ENV === 'production' && process.env.ALLOWED_ORIGINS?.includes('localhost')) {
  throw new Error('ALLOWED_ORIGINS contains "localhost" in production — check .env.production')
}
