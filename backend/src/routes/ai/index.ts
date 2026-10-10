import { Router, Response } from 'express'
import { authMiddleware, AuthRequest } from '../../middleware/auth'
import { callClaude } from '../../services/ai/claude'
import { AGENTS } from '../../services/ai/agents'

const router = Router()
router.use(authMiddleware)

// Simplified equivalent of launchpad_v5's /api/ai/chat — same {message, agent, context}
// request shape, but with no RAG/knowledge-base retrieval and no usage-limit middleware
// (deliberately not replicated: avoids pulling in the Pinecone dependency for a satellite app).
router.post('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const { message, agent, context } = req.body
    if (!message) return res.status(400).json({ error: 'message is required' })
    const agentDef = AGENTS[agent] || AGENTS.copilot
    const answer = await callClaude(agentDef.system(context || {}), message)
    res.json({ answer })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Ported verbatim from launchpad_v5's backend/src/routes/ai/index.ts
router.post('/inv-fit', async (req: AuthRequest, res: Response) => {
  try {
    const { investor, startup } = req.body
    const system = `You are calculating fit score between a startup and an investor. Be honest. Score 0-100 and give 3 specific reasons.`
    const prompt = `Investor: ${investor.name}. Thesis: ${investor.thesis}. Stages: ${investor.stage?.join(', ')}. Sectors: ${investor.sectors?.join(', ')}.\n\nStartup: ${startup.name}. Problem: ${startup.problem}. Stage: ${startup.stage}. IRL: ${startup.irl}/9. Revenue: ₹${startup.revenue}.\n\nGive: score (0-100), 3 specific fit reasons, 1 concern.`
    const answer = await callClaude(system, prompt)
    res.json({ answer })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/inv-update', async (req: AuthRequest, res: Response) => {
  try {
    const { investor, startup } = req.body
    const system = `You are writing a personalised investor update email. Reference the investor's thesis specifically. Be concise — 150-200 words. Include: key metric progress, what you've learned, what you're doing next, and one specific ask.`
    const prompt = `Write to ${investor.name} (${investor.thesis}).\n\nStartup: ${startup.name}. IRL: ${startup.irl}/9. Revenue: ₹${startup.revenue}/mo. Interviews: ${startup.interviews}. Problem: ${startup.problem}.`
    const answer = await callClaude(system, prompt)
    res.json({ answer })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export const aiRouter = router
