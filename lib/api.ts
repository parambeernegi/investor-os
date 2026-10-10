import axios from 'axios'
import { getToken, clearToken, LAUNCHPAD_APP_URL } from './auth'

// Investor OS's own backend (backend/) — shares launchpad_v5's Postgres database
// but is a separate Express server, verifying the same bridge JWT independently.
const INVESTOR_API_URL = process.env.NEXT_PUBLIC_INVESTOR_API_URL || 'http://localhost:3601'

export const api = axios.create({ baseURL: INVESTOR_API_URL, headers: { 'Content-Type': 'application/json' } })

api.interceptors.request.use(cfg => {
  const token = getToken()
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

// A 401 here means the bridged token is gone/expired — there's no local login
// to fall back to, so the only recovery is sending the user back through
// Founder OS's Dashboard to re-mint a fresh bridge link for the right startup.
api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401 && typeof window !== 'undefined') {
    clearToken()
    window.location.href = `${LAUNCHPAD_APP_URL}/dashboard`
  }
  return Promise.reject(err)
})

export interface StartupContext {
  name: string
  problem: string
  stage: string
  founderStage: string
  market: string
  irl: number
  revenue: number
  interviewsCount: number
}

export interface InvPipeItem {
  id: string
  invId: string
  stage: string
  notes: string
  nextAction: string
  nextDate: string
  fitScore: number
  activities: any[]
  prob: number | null
  probManual: boolean
  warmIntro: string
  checkAmount: number | null
  interactions: number | null
  lastContact: string
  addedAt: string
  updatedAt: string
}

export interface InvestorData {
  startup: StartupContext
  invRound: any
  invRounds: any[]
  invTasks: any[]
  invCustomInvestors: any[]
  invSavedSearches: any[]
  invUpdates: any[]
  invPipeline: InvPipeItem[]
}

export const investorApi = {
  getData: () => api.get<InvestorData>('/api/investor-data'),
  saveData: (data: Partial<Pick<InvestorData, 'invRound' | 'invRounds' | 'invTasks' | 'invCustomInvestors' | 'invSavedSearches' | 'invUpdates'>>) =>
    api.put('/api/investor-data', data),
  createPipelineItem: (item: InvPipeItem) => api.post<InvPipeItem>('/api/pipeline', item),
  updatePipelineItem: (itemId: string, data: Partial<InvPipeItem>) => api.put<InvPipeItem>(`/api/pipeline/${itemId}`, data),
  deletePipelineItem: (itemId: string) => api.delete(`/api/pipeline/${itemId}`),
}

export const aiApi = {
  chat: (message: string, agent: string, context: any) => api.post<{ answer: string }>('/api/ai/chat', { message, agent, context }),
  invFitScore: (investor: any, startup: any) => api.post<{ answer: string }>('/api/ai/inv-fit', { investor, startup }),
  invGenUpdate: (investor: any, startup: any) => api.post<{ answer: string }>('/api/ai/inv-update', { investor, startup }),
}
