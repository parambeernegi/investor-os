import { Router, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { authMiddleware, AuthRequest } from '../../middleware/auth'

const router = Router()
const prisma = new PrismaClient()
router.use(authMiddleware)

// JSON passthrough fields — the only fields PUT is allowed to touch. Mirrors the
// exact six-field allowlist launchpad_v5's syncUpdateProject uses for this page.
const JSON_FIELDS = ['invRound', 'invRounds', 'invTasks', 'invCustomInvestors', 'invSavedSearches', 'invUpdates'] as const

// GET /api/investor-data — startup context (for fit scoring + update generation)
// plus the pipeline and the six JSON passthrough fields, all scoped to the
// startupId baked into the bridge token.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const startup = await prisma.startup.findUnique({ where: { id: req.startupId } })
    if (!startup) return res.status(404).json({ error: 'Startup not found' })
    const [pipeline, interviewsCount] = await Promise.all([
      prisma.invPipelineItem.findMany({ where: { startupId: req.startupId }, orderBy: { addedAt: 'desc' } }),
      prisma.interview.count({ where: { startupId: req.startupId } }),
    ])
    res.json({
      startup: {
        name: startup.name, problem: startup.problem, stage: startup.stage,
        founderStage: startup.founderStage, market: startup.market,
        irl: startup.irl, revenue: startup.revenue, interviewsCount,
      },
      invRound: startup.invRound, invRounds: startup.invRounds, invTasks: startup.invTasks,
      invCustomInvestors: startup.invCustomInvestors, invSavedSearches: startup.invSavedSearches,
      invUpdates: startup.invUpdates, invPipeline: pipeline,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// PUT /api/investor-data — merges any subset of the six JSON passthrough fields.
router.put('/', async (req: AuthRequest, res: Response) => {
  try {
    const data: Record<string, any> = {}
    for (const key of JSON_FIELDS) if (key in req.body) data[key] = req.body[key]
    const startup = await prisma.startup.update({ where: { id: req.startupId }, data })
    res.json({
      invRound: startup.invRound, invRounds: startup.invRounds, invTasks: startup.invTasks,
      invCustomInvestors: startup.invCustomInvestors, invSavedSearches: startup.invSavedSearches,
      invUpdates: startup.invUpdates,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export const investorDataRouter = router
