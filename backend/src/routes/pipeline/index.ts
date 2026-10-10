import { Router, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { authMiddleware, AuthRequest } from '../../middleware/auth'

const router = Router()
const prisma = new PrismaClient()
router.use(authMiddleware)

// Every route here is scoped to req.startupId (from the bridge token), so unlike
// launchpad_v5's own /api/investors routes there is no separate ownsStartup check needed —
// the token itself can only ever name the one startup it was minted for.

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.invPipelineItem.create({ data: { ...req.body, startupId: req.startupId } })
    res.json(item)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.invPipelineItem.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.startupId !== req.startupId) return res.status(404).json({ error: 'Not found' })
    const item = await prisma.invPipelineItem.update({ where: { id: req.params.id }, data: req.body })
    res.json(item)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.invPipelineItem.findUnique({ where: { id: req.params.id } })
    if (!existing || existing.startupId !== req.startupId) return res.status(404).json({ error: 'Not found' })
    await prisma.invPipelineItem.delete({ where: { id: req.params.id } })
    res.json({ message: 'Deleted' })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

export const pipelineRouter = router
