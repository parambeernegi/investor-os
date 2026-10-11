'use client'

import { useState, useMemo, useEffect } from 'react'
import { INVESTOR_DB, INV_STAGES } from '../../lib/data/investors'
import { T, uid } from '../../lib/theme'
import { aiApi, investorApi, InvestorData, InvPipeItem, StartupContext } from '../../lib/api'
import { LAUNCHPAD_APP_URL, getHiddenPages } from '../../lib/auth'

// Local equivalents of launchpad_v5's store/startup.ts types — this app has no
// global store, so these are just plain shapes for the JSON passthrough fields.
interface InvRound { id:string; name:string; type:string; instrument:string; targetAmount:number; valuation:string; closeDate:string; status:string; createdAt:string; closedAt?:string }
interface InvTask { id:string; title:string; due:string|null; priority:string; done:boolean; invId:string|null; type:string }
interface CustomInvestor { id:string; name:string; emoji:string; type:string; stage:string[]; sectors:string[]; geo:string; minIrl:number; checkMin:number; checkMax:number; checkLabel:string; thesis:string; portfolio:string[]; website:string; activity:string; custom:boolean }
interface SavedSearch { id:string; name:string; q:string; type:string; stage:string; sector:string; geo:string }

type Tab = 'dashboard'|'discover'|'pipeline'|'tasks'|'updates'|'analytics'|'outreach'

const ACTIVITY_TYPES = [
  {id:'note',label:'📝 Note'},{id:'call',label:'📞 Call'},
  {id:'meeting',label:'📅 Meeting'},{id:'email',label:'✉️ Email'},
  {id:'intro',label:'🤝 Introduction'},{id:'document',label:'📄 Document'},
]

const OUTREACH_TEMPLATES: Record<string,{subject:string;body:string}> = {
  research: {
    subject:'Quick question about [Startup Name]',
    body:`Hi [Name],\n\nI'm building [startup] in [space]. We [one-line traction].\n\nI noticed [fund] invested in [portfolio co] — we're solving a similar problem for [segment].\n\nWould love 15 minutes to share what we're learning.\n\n[Founder Name]`
  },
  outreach: {
    subject:'Intro: [Startup Name] — [Traction hook]',
    body:`Hi [Name],\n\nWe're [startup] — [one-line description].\n\nIn the last [X weeks]: [specific metric] ([growth rate]).\n\n[Fund]'s thesis around [thesis point] aligns well. We're raising [amount].\n\nHappy to share our deck.\n\n[Founder Name]`
  },
  intro: {
    subject:'Re: [Mutual contact] suggested I reach out',
    body:`Hi [Name],\n\n[Mutual contact] thought we should connect. Building [startup] — [one-liner].\n\nKey numbers: [metric 1], [metric 2].\n\nWould 20 min make sense this week?\n\n[Founder Name]`
  },
  meeting: {
    subject:'Thanks for the call — materials + next steps',
    body:`Hi [Name],\n\nGreat speaking today. Sharing our materials:\n\n• Deck: [link]\n• Data room: [link]\n• Key metrics: [metric summary]\n\nNext step I'd suggest: [specific ask]\n\n[Founder Name]`
  },
  dd: {
    subject:'DD materials — [Startup Name]',
    body:`Hi [Name],\n\nAs requested, our full data room: [link]\n\nIncludes: cap table, financials, customer contracts, tech docs, reference list.\n\nHappy to walk through anything.\n\n[Founder Name]`
  },
  verbal: {
    subject:'Following up on verbal — [Startup Name]',
    body:`Hi [Name],\n\nThank you for the verbal interest. Could we align on:\n\n1. Expected term sheet timeline\n2. Any remaining questions\n3. Suggested close date\n\nWe're targeting [close date].\n\n[Founder Name]`
  },
}

const OUTREACH_TYPES = [
  {id:'cold',label:'Cold Email'},
  {id:'warm',label:'Warm Introduction Request'},
  {id:'followup',label:'Follow-up Email'},
  {id:'postmeeting',label:'Post-meeting Follow-up'},
  {id:'linkedin',label:'LinkedIn Message'},
]

function fmtM(n: number): string {
  if (n >= 1000000) return `$${(n/1000000).toFixed(1)}M`
  if (n >= 1000) return `$${(n/1000).toFixed(0)}K`
  return n ? `$${n}` : '$0'
}

function parseAmount(v: string): number {
  const cleaned = (v||'').replace(/[$,]/g,'').trim()
  const m = cleaned.match(/^([\d.]+)\s*([kKmM]?)$/)
  if (!m) return parseFloat(cleaned) || 0
  const num = parseFloat(m[1]) || 0
  const mult = m[2].toLowerCase() === 'k' ? 1000 : m[2].toLowerCase() === 'm' ? 1000000 : 1
  return num * mult
}

function daysAgo(dateStr?: string): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

function fitScore(inv: any, project: any): number {
  let score = 0
  const irl = project?.irl || 1
  const stage = project?.founderStage || project?.stage || 'idea'
  const sector = (project?.market || '').toLowerCase()
  // IRL compatibility (25pts)
  if (irl >= (inv.minIrl||1)) score += 25; else score += Math.max(0, 25 - ((inv.minIrl||1) - irl) * 8)
  // Sector match (30pts) — loose match against startup name/problem keywords isn't reliable, so give partial credit
  score += 15
  // Stage match (25pts)
  const stageMap: Record<string,string> = {discovery:'pre-seed',validation:'seed',mvp:'seed','series-a':'series-a',idea:'pre-seed',traction:'seed',pmf:'series-a'}
  const myStage = stageMap[stage] || 'pre-seed'
  if (inv.stage?.includes(myStage)) score += 25; else if (inv.stage?.length) score += 8
  // Activity bonus (10pts)
  if (inv.activity === 'Very Active') score += 10; else if (inv.activity === 'Active') score += 7
  // Geography baseline (10pts)
  score += 10
  return Math.min(99, Math.max(12, score))
}

function fitReasons(inv: any, project: any): { reasons: string[]; concerns: string[] } {
  const reasons: string[] = [], concerns: string[] = []
  const irl = project?.irl || 1
  if (irl >= (inv.minIrl||1)) reasons.push(`IRL ${irl} meets their minimum (IRL ${inv.minIrl||1})`)
  else concerns.push(`Requires IRL ${inv.minIrl||1} — you are at IRL ${irl}`)
  reasons.push(`Check size ${inv.checkLabel} fits early-stage`)
  if (inv.activity === 'Very Active') reasons.push('Very actively deploying capital')
  if (inv.geo?.toLowerCase().includes('india')) reasons.push('India-focused fund')
  if (inv.stage?.length) reasons.push(`Invests at ${inv.stage.slice(0,3).join(', ')} stage`)
  return { reasons, concerns }
}

function invFitColor(score: number) {
  if (score >= 80) return { bg:'#DCFCE7', color:'#065F46' }
  if (score >= 60) return { bg:'#FEF3C7', color:'#92400E' }
  return { bg:'#FEE2E2', color:'#991B1B' }
}

function invTypeLabel(t: string) {
  return ({vc:'VC Fund',angel:'Angel',accelerator:'Accelerator',family:'Family Office',cvc:'Corporate VC'} as Record<string,string>)[t] || t
}

const inp: React.CSSProperties = {border:`1px solid ${T.border}`,borderRadius:6,padding:'8px 11px',fontSize:13,fontFamily:'system-ui',outline:'none',background:T.white}
const sel: React.CSSProperties = {border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 10px',fontSize:12,fontFamily:'system-ui',background:T.white,cursor:'pointer',outline:'none'}
const flabel: React.CSSProperties = {fontSize:11,fontFamily:'Courier New',color:T.mid,textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4,display:'block'}

export default function InvestorOS() {
  const [appData, setAppData] = useState<InvestorData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [tab, setTab] = useState<Tab>('dashboard')
  const [hiddenPages] = useState<string[]>(() => getHiddenPages())
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [filterStage, setFilterStage] = useState('all')
  const [filterSector, setFilterSector] = useState('all')
  const [filterGeo, setFilterGeo] = useState('all')
  const [filterRel, setFilterRel] = useState('all')
  const [sortBy, setSortBy] = useState('fit')
  const [checkMin, setCheckMin] = useState('')
  const [checkMax, setCheckMax] = useState('')
  const [gridView, setGridView] = useState<'card'|'list'>('card')
  const [aiSearch, setAiSearch] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState('')

  const [profileInv, setProfileInv] = useState<any>(null)
  const [profileNextAction, setProfileNextAction] = useState('')

  const [showAddModal, setShowAddModal] = useState(false)
  const [customForm, setCustomForm] = useState({name:'',type:'vc',checkLabel:'',geo:'',website:'',thesis:'',stage:'research'})

  const [showRoundModal, setShowRoundModal] = useState(false)
  const [roundForm, setRoundForm] = useState({name:'',type:'seed',instrument:'equity',target:'',valuation:'',close:''})

  const [pipeView, setPipeView] = useState<'kanban'|'table'>('kanban')
  const [dragId, setDragId] = useState<string|null>(null)

  const [updTemplate, setUpdTemplate] = useState('monthly')
  const [updTone, setUpdTone] = useState('professional')
  const [updForm, setUpdForm] = useState({revenue:'',customers:'',product:'',hiring:'',runway:'',raise:'',wins:'',challenges:'',asks:''})
  const [updOutput, setUpdOutput] = useState('')
  const [updLoading, setUpdLoading] = useState(false)

  const [outInvId, setOutInvId] = useState('')
  const [outType, setOutType] = useState('cold')
  const [outOneliner, setOutOneliner] = useState('')
  const [outMutual, setOutMutual] = useState('')
  const [outOutput, setOutOutput] = useState('')
  const [outLoading, setOutLoading] = useState(false)
  const [outreachStage, setOutreachStage] = useState('research')

  const [anaDateFilter, setAnaDateFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    investorApi.getData().then(res => {
      if (cancelled) return
      setAppData(res.data)
    }).catch((e) => {
      if (cancelled) return
      setLoadError(e.response?.data?.error || 'Could not load your investor data.')
    })
    return () => { cancelled = true }
  }, [])

  // NOTE: every hook below (useMemo) must run unconditionally on every render —
  // bailing out early here (before the hooks) when appData/loadError isn't ready
  // yet would change the hook count between the loading render and the loaded
  // render and trigger "Rendered more hooks than during the previous render."
  // So all the data this component needs falls back to safe empty defaults,
  // and the actual loading/error bail-out happens below, after every hook.
  const startup = appData?.startup ?? ({} as StartupContext)
  const pipeline = appData?.invPipeline || []
  const customInvestors = appData?.invCustomInvestors || []
  const savedSearches = appData?.invSavedSearches || []
  const tasks = appData?.invTasks || []
  const updates = appData?.invUpdates || []
  const invRounds = appData?.invRounds || []
  const round = appData?.invRound || null
  const pipelineIds = new Set(pipeline.map(p => p.invId))
  const allInvs = [...(INVESTOR_DB as unknown as any[]), ...customInvestors]

  function getInv(invId: string) { return allInvs.find(i => i.id === invId) }

  function updateInvItem(itemId: string, patch: Partial<InvPipeItem>) {
    const updatedAt = new Date().toISOString()
    setAppData(d => d ? { ...d, invPipeline: d.invPipeline.map(i => i.id === itemId ? { ...i, ...patch, updatedAt } : i) } : d)
    investorApi.updatePipelineItem(itemId, patch).catch(() => {})
  }

  function updateInvStage(itemId: string, stage: string) {
    updateInvItem(itemId, { stage })
  }

  function removeFromPipeline(itemId: string) {
    setAppData(d => d ? { ...d, invPipeline: d.invPipeline.filter(i => i.id !== itemId) } : d)
    investorApi.deletePipelineItem(itemId).catch(() => {})
  }

  function toggleInvTask(taskId: string) {
    const next = tasks.map(t => t.id === taskId ? { ...t, done: !t.done } : t)
    setAppData(d => d ? { ...d, invTasks: next } : d)
    investorApi.saveData({ invTasks: next }).catch(() => {})
  }

  function removeSavedSearch(sid: string) {
    const next = savedSearches.filter(s => s.id !== sid)
    setAppData(d => d ? { ...d, invSavedSearches: next } : d)
    investorApi.saveData({ invSavedSearches: next }).catch(() => {})
  }

  // ── KPIs ──────────────────────────────────────────────
  const matchCount = allInvs.filter(i => fitScore(i, startup) >= 60).length
  const meetingsCount = pipeline.filter(p => ['meeting','partner','dd','verbal','termsheet','committed'].includes(p.stage)).length
  const ddCount = pipeline.filter(p => ['dd','verbal','termsheet','committed'].includes(p.stage)).length
  const tasksDue = tasks.filter(t => !t.done && t.due && new Date(t.due) <= new Date()).length
  const contactedCount = pipeline.filter(p => !['research','target'].includes(p.stage)).length
  const respondedCount = pipeline.filter(p => !['research','target','outreach','passed'].includes(p.stage)).length
  const responseRate = contactedCount > 0 ? Math.round(respondedCount/contactedCount*100)+'%' : '—'

  // ── Round progress ────────────────────────────────────
  const committed = pipeline.filter(p=>p.stage==='committed').reduce((s,p)=>s+(p.checkAmount||0),0)
  const pipeValue = pipeline.filter(p=>['dd','verbal'].includes(p.stage)).reduce((s,p)=>s+(p.checkAmount||0),0)
  const roundTarget = round?.targetAmount || 0
  const roundPct = roundTarget > 0 ? Math.round(committed/roundTarget*100) : 0

  // ── Discover filtering ────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const cMin = parseFloat(checkMin) || 0
    const cMax = parseFloat(checkMax) || Infinity
    let list = allInvs.filter((inv:any) => {
      if (filterType !== 'all' && inv.type !== filterType) return false
      if (filterStage !== 'all' && inv.stage && !inv.stage.includes(filterStage)) return false
      if (filterSector !== 'all' && inv.sectors && !inv.sectors.includes(filterSector)) return false
      if (filterGeo !== 'all') {
        const geo = (inv.geo||'').toLowerCase()
        if (filterGeo==='india' && !geo.includes('india')) return false
        if (filterGeo==='global' && !geo.includes('global')) return false
        if (filterGeo==='us' && !geo.includes('us') && !geo.includes('america')) return false
        if (filterGeo==='europe' && !geo.includes('europe')) return false
        if (filterGeo==='sea' && !geo.includes('sea')) return false
      }
      if (cMin > 0 || cMax < Infinity) {
        const maxK = (inv.checkMax||0)/1000, minK = (inv.checkMin||0)/1000
        if (maxK > 0 && (maxK < cMin || minK > cMax)) return false
      }
      if (filterRel !== 'all') {
        const pipe = pipeline.find(p => p.invId === inv.id)
        if (filterRel==='not-contacted' && pipe) return false
        if (filterRel==='in-pipeline' && !pipe) return false
        if (filterRel==='active' && (!pipe || ['research','target','passed','notnow'].includes(pipe.stage))) return false
        if (filterRel==='passed' && (!pipe || pipe.stage!=='passed')) return false
      }
      if (q) {
        const s = `${inv.name} ${inv.thesis||''} ${(inv.sectors||[]).join(' ')} ${inv.geo||''}`.toLowerCase()
        if (!s.includes(q)) return false
      }
      return true
    })
    const actRank: Record<string,number> = {'Very Active':0,'Active':1,'Selective':2}
    if (sortBy==='fit') list = [...list].sort((a,b)=>fitScore(b,startup)-fitScore(a,startup))
    else if (sortBy==='check') list = [...list].sort((a,b)=>(b.checkMax||0)-(a.checkMax||0))
    else if (sortBy==='name') list = [...list].sort((a,b)=>a.name.localeCompare(b.name))
    else if (sortBy==='activity') list = [...list].sort((a,b)=>(actRank[a.activity]??3)-(actRank[b.activity]??3))
    return list
  }, [allInvs, search, filterType, filterStage, filterSector, filterGeo, filterRel, checkMin, checkMax, sortBy, pipeline, startup])

  async function doAiSearch() {
    if (!aiSearch.trim()) return
    setAiLoading(true)
    try {
      const { data } = await aiApi.chat(
        `The user searched: "${aiSearch}". Extract filters as JSON: {type:"vc|angel|accelerator|all",stage:"pre-seed|seed|series-a|all",sector:"saas|fintech|healthtech|deeptech|edtech|all",geo:"india|global|us|europe|all"}. Return ONLY valid JSON.`,
        'copilot', {startup:startup.name,problem:startup.problem,stage:startup.stage,irl:startup.irl}
      )
      const f = JSON.parse(data.answer.replace(/```json?|```/g,'').trim())
      if (f.type && f.type!=='all') setFilterType(f.type)
      if (f.stage && f.stage!=='all') setFilterStage(f.stage)
      if (f.sector && f.sector!=='all') setFilterSector(f.sector)
      if (f.geo && f.geo!=='all') setFilterGeo(f.geo)
    } catch {
      const lower = aiSearch.toLowerCase()
      if (lower.includes('seed')) setFilterStage('seed')
      if (lower.includes('angel')) setFilterType('angel')
      if (lower.includes('saas')) setFilterSector('saas')
    }
    setAiLoading(false)
  }

  function addToPipeline(inv: any) {
    if (pipelineIds.has(inv.id)) return
    const item: InvPipeItem = {
      id: uid(), invId: inv.id, stage: 'research', notes: '', nextAction: 'Research investor thesis and portfolio', nextDate: '',
      fitScore: fitScore(inv, startup), activities: [], addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      prob: 10, probManual: false, warmIntro: '', checkAmount: 0, interactions: 0, lastContact: '',
    }
    setAppData(d => d ? { ...d, invPipeline: [item, ...d.invPipeline] } : d)
    investorApi.createPipelineItem(item).catch(() => {})
  }

  function saveCustomInvestor() {
    if (!customForm.name.trim()) return
    const cid = 'custom_' + uid()
    const inv: CustomInvestor = {
      id: cid, name: customForm.name, emoji: '🏢', type: customForm.type, stage: ['seed'], sectors: [],
      geo: customForm.geo || 'Unknown', minIrl: 1, checkMin: 0, checkMax: 0,
      checkLabel: customForm.checkLabel || 'Unknown', thesis: customForm.thesis, portfolio: [],
      website: customForm.website, activity: 'Unknown', custom: true,
    }
    const nextCustom = [...customInvestors, inv]
    setAppData(d => d ? { ...d, invCustomInvestors: nextCustom } : d)
    investorApi.saveData({ invCustomInvestors: nextCustom }).catch(() => {})

    const item: InvPipeItem = {
      id: uid(), invId: cid, stage: customForm.stage, notes: '', nextAction: `Research ${customForm.name}`, nextDate: '',
      fitScore: 50, activities: [], addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      prob: 10, probManual: false, warmIntro: '', checkAmount: 0, interactions: 0, lastContact: '',
    }
    setAppData(d => d ? { ...d, invPipeline: [item, ...d.invPipeline] } : d)
    investorApi.createPipelineItem(item).catch(() => {})

    setCustomForm({name:'',type:'vc',checkLabel:'',geo:'',website:'',thesis:'',stage:'research'})
    setShowAddModal(false)
  }

  function quickLog(pipeId: string, type: string) {
    const label = ACTIVITY_TYPES.find(t=>t.id===type)?.label || type
    const note = prompt(`${label} — what happened?`)
    if (!note) return
    const item = pipeline.find(p => p.id === pipeId)
    if (!item) return
    updateInvItem(pipeId, {
      activities: [...(item.activities||[]), {type, ts:new Date().toISOString(), note}],
      interactions: (item.interactions||0)+1,
      lastContact: new Date().toISOString(),
    })
  }

  function addWarmIntro(pipeId: string) {
    const inv = getInv(pipeline.find(p=>p.id===pipeId)?.invId||'')
    const connector = prompt(`Who can introduce you to ${inv?.name||'this investor'}?\n(e.g. "Rahul Sharma — mutual LinkedIn")`)
    if (!connector) return
    updateInvItem(pipeId, {warmIntro: connector})
  }

  function scheduleFollowup(pipeId: string) {
    const cur = pipeline.find(p=>p.id===pipeId)?.nextDate || ''
    const date = prompt('Set follow-up date (YYYY-MM-DD):', cur || new Date(Date.now()+7*86400000).toISOString().slice(0,10))
    if (!date) return
    updateInvItem(pipeId, {nextDate: date})
  }

  function saveProfileNextAction() {
    if (!profileInv) return
    const pipeItem = pipeline.find(p => p.invId === profileInv.id)
    if (!pipeItem) return
    updateInvItem(pipeItem.id, {
      nextAction: profileNextAction,
      activities: [...(pipeItem.activities||[]), {type:'note', ts:new Date().toISOString(), note:'Next action: '+profileNextAction}],
    })
  }

  function openProfile(inv: any) {
    setProfileInv(inv)
    const pipeItem = pipeline.find(p => p.invId === inv.id)
    setProfileNextAction(pipeItem?.nextAction || '')
  }

  async function genUpdateForInvestor(pipeItem: InvPipeItem) {
    const inv = getInv(pipeItem.invId)
    if (!inv) return
    setAiLoading(true)
    try {
      const { data } = await aiApi.invGenUpdate(inv, {
        name:startup.name, problem:startup.problem, irl:startup.irl,
        revenue:startup.revenue, interviews:startup.interviewsCount
      })
      setAiResult(data.answer)
      const nextUpdates = [{id:uid(), ts:new Date().toISOString(), template:pipeItem.stage, text:data.answer}, ...updates]
      setAppData(d => d ? { ...d, invUpdates: nextUpdates } : d)
      investorApi.saveData({ invUpdates: nextUpdates }).catch(() => {})
    } catch { setAiResult('AI unavailable') }
    setAiLoading(false)
  }

  async function genUpdate() {
    setUpdLoading(true)
    setUpdOutput('⏳ Generating update…')
    try {
      const context = `Revenue/MRR: ${updForm.revenue||'not provided'}\nCustomers: ${updForm.customers||'not provided'}\nProduct milestone: ${updForm.product||'not provided'}\nHiring: ${updForm.hiring||'not provided'}\nCash/Runway: ${updForm.runway||'not provided'}\nFundraising: ${updForm.raise||'not provided'}\nKey Wins: ${updForm.wins||'not provided'}\nChallenges: ${updForm.challenges||'not provided'}\nAsks: ${updForm.asks||'not provided'}`
      const { data } = await aiApi.chat(
        `Generate a ${updTemplate} investor update for a startup. Tone: ${updTone}.\n\n${context}\n\nFormat with clear sections: TL;DR (2 lines), Highlights, Metrics, Product Update, Team, Fundraising, Challenges (honest), Asks. Only include sections with data provided. Never invent metrics.`,
        'copilot', {startup:startup.name, ...updForm}
      )
      setUpdOutput(data.answer)
      const nextUpdates = [{id:uid(), ts:new Date().toISOString(), template:updTemplate, text:data.answer}, ...updates]
      setAppData(d => d ? { ...d, invUpdates: nextUpdates } : d)
      investorApi.saveData({ invUpdates: nextUpdates }).catch(() => {})
    } catch (e:any) { setUpdOutput('Error: ' + (e?.message||'failed')) }
    setUpdLoading(false)
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text)
  }

  function exportUpdateEmail(text: string) {
    if (!text) return
    const subject = encodeURIComponent('Startup Update — ' + new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'}))
    window.open(`mailto:?subject=${subject}&body=${encodeURIComponent(text)}`)
  }

  async function genOutreach() {
    const inv = getInv(outInvId)
    if (!inv) return
    setOutLoading(true)
    setOutOutput('⏳ Generating…')
    try {
      const { data } = await aiApi.chat(
        `Generate a ${outType} email to ${inv.name}.\n\nInvestor thesis: ${inv.thesis||''}\nInvestor focuses on: ${(inv.sectors||[]).join(', ')} at ${(inv.stage||[]).join(', ')} stage.\n${inv.portfolio ? 'Portfolio includes: '+inv.portfolio.slice(0,3).join(', ')+'.\n' : ''}Startup: ${startup.name}. Problem: ${startup.problem}. Stage: ${startup.stage}.\n${outOneliner ? 'Founder one-liner: '+outOneliner+'\n' : ''}${outMutual ? 'Mutual connection: '+outMutual+'\n' : ''}\nWrite a concise, specific, founder-authentic ${outType} message. Reference their thesis and portfolio specifically. Never claim false connections or invent metrics. Keep it under 150 words. End with a specific ask (15-minute call).`,
        'fundraising', {startup:startup.name, problem:startup.problem, stage:startup.stage, irl:startup.irl}
      )
      setOutOutput(data.answer)
      const pipeItem = pipeline.find(p => p.invId === outInvId)
      if (pipeItem) updateInvItem(pipeItem.id, {
        activities: [...(pipeItem.activities||[]), {type:'email', ts:new Date().toISOString(), note:`Outreach email generated (${outType})`}]
      })
    } catch (e:any) { setOutOutput('Error: ' + (e?.message||'failed')) }
    setOutLoading(false)
  }

  function addTask() {
    const title = prompt('Task title:')
    if (!title) return
    const due = prompt('Due date (YYYY-MM-DD, or blank):')
    const task: InvTask = {id:uid(), title, due: due||null, priority:'medium', done:false, invId:null, type:'followup'}
    const next = [task, ...tasks]
    setAppData(d => d ? { ...d, invTasks: next } : d)
    investorApi.saveData({ invTasks: next }).catch(() => {})
  }

  function saveSearch() {
    const name = prompt('Name this search:')
    if (!name) return
    const s: SavedSearch = {id:uid(), name, q:search, type:filterType, stage:filterStage, sector:filterSector, geo:filterGeo}
    const next = [...savedSearches, s]
    setAppData(d => d ? { ...d, invSavedSearches: next } : d)
    investorApi.saveData({ invSavedSearches: next }).catch(() => {})
  }

  function loadSearch(s: SavedSearch) {
    setSearch(s.q); setFilterType(s.type); setFilterStage(s.stage); setFilterSector(s.sector); setFilterGeo(s.geo)
  }

  function createRound() {
    if (!roundForm.name.trim()) return
    const r: InvRound = {
      id: uid(), name: roundForm.name, type: roundForm.type, instrument: roundForm.instrument,
      targetAmount: parseAmount(roundForm.target), valuation: roundForm.valuation, closeDate: roundForm.close,
      status: 'open', createdAt: new Date().toISOString(),
    }
    const nextRounds = round ? [...invRounds, round] : invRounds
    setAppData(d => d ? { ...d, invRound: r, invRounds: nextRounds } : d)
    investorApi.saveData({ invRound: r, invRounds: nextRounds }).catch(() => {})
    setShowRoundModal(false)
    setRoundForm({name:'',type:'seed',instrument:'equity',target:'',valuation:'',close:''})
  }

  function closeRound() {
    if (!confirm('Mark this round as closed?')) return
    if (!round) return
    const closed: InvRound = { ...round, status: 'closed', closedAt: new Date().toISOString() }
    const nextRounds = [...invRounds, closed]
    setAppData(d => d ? { ...d, invRound: null, invRounds: nextRounds } : d)
    investorApi.saveData({ invRound: null, invRounds: nextRounds }).catch(() => {})
  }

  // ── Analytics data ────────────────────────────────────
  const anaData = useMemo(() => {
    const now = Date.now()
    const cutoff = anaDateFilter==='7'?now-7*86400000:anaDateFilter==='30'?now-30*86400000:anaDateFilter==='90'?now-90*86400000:0
    const filt = cutoff ? pipeline.filter(p => (p.updatedAt||p.addedAt) && new Date(p.updatedAt||p.addedAt).getTime()>=cutoff) : pipeline
    const contacted = filt.filter(p => !['research','target'].includes(p.stage)).length
    const responses = filt.filter(p => !['research','target','outreach'].includes(p.stage)).length
    const meetings  = filt.filter(p => ['meeting','partner','dd','verbal','termsheet','committed'].includes(p.stage)).length
    const partners  = filt.filter(p => ['partner','dd','verbal','termsheet','committed'].includes(p.stage)).length
    const dds       = filt.filter(p => ['dd','verbal','termsheet','committed'].includes(p.stage)).length
    const committedN= filt.filter(p => p.stage==='committed').length
    const passed    = filt.filter(p => p.stage==='passed').length
    const weightedVal = filt.reduce((a,p)=>a+(p.checkAmount||0)*((p.prob||0)/100),0)
    const totalVal = filt.reduce((a,p)=>a+(p.checkAmount||0),0)
    const checkItems = filt.filter(p=>(p.checkAmount||0)>0)
    const avgCheck = checkItems.length ? Math.round(checkItems.reduce((a,p)=>a+(p.checkAmount||0),0)/checkItems.length) : 0
    const avgDays = filt.length ? Math.round(filt.reduce((a,p)=>{
      const d = p.updatedAt||p.addedAt
      return a + (d ? Math.floor((now-new Date(d).getTime())/86400000) : 0)
    },0)/filt.length) : 0
    // weekly velocity from activities
    const weeks = [0,1,2,3,4,5,6,7].reverse()
    const bars = weeks.map(w => {
      const wStart = now-(w+1)*7*86400000, wEnd = now-w*7*86400000
      return pipeline.reduce((a,p)=>a+(p.activities||[]).filter((act:any)=>{
        const t = new Date(act.ts).getTime(); return t>=wStart && t<wEnd
      }).length, 0)
    })
    return {contacted, responses, meetings, partners, dds, committedN, passed, weightedVal, totalVal, avgCheck, avgDays, bars}
  }, [pipeline, anaDateFilter])

  const nextActions = useMemo(() => {
    const now = Date.now()
    const actions: {pri:number;icon:string;text:string}[] = []
    pipeline.forEach(p => {
      const inv = getInv(p.invId) || {name:p.invId}
      const da = daysAgo(p.updatedAt||p.addedAt) ?? 999
      if (p.nextDate && new Date(p.nextDate) < new Date() && !['passed','notnow','committed'].includes(p.stage))
        actions.push({pri:1, icon:'🔴', text:`Follow-up overdue with ${inv.name} (was ${new Date(p.nextDate).toLocaleDateString()})`})
      if (da >= 7 && !['passed','notnow','committed'].includes(p.stage))
        actions.push({pri:2, icon:'⏰', text:`No contact with ${inv.name} for ${da} days — follow up now`})
      if (p.stage==='dd' && da>=14)
        actions.push({pri:1, icon:'📋', text:`${inv.name} is in Due Diligence — check in on progress`})
    })
    allInvs.filter(i => fitScore(i,startup)>=80 && !pipeline.find(p=>p.invId===i.id)).slice(0,3).forEach(inv => {
      actions.push({pri:3, icon:'⭐', text:`${inv.name} scores ${fitScore(inv,startup)}/100 fit but is not yet in your pipeline`})
    })
    if (!round) actions.push({pri:4, icon:'💰', text:'Set up a fundraising round to track progress against your target'})
    if (tasks.some(t=>!t.done&&t.due&&new Date(t.due)<new Date())) actions.push({pri:2, icon:'✅', text:'You have overdue tasks — check the Tasks tab'})
    if (!actions.length) actions.push({pri:5, icon:'🎉', text:'Pipeline looks healthy! Keep conversations warm.'})
    return actions.sort((a,b)=>a.pri-b.pri).slice(0,8)
  }, [pipeline, allInvs, startup, round, tasks])

  // Every hook above has now run unconditionally, so it's safe to bail out of
  // rendering here without upsetting React's hook-order bookkeeping.
  if (loadError) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12}}>
      <div style={{color:T.mid}}>{loadError}</div>
      <a href={`${LAUNCHPAD_APP_URL}/dashboard`} className="btn btn-primary">← Back to Dashboard</a>
    </div>
  )
  if (!appData) return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}><div className="spinner"/></div>
  )

  const byStage = INV_STAGES.reduce((acc: any, s) => { acc[s.id] = pipeline.filter(p => p.stage === s.id); return acc }, {})
  const overdueTasks = tasks.filter(t=>!t.done && t.due && new Date(t.due)<new Date())
  const upcomingTasks = tasks.filter(t=>!t.done && (!t.due || new Date(t.due)>=new Date()))
  const doneTasks = tasks.filter(t=>t.done).slice(0,10)

  const kpiCards: {n:string|number;l:string;tab:Tab}[] = [
    {n:matchCount, l:'Matched', tab:'discover'},
    {n:pipeline.length, l:'In Pipeline', tab:'pipeline'},
    {n:meetingsCount, l:'Meetings', tab:'pipeline'},
    {n:ddCount, l:'Due Diligence', tab:'pipeline'},
    {n:tasksDue, l:'Tasks Due', tab:'tasks'},
    {n:responseRate, l:'Response Rate', tab:'pipeline'},
  ]

  const ALL_TABS: {id:Tab;label:string}[] = [
    {id:'dashboard', label:'🏠 Dashboard'},
    {id:'discover', label:'🔍 Discover'},
    {id:'pipeline', label:'📋 Pipeline'},
    {id:'tasks', label:'✅ Tasks'},
    {id:'updates', label:'📨 Updates'},
    {id:'analytics', label:'📊 Analytics'},
    {id:'outreach', label:'✉️ Outreach'},
  ]
  const TABS: {id:Tab;label:string}[] = ALL_TABS.filter(t => t.id === 'dashboard' || !hiddenPages.includes(t.id))

  return (
    <div style={{maxWidth:1400,margin:'0 auto',padding:24,fontFamily:'system-ui'}}>

      {/* ── COMMAND BAR ── */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:16,gap:12,flexWrap:'wrap'}}>
        <div>
          <a href={`${LAUNCHPAD_APP_URL}/dashboard`} style={{fontSize:11,fontFamily:'Courier New',color:T.mid,marginBottom:6,display:'inline-block'}}>&larr; Back to Dashboard</a>
          <div style={{fontSize:10,fontFamily:'Courier New',letterSpacing:'.12em',textTransform:'uppercase',color:T.orange,marginBottom:3}}>Fundraising OS</div>
          <div style={{fontFamily:'Georgia,serif',fontSize:22,color:T.navy,fontWeight:'bold'}}>Investor Intelligence &amp; CRM</div>
          <div style={{fontSize:13,color:T.mid,marginTop:4,lineHeight:1.5}}>Discover investors · track relationships · close your round.</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <div style={{padding:'6px 14px',background:T.navy,color:'#fff',borderRadius:20,fontSize:11,fontWeight:700,fontFamily:'Courier New'}}>
            {round ? `${round.name} · ${roundPct}%` : 'No active round'}
          </div>
          <button onClick={()=>setShowRoundModal(true)} style={{padding:'7px 14px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>+ New Round</button>
          {round && <button onClick={closeRound} style={{padding:'7px 12px',background:'none',border:`1px solid ${T.border}`,color:T.mid,borderRadius:7,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>Close Round</button>}
          <button onClick={()=>setShowAddModal(true)} style={{padding:'7px 14px',background:T.white,border:`1px solid ${T.border}`,color:T.navy,borderRadius:7,fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>+ Add Investor</button>
        </div>
      </div>

      {/* ── ROUND PROGRESS BAR ── */}
      {round && (
        <div style={{background:'linear-gradient(135deg,#0D2137,#1a3a5c)',borderRadius:10,padding:'14px 18px',marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:700,color:'#fff'}}>{round.name}</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,.5)',fontFamily:'Courier New'}}>Target close: {round.closeDate || '—'}</div>
          </div>
          <div style={{display:'flex',gap:14,flexWrap:'wrap',marginBottom:10}}>
            {[
              {l:'Target', v:fmtM(roundTarget), c:'#fff'},
              {l:'Committed', v:fmtM(committed), c:'#34D399'},
              {l:'Pipeline Value', v:fmtM(pipeValue), c:'#FCD34D'},
              {l:'Remaining', v:fmtM(Math.max(0,roundTarget-committed)), c:'#F87171'},
            ].map(s=>(
              <div key={s.l} style={{flex:1,minWidth:80}}>
                <div style={{fontSize:10,color:'rgba(255,255,255,.4)',textTransform:'uppercase',fontFamily:'Courier New',marginBottom:3}}>{s.l}</div>
                <div style={{fontSize:18,fontWeight:800,color:s.c}}>{s.v}</div>
              </div>
            ))}
          </div>
          <div style={{background:'rgba(255,255,255,.08)',borderRadius:6,height:6,overflow:'hidden'}}>
            <div style={{height:'100%',background:'linear-gradient(90deg,#34D399,#10B981)',borderRadius:6,width:`${Math.min(100,roundPct)}%`,transition:'width .5s'}}/>
          </div>
        </div>
      )}

      {/* ── KPI STRIP ── */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:14}}>
        {kpiCards.map(k=>(
          <div key={k.l} onClick={()=>setTab(k.tab)} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:9,padding:'12px 14px',cursor:'pointer'}}>
            <div style={{fontSize:22,fontWeight:800,color:T.navy,lineHeight:1}}>{k.n}</div>
            <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',textTransform:'uppercase',letterSpacing:'.06em',marginTop:3}}>{k.l}</div>
          </div>
        ))}
      </div>

      {/* ── MAIN TABS ── */}
      <div style={{display:'flex',gap:0,borderBottom:`2px solid ${T.border}`,marginBottom:16,overflowX:'auto'}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:'8px 16px',fontSize:12,fontWeight:600,background:'none',border:'none',borderBottom:tab===t.id?`2px solid ${T.orange}`:'2px solid transparent',color:tab===t.id?T.orange:T.mid,cursor:'pointer',fontFamily:'system-ui',whiteSpace:'nowrap'}}>{t.label}</button>
        ))}
      </div>

      {/* ══════════ DASHBOARD ══════════ */}
      {tab==='dashboard' && (
        <div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
            <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
              <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:10}}>🎯 Recommended Next Actions</div>
              <div style={{display:'flex',flexDirection:'column',gap:7}}>
                {nextActions.map((a,i)=>(
                  <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'10px 12px',background:T.paper,borderRadius:8,borderLeft:`3px solid ${T.orange}`}}>
                    <div style={{fontSize:18}}>{a.icon}</div>
                    <div style={{flex:1,fontSize:12,color:T.ink,lineHeight:1.5}}>{a.text}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
              <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:12}}>Pipeline Funnel <span style={{fontSize:11,color:T.mid,fontWeight:400}}>{fmtM(pipeline.reduce((a,p)=>a+(p.checkAmount||0),0))} total</span></div>
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {INV_STAGES.map(st=>{
                  const count = byStage[st.id]?.length || 0
                  const total = pipeline.length || 1
                  const pct = Math.round(count/total*100)
                  return (
                    <div key={st.id} style={{display:'flex',alignItems:'center',gap:10}}>
                      <div style={{width:130,fontSize:11,color:T.mid,textAlign:'right',paddingRight:8}}>{st.label}</div>
                      <div style={{flex:1,height:20,background:T.paper,borderRadius:5,overflow:'hidden'}}><div style={{height:'100%',width:`${pct}%`,background:st.color,borderRadius:5,transition:'width .5s'}}/></div>
                      <div style={{width:30,fontSize:11,fontWeight:700,color:T.navy,paddingLeft:6}}>{count}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
            <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:10}}>✅ Tasks</div>
            {overdueTasks.length>0 && (
              <div style={{marginBottom:10}}>
                <div style={{fontSize:10,color:T.red,fontFamily:'Courier New',textTransform:'uppercase',marginBottom:6}}>Overdue ({overdueTasks.length})</div>
                <div style={{display:'flex',flexDirection:'column',gap:5}}>
                  {overdueTasks.slice(0,5).map(t=>(
                    <div key={t.id} style={{display:'flex',justifyContent:'space-between',fontSize:12,color:T.ink,padding:'6px 10px',background:T.paper,borderRadius:6,borderLeft:`3px solid ${T.red}`}}>
                      <span>{t.title}</span>
                      <span style={{color:T.mid,fontSize:11}}>{new Date(t.due).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',textTransform:'uppercase',marginBottom:6}}>Upcoming ({upcomingTasks.length})</div>
            {upcomingTasks.length===0 ? (
              <div style={{fontSize:12,color:T.mid,fontStyle:'italic'}}>No upcoming tasks.</div>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {upcomingTasks.slice(0,5).map(t=>(
                  <div key={t.id} style={{display:'flex',justifyContent:'space-between',fontSize:12,color:T.ink,padding:'6px 10px',background:T.paper,borderRadius:6}}>
                    <span>{t.title}</span>
                    <span style={{color:T.mid,fontSize:11}}>{t.due ? new Date(t.due).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════ DISCOVER ══════════ */}
      {tab==='discover' && (
        <div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12,alignItems:'center'}}>
            <div style={{position:'relative',flex:1,minWidth:200}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, thesis, sector…" style={{...inp,width:'100%',paddingLeft:32,boxSizing:'border-box'}}/>
              <span style={{position:'absolute',left:10,top:9,fontSize:14,color:T.mid}}>🔍</span>
            </div>
            <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={sel}>
              <option value="all">All Types</option><option value="vc">VC Fund</option><option value="angel">Angel</option>
              <option value="accelerator">Accelerator</option><option value="family">Family Office</option><option value="cvc">Corporate VC</option>
            </select>
            <select value={filterStage} onChange={e=>setFilterStage(e.target.value)} style={sel}>
              <option value="all">All Stages</option><option value="pre-seed">Pre-Seed</option><option value="seed">Seed</option>
              <option value="series-a">Series A</option><option value="series-b">Series B</option><option value="growth">Growth</option>
            </select>
            <select value={filterSector} onChange={e=>setFilterSector(e.target.value)} style={sel}>
              <option value="all">All Sectors</option><option value="saas">SaaS</option><option value="fintech">Fintech</option>
              <option value="deeptech">Deeptech</option><option value="healthtech">Healthtech</option><option value="edtech">Edtech</option>
              <option value="climate">Climate</option><option value="consumer">Consumer</option>
            </select>
            <select value={filterGeo} onChange={e=>setFilterGeo(e.target.value)} style={sel}>
              <option value="all">All Geographies</option><option value="india">India</option><option value="global">Global</option>
              <option value="us">USA</option><option value="europe">Europe</option><option value="sea">SE Asia</option>
            </select>
            <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={sel}>
              <option value="fit">Sort: Best Fit</option><option value="check">Sort: Check Size</option>
              <option value="name">Sort: Name</option><option value="activity">Sort: Active</option>
            </select>
          </div>

          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8,alignItems:'center'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:T.mid}}>
              Check size:
              <input type="number" value={checkMin} onChange={e=>setCheckMin(e.target.value)} placeholder="Min $K" style={{width:80,padding:'5px 8px',border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,fontFamily:'inherit'}}/>
              <span>—</span>
              <input type="number" value={checkMax} onChange={e=>setCheckMax(e.target.value)} placeholder="Max $K" style={{width:80,padding:'5px 8px',border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,fontFamily:'inherit'}}/>
              <span style={{fontSize:10,color:T.mid}}>×$1K</span>
            </div>
            <select value={filterRel} onChange={e=>setFilterRel(e.target.value)} style={{...sel,fontSize:11}}>
              <option value="all">All Relationships</option><option value="not-contacted">Not Contacted</option>
              <option value="in-pipeline">In Pipeline</option><option value="active">Active Conversations</option><option value="passed">Passed</option>
            </select>
            <button onClick={saveSearch} style={{padding:'5px 10px',background:T.white,border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>🔖 Save Search</button>
          </div>

          {savedSearches.length > 0 && (
            <div style={{display:'flex',gap:6,marginBottom:8,flexWrap:'wrap',alignItems:'center'}}>
              {savedSearches.map(ss=>(
                <div key={ss.id} style={{display:'flex',alignItems:'center',gap:4,background:T.paper,border:`1px solid ${T.border}`,borderRadius:20,padding:'3px 4px 3px 10px'}}>
                  <button onClick={()=>loadSearch(ss)} style={{background:'none',border:'none',fontSize:11,color:T.navy,cursor:'pointer',fontFamily:'inherit'}}>🔖 {ss.name}</button>
                  <span onClick={()=>removeSavedSearch(ss.id)} style={{cursor:'pointer',color:T.mid,fontSize:13,padding:'0 4px'}}>×</span>
                </div>
              ))}
            </div>
          )}

          <div style={{background:'linear-gradient(135deg,#f0f9f0,#e8f5e9)',border:'1px solid #c8e6c9',borderRadius:9,padding:'10px 14px',marginBottom:12,display:'flex',gap:10,alignItems:'center'}}>
            <span style={{fontSize:18}}>✨</span>
            <input value={aiSearch} onChange={e=>setAiSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&doAiSearch()}
              placeholder='Try: "Find India seed investors in B2B SaaS with $500K–$2M checks"'
              style={{flex:1,border:'none',background:'transparent',fontSize:13,fontFamily:'inherit',outline:'none',color:T.navy}}/>
            <button onClick={doAiSearch} disabled={aiLoading} style={{padding:'5px 12px',background:T.teal,color:'#fff',border:'none',borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>{aiLoading?'⏳':'Search ✨'}</button>
          </div>

          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <div style={{fontSize:11,fontFamily:'Courier New',color:T.mid,textTransform:'uppercase',letterSpacing:'.06em'}}>{filtered.length} investors</div>
            <div style={{display:'flex',gap:4}}>
              <button onClick={()=>setGridView('card')} style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.border}`,background:gridView==='card'?T.navy:T.white,color:gridView==='card'?'#fff':T.mid,fontSize:11,cursor:'pointer',fontWeight:600}}>Cards</button>
              <button onClick={()=>setGridView('list')} style={{padding:'4px 10px',borderRadius:5,border:`1px solid ${T.border}`,background:gridView==='list'?T.navy:T.white,color:gridView==='list'?'#fff':T.mid,fontSize:11,cursor:'pointer',fontWeight:600}}>List</button>
            </div>
          </div>

          {gridView==='list' ? (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:T.paper}}>
                  {['Investor','Type','Stage','Check Size','Fit','Actions'].map(h=>(
                    <th key={h} style={{padding:'8px 10px',textAlign:h==='Fit'?'right':'left',fontWeight:700,color:T.navy,borderBottom:`1px solid ${T.border}`}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {filtered.map((inv:any)=>{
                    const score = fitScore(inv, startup), fc = invFitColor(score)
                    const inPipe = pipelineIds.has(inv.id)
                    return (
                      <tr key={inv.id} style={{cursor:'pointer',borderBottom:`1px solid ${T.border}`}} onClick={()=>openProfile(inv)}>
                        <td style={{padding:'9px 10px'}}><strong style={{color:T.navy}}>{inv.emoji||'🏢'} {inv.name}</strong><br/><span style={{fontSize:10,color:T.mid}}>{inv.geo||''}</span></td>
                        <td style={{padding:'9px 10px',color:T.mid}}>{invTypeLabel(inv.type)}</td>
                        <td style={{padding:'9px 10px',color:T.mid}}>{(inv.stage||[]).join(', ')}</td>
                        <td style={{padding:'9px 10px',color:T.navy,fontWeight:600}}>{inv.checkLabel}</td>
                        <td style={{padding:'9px 10px',textAlign:'right'}}><span style={{padding:'3px 9px',borderRadius:4,fontSize:11,fontWeight:700,background:fc.bg,color:fc.color}}>{score}/100</span></td>
                        <td style={{padding:'9px 10px'}}>
                          <button onClick={e=>{e.stopPropagation();addToPipeline(inv)}} style={{padding:'3px 9px',background:inPipe?'#DCFCE7':T.orange,color:inPipe?'#065F46':'#fff',border:'none',borderRadius:5,fontSize:10,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>{inPipe?'✅ In Pipeline':'+ Add'}</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!filtered.length && <div style={{textAlign:'center',padding:40,color:T.mid}}>No investors match your filters</div>}
            </div>
          ) : (
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(290px,1fr))',gap:12}}>
              {filtered.map((inv:any)=>{
                const score = fitScore(inv, startup), fc = invFitColor(score)
                const inPipe = pipelineIds.has(inv.id)
                return (
                  <div key={inv.id} onClick={()=>openProfile(inv)} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:11,padding:16,display:'flex',flexDirection:'column',gap:8,cursor:'pointer'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                      <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
                        <div style={{width:40,height:40,borderRadius:8,background:T.navy,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,flexShrink:0}}>{inv.emoji||'🏢'}</div>
                        <div>
                          <div style={{fontSize:13,fontWeight:700,color:T.navy,lineHeight:1.2}}>{inv.name}</div>
                          <div style={{fontSize:10,color:T.mid,marginTop:2}}>{invTypeLabel(inv.type)} · {inv.geo||''}</div>
                        </div>
                      </div>
                      <div style={{padding:'4px 9px',borderRadius:12,fontSize:12,fontWeight:800,background:fc.bg,color:fc.color,flexShrink:0}}>{score}</div>
                    </div>
                    <div style={{fontSize:11,color:T.mid,lineHeight:1.5}}>{(inv.thesis||'').slice(0,100)}…</div>
                    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                      {(inv.stage||[]).map((s:string)=><span key={s} style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,fontFamily:'Courier New',background:T.paper,color:T.mid}}>{s}</span>)}
                      {(inv.sectors||[]).slice(0,2).map((s:string)=><span key={s} style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,fontFamily:'Courier New',background:'#EFF6FF',color:'#1D4ED8'}}>{s}</span>)}
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
                      <div style={{fontSize:11,color:T.navy,fontWeight:700}}>{inv.checkLabel}</div>
                      <div style={{fontSize:10,color:T.mid}}>{inv.activity||''}</div>
                    </div>
                    <div style={{display:'flex',gap:6}}>
                      <button onClick={e=>{e.stopPropagation();addToPipeline(inv)}} style={{flex:1,padding:6,background:inPipe?'#DCFCE7':T.orange,color:inPipe?'#065F46':'#fff',border:'none',borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>{inPipe?'✅ In Pipeline':'+ Add to Pipeline'}</button>
                      <button onClick={e=>{e.stopPropagation();setOutInvId(inv.id);setTab('outreach')}} style={{padding:'6px 10px',background:T.white,border:`1px solid ${T.border}`,borderRadius:6,fontSize:11,cursor:'pointer',color:T.navy,fontWeight:600,fontFamily:'inherit'}}>✉️</button>
                    </div>
                  </div>
                )
              })}
              {!filtered.length && (
                <div style={{gridColumn:'1/-1',textAlign:'center',padding:40,color:T.mid}}>
                  <div style={{fontSize:32,marginBottom:12}}>🔍</div>
                  <div style={{fontWeight:700,color:T.navy}}>No investors match your filters</div>
                  <div style={{fontSize:13,marginTop:6}}>Try adjusting the filters above</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════ PIPELINE ══════════ */}
      {tab==='pipeline' && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:T.navy}}>Fundraising Pipeline</div>
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>setPipeView('kanban')} style={{padding:'5px 12px',borderRadius:6,border:`1px solid ${T.border}`,background:pipeView==='kanban'?T.navy:T.white,color:pipeView==='kanban'?'#fff':T.mid,fontSize:11,cursor:'pointer',fontWeight:600}}>Kanban</button>
              <button onClick={()=>setPipeView('table')} style={{padding:'5px 12px',borderRadius:6,border:`1px solid ${T.border}`,background:pipeView==='table'?T.navy:T.white,color:pipeView==='table'?'#fff':T.mid,fontSize:11,cursor:'pointer',fontWeight:600}}>Table</button>
            </div>
          </div>

          {pipeView==='kanban' ? (
            <div style={{display:'flex',gap:10,overflowX:'auto',paddingBottom:8}}>
              {INV_STAGES.map(stage=>{
                const items = byStage[stage.id] || []
                return (
                  <div key={stage.id}
                    onDragOver={e=>e.preventDefault()}
                    onDrop={()=>{ if(dragId) { updateInvStage(dragId, stage.id); setDragId(null) } }}
                    style={{flex:'0 0 220px',background:T.paper,borderRadius:10,padding:10,display:'flex',flexDirection:'column',gap:6}}>
                    <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',fontFamily:'Courier New',color:stage.color,marginBottom:4,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <span>{stage.label}</span>
                      <span style={{background:stage.color,color:'#fff',borderRadius:10,padding:'1px 6px',fontSize:9}}>{items.length}</span>
                    </div>
                    {items.map((p:any)=>{
                      const inv = getInv(p.invId) || {name:p.invId,emoji:'🏢',checkLabel:'—'}
                      const score = fitScore(inv, startup), fc = invFitColor(score)
                      const da = daysAgo(p.updatedAt||p.addedAt)
                      const prob = p.prob||0
                      const probColor = prob>=75?'#16A34A':prob>=40?'#F59E0B':'#EF4444'
                      return (
                        <div key={p.id} draggable onDragStart={()=>setDragId(p.id)} onClick={()=>openProfile(inv)}
                          style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:7,padding:10,cursor:'grab'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                            <div style={{fontSize:12,fontWeight:700,color:T.navy,lineHeight:1.2}}>{inv.emoji||'🏢'} {inv.name}</div>
                            <span style={{padding:'2px 6px',borderRadius:8,fontSize:10,fontWeight:700,background:fc.bg,color:fc.color}}>{score}</span>
                          </div>
                          {inv.checkLabel && <div style={{fontSize:10,color:T.mid,marginBottom:3}}>💰 {inv.checkLabel}</div>}
                          {da!==null && <div style={{fontSize:10,color:da>7?T.red:T.mid}}>⏱ {da===0?'Today':da+'d ago'}</div>}
                          <div style={{display:'flex',alignItems:'center',gap:6,marginTop:4}}>
                            <div style={{flex:1,height:3,background:T.border,borderRadius:2,overflow:'hidden'}}><div style={{height:'100%',background:probColor,width:`${prob}%`}}/></div>
                            <span style={{fontSize:10,fontWeight:700,color:probColor,fontFamily:'Courier New'}}>{prob}%</span>
                          </div>
                          {p.nextAction && <div style={{fontSize:10,background:T.paper,borderRadius:4,padding:'3px 6px',marginTop:4,color:T.ink}}>→ {p.nextAction}</div>}
                          <div style={{display:'flex',gap:4,marginTop:5,flexWrap:'wrap'}}>
                            <button onClick={e=>{e.stopPropagation();quickLog(p.id,'note')}} title="Add note" style={{fontSize:10,padding:'2px 6px',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer',background:'white',color:T.mid,fontFamily:'inherit'}}>📝</button>
                            <button onClick={e=>{e.stopPropagation();quickLog(p.id,'call')}} title="Log call" style={{fontSize:10,padding:'2px 6px',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer',background:'white',color:T.mid,fontFamily:'inherit'}}>📞</button>
                            <button onClick={e=>{e.stopPropagation();quickLog(p.id,'meeting')}} title="Log meeting" style={{fontSize:10,padding:'2px 6px',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer',background:'white',color:T.mid,fontFamily:'inherit'}}>📅</button>
                            <button onClick={e=>{e.stopPropagation();scheduleFollowup(p.id)}} title="Set follow-up" style={{fontSize:10,padding:'2px 6px',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer',background:'white',color:T.orange,fontFamily:'inherit'}}>⏰</button>
                            <button onClick={e=>{e.stopPropagation();removeFromPipeline(p.id)}} title="Remove" style={{fontSize:10,padding:'2px 6px',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer',background:'white',color:T.mid,fontFamily:'inherit'}}>✕</button>
                          </div>
                        </div>
                      )
                    })}
                    {!items.length && <div style={{fontSize:10,color:T.mid,textAlign:'center',padding:'16px 6px',border:`1px dashed ${T.border}`,borderRadius:5}}>Drop here</div>}
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:T.paper}}>
                  {['Investor','Stage','Check Size','Fit','Last Activity','Next Action','Actions'].map(h=>(
                    <th key={h} style={{padding:'8px 10px',textAlign:'left',fontWeight:700,color:T.navy,borderBottom:`1px solid ${T.border}`}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {pipeline.map(p=>{
                    const inv = getInv(p.invId) || {name:p.invId,emoji:'🏢',checkLabel:'—'}
                    const score = fitScore(inv, startup), fc = invFitColor(score)
                    const st = INV_STAGES.find(s=>s.id===p.stage)
                    const da = daysAgo(p.updatedAt||p.addedAt)
                    return (
                      <tr key={p.id} style={{borderBottom:`1px solid ${T.border}`,cursor:'pointer'}} onClick={()=>openProfile(inv)}>
                        <td style={{padding:'9px 10px'}}><strong>{inv.emoji||'🏢'} {inv.name}</strong></td>
                        <td style={{padding:'9px 10px'}}><span style={{padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:700,background:(st?.color||'#94A3B8')+'20',color:st?.color||'#94A3B8'}}>{st?.label||p.stage}</span></td>
                        <td style={{padding:'9px 10px',color:T.mid}}>{inv.checkLabel}</td>
                        <td style={{padding:'9px 10px'}}><span style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,background:fc.bg,color:fc.color}}>{score}/100</span></td>
                        <td style={{padding:'9px 10px',fontSize:11,color:T.mid}}>{da===null?'—':da===0?'Today':da+'d ago'}</td>
                        <td style={{padding:'9px 10px',fontSize:11,color:T.ink}}>{p.nextAction||'—'}</td>
                        <td style={{padding:'9px 10px'}} onClick={e=>e.stopPropagation()}>
                          <select value={p.stage} onChange={e=>updateInvStage(p.id,e.target.value)} style={{fontSize:10,padding:'3px 6px',border:`1px solid ${T.border}`,borderRadius:4,fontFamily:'inherit'}}>
                            {INV_STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!pipeline.length && <div style={{padding:24,textAlign:'center',color:T.mid}}>No investors in pipeline. Add investors from Discover tab.</div>}
            </div>
          )}
        </div>
      )}

      {/* ══════════ TASKS ══════════ */}
      {tab==='tasks' && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:T.navy}}>Fundraising Tasks</div>
            <button onClick={addTask} style={{padding:'6px 14px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>+ Add Task</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
            {[
              {label:'⚠️ Overdue', color:T.red, list:overdueTasks},
              {label:'📅 Today / Upcoming', color:T.orange, list:upcomingTasks},
              {label:'✅ Completed', color:T.mid, list:doneTasks},
            ].map(col=>(
              <div key={col.label}>
                <div style={{fontSize:11,fontWeight:700,color:col.color,textTransform:'uppercase',fontFamily:'Courier New',marginBottom:8}}>{col.label}</div>
                {col.list.map(t=>{
                  const inv = t.invId ? getInv(t.invId) : null
                  const prioColor = t.priority==='high'?T.red:t.priority==='low'?T.mid:T.orange
                  return (
                    <div key={t.id} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 12px',marginBottom:6}}>
                      <div style={{display:'flex',gap:8,alignItems:'flex-start'}}>
                        <input type="checkbox" checked={t.done} onChange={()=>toggleInvTask(t.id)} style={{marginTop:2,flexShrink:0}}/>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:700,color:T.navy,textDecoration:t.done?'line-through':'none'}}>{t.title}</div>
                          {inv && <div style={{fontSize:10,color:T.mid,marginTop:2}}>📍 {inv.name}</div>}
                          <div style={{display:'flex',gap:6,marginTop:4,alignItems:'center'}}>
                            {t.due && <span style={{fontSize:10,color:T.mid,fontFamily:'Courier New'}}>{new Date(t.due).toLocaleDateString()}</span>}
                            <span style={{fontSize:9,fontWeight:700,color:prioColor,textTransform:'uppercase'}}>{t.priority}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!col.list.length && <div style={{fontSize:12,color:T.mid,textAlign:'center',padding:'12px 0'}}>None</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════ UPDATES ══════════ */}
      {tab==='updates' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:16}}>
          <div>
            {/* Quick per-investor update (existing feature) */}
            {pipeline.filter(p=>getInv(p.invId)).length > 0 && (
              <div style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:8}}>Quick Update for a Pipeline Investor</div>
                <div style={{display:'grid',gap:8}}>
                  {pipeline.filter(p=>getInv(p.invId)).map(p=>{
                    const inv = getInv(p.invId)!
                    const stage = INV_STAGES.find(s=>s.id===p.stage)
                    return (
                      <div key={p.id} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 14px',display:'flex',gap:12,alignItems:'center'}}>
                        <span style={{fontSize:20}}>{inv.emoji||'🏢'}</span>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,color:T.navy,fontSize:12}}>{inv.name}</div>
                          <div style={{fontSize:10,color:T.mid}}>{stage?.label} · {p.interactions||0} interactions</div>
                        </div>
                        <button onClick={()=>genUpdateForInvestor(p)} disabled={aiLoading} style={{background:T.teal,color:'#fff',border:'none',borderRadius:6,padding:'6px 12px',fontSize:11,fontWeight:700,cursor:'pointer',flexShrink:0}}>{aiLoading?'⏳':'✨ Generate'}</button>
                      </div>
                    )
                  })}
                </div>
                {aiResult && (
                  <div style={{marginTop:10,background:T.paper,border:`1px solid ${T.border}`,borderRadius:8,padding:14,fontSize:13,color:T.navy,lineHeight:1.7,whiteSpace:'pre-wrap'}}>{aiResult}</div>
                )}
              </div>
            )}

            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:700,color:T.navy}}>Generate Investor Update</div>
              <select value={updTemplate} onChange={e=>setUpdTemplate(e.target.value)} style={sel}>
                <option value="monthly">Monthly Update</option><option value="quarterly">Quarterly Update</option>
                <option value="fundraising">Fundraising Update</option><option value="milestone">Milestone Update</option>
                <option value="year-end">Year-End Update</option><option value="product-launch">Product Launch Update</option>
                <option value="fundraising-announcement">Fundraising Announcement</option>
              </select>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
              {[
                {k:'revenue',l:'Revenue / MRR',ph:'e.g. $12K MRR, +25% MoM'},
                {k:'customers',l:'Customers',ph:'e.g. 45 paying customers'},
                {k:'product',l:'Key Product Win',ph:'e.g. Launched mobile app'},
                {k:'hiring',l:'Hiring',ph:'e.g. Hired CTO, 2 engineers'},
                {k:'runway',l:'Cash / Runway',ph:'e.g. $280K, 8 months runway'},
                {k:'raise',l:'Fundraising Status',ph:'e.g. Raising $500K seed'},
              ].map(f=>(
                <div key={f.k}><label style={flabel}>{f.l}</label><input value={(updForm as any)[f.k]} onChange={e=>setUpdForm(x=>({...x,[f.k]:e.target.value}))} placeholder={f.ph} style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              ))}
              {[
                {k:'wins',l:'Key Wins',ph:'Top 3 wins this month…'},
                {k:'challenges',l:'Challenges',ph:'Honest challenges you faced…'},
                {k:'asks',l:'What you need (Asks)',ph:'Introductions, advisors, customers…'},
              ].map(f=>(
                <div key={f.k} style={{gridColumn:'1/-1'}}><label style={flabel}>{f.l}</label><textarea value={(updForm as any)[f.k]} onChange={e=>setUpdForm(x=>({...x,[f.k]:e.target.value}))} rows={2} placeholder={f.ph} style={{...inp,width:'100%',boxSizing:'border-box',resize:'vertical'}}/></div>
              ))}
            </div>
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <button onClick={genUpdate} disabled={updLoading} style={{padding:'8px 18px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit',flex:1}}>{updLoading?'⏳ Generating…':'✨ Generate Update'}</button>
              <select value={updTone} onChange={e=>setUpdTone(e.target.value)} style={sel}>
                <option value="professional">Professional</option><option value="concise">Concise</option>
                <option value="founder-style">Founder Style</option><option value="transparent">Transparent</option>
              </select>
            </div>
            {updOutput && (
              <div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.navy}}>Generated Update</div>
                  <div style={{display:'flex',gap:6}}>
                    <button onClick={()=>copyText(updOutput)} style={{padding:'4px 10px',border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,cursor:'pointer',background:T.white,fontFamily:'inherit'}}>📋 Copy</button>
                    <button onClick={genUpdate} style={{padding:'4px 10px',border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,cursor:'pointer',background:T.white,fontFamily:'inherit'}}>↻ Regenerate</button>
                    <button onClick={()=>exportUpdateEmail(updOutput)} style={{padding:'4px 10px',border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,cursor:'pointer',background:T.white,fontFamily:'inherit'}}>📧 Email</button>
                  </div>
                </div>
                <textarea value={updOutput} onChange={e=>setUpdOutput(e.target.value)} rows={18} style={{width:'100%',padding:14,border:`1px solid ${T.border}`,borderRadius:8,fontSize:13,fontFamily:'inherit',lineHeight:1.7,color:T.ink,outline:'none',resize:'vertical',boxSizing:'border-box'}}/>
              </div>
            )}
          </div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:10}}>Previous Updates</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {updates.length ? updates.slice(0,8).map(u=>(
                <div key={u.id} onClick={()=>setUpdOutput(u.text)} style={{border:`1px solid ${T.border}`,borderRadius:7,padding:'10px 12px',cursor:'pointer'}}>
                  <div style={{fontSize:11,fontWeight:700,color:T.navy}}>{(u.template||'Update').charAt(0).toUpperCase()+(u.template||'Update').slice(1)} Update</div>
                  <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',marginTop:2}}>{new Date(u.ts).toLocaleDateString()}</div>
                </div>
              )) : <div style={{fontSize:12,color:T.mid,textAlign:'center',padding:'20px 0'}}>No updates sent yet.</div>}
            </div>
            <div style={{marginTop:14,padding:12,background:T.paper,borderRadius:8,fontSize:11,color:T.mid,lineHeight:1.7}}>
              <strong style={{color:T.navy}}>💡 Tips</strong><br/>
              Send monthly updates to active investors — even before you close.<br/><br/>
              Be honest about challenges. Investors value transparency over optimism.
            </div>
          </div>
        </div>
      )}

      {/* ══════════ ANALYTICS ══════════ */}
      {tab==='analytics' && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:T.navy}}>Pipeline Analytics</div>
            <select value={anaDateFilter} onChange={e=>setAnaDateFilter(e.target.value)} style={sel}>
              <option value="all">All Time</option><option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option><option value="90">Last 90 days</option>
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:8}}>
            {[
              {l:'Contacted',v:anaData.contacted,c:T.navy},
              {l:'Response Rate',v:anaData.contacted>0?Math.round(anaData.responses/anaData.contacted*100)+'%':'—',c:T.teal},
              {l:'Meetings',v:anaData.meetings,c:T.orange},
              {l:'Commit Rate',v:anaData.contacted>0?Math.round(anaData.committedN/anaData.contacted*100)+'%':'—',c:'#16a34a'},
            ].map(m=>(
              <div key={m.l} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'12px 14px',textAlign:'center'}}>
                <div style={{fontSize:22,fontWeight:800,color:m.c}}>{m.v}</div>
                <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',textTransform:'uppercase',marginTop:2}}>{m.l}</div>
              </div>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
            {[
              {l:'Partner Mtg',v:anaData.partners,c:'#7C3AED'},
              {l:'2nd Mtg Rate',v:anaData.meetings>0?Math.round(anaData.partners/anaData.meetings*100)+'%':'—',c:'#0EA5E9'},
              {l:'Weighted Val',v:fmtM(anaData.weightedVal),c:T.orange},
              {l:'Avg Check',v:anaData.avgCheck?fmtM(anaData.avgCheck):'—',c:'#10B981'},
            ].map(m=>(
              <div key={m.l} style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'12px 14px',textAlign:'center'}}>
                <div style={{fontSize:22,fontWeight:800,color:m.c}}>{m.v}</div>
                <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',textTransform:'uppercase',marginTop:2}}>{m.l}</div>
              </div>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
            <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
              <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:12}}>Pipeline Funnel <span style={{fontSize:11,color:T.mid,fontWeight:400}}>{fmtM(anaData.totalVal)} total</span></div>
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {INV_STAGES.map(st=>{
                  const count = pipeline.filter(p=>p.stage===st.id).length
                  const total = pipeline.length || 1
                  const pct = Math.round(count/total*100)
                  const wt = pipeline.filter(p=>p.stage===st.id).reduce((a,p)=>a+(p.checkAmount||0)*((p.prob||0)/100),0)
                  return (
                    <div key={st.id} style={{display:'flex',alignItems:'center',gap:10}}>
                      <div style={{width:130,fontSize:11,color:T.mid,textAlign:'right',paddingRight:8}}>{st.label}</div>
                      <div style={{flex:1,height:20,background:T.paper,borderRadius:5,overflow:'hidden'}}><div style={{height:'100%',width:`${pct}%`,background:st.color,borderRadius:5,transition:'width .5s'}}/></div>
                      <div style={{width:30,fontSize:11,fontWeight:700,color:T.navy,paddingLeft:6}}>{count}</div>
                      {wt>0 && <div style={{fontSize:10,color:T.mid,paddingLeft:4}}>{fmtM(wt)}w</div>}
                    </div>
                  )
                })}
              </div>
            </div>
            <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
              <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:12}}>Weekly Activity <span style={{fontSize:11,color:T.mid,fontWeight:400}}>{anaData.avgDays?anaData.avgDays+'d avg':''}</span></div>
              <div style={{display:'flex',gap:4,alignItems:'flex-end',height:60}}>
                {anaData.bars.map((cnt,i)=>{
                  const maxBar = Math.max(...anaData.bars,1)
                  const h = Math.max(2, Math.round((cnt/maxBar)*54))
                  return (
                    <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                      {cnt>0 && <div style={{fontSize:9,color:T.mid}}>{cnt}</div>}
                      <div style={{height:h,background:T.orange,borderRadius:'2px 2px 0 0',width:'100%'}}/>
                      <div style={{fontSize:9,color:T.mid,fontFamily:'Courier New'}}>{i===7?'Now':'W-'+(7-i)}</div>
                    </div>
                  )
                })}
              </div>
              <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',fontSize:11,color:T.mid}}>
                <span>DD: <strong style={{color:T.navy}}>{anaData.dds}</strong></span>
                <span>Passed: <strong style={{color:T.red}}>{anaData.passed}</strong></span>
                <span>Total val: <strong style={{color:T.navy}}>{fmtM(anaData.totalVal)}</strong></span>
              </div>
            </div>
          </div>
          <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:6,padding:'14px 16px'}}>
            <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:10}}>🎯 Recommended Next Actions</div>
            <div style={{display:'flex',flexDirection:'column',gap:7}}>
              {nextActions.map((a,i)=>(
                <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'10px 12px',background:T.paper,borderRadius:8,borderLeft:`3px solid ${T.orange}`}}>
                  <div style={{fontSize:18}}>{a.icon}</div>
                  <div style={{flex:1,fontSize:12,color:T.ink,lineHeight:1.5}}>{a.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════ OUTREACH ══════════ */}
      {tab==='outreach' && (
        <div>
          <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
            {INV_STAGES.slice(0,6).map(s=>(
              <button key={s.id} onClick={()=>setOutreachStage(s.id)} style={{padding:'6px 14px',fontSize:12,fontWeight:600,background:outreachStage===s.id?T.navy:T.white,color:outreachStage===s.id?'#fff':T.mid,border:`1px solid ${outreachStage===s.id?T.navy:T.border}`,borderRadius:20,cursor:'pointer'}}>{s.label}</button>
            ))}
          </div>
          {OUTREACH_TEMPLATES[outreachStage] && (
            <div style={{background:T.white,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden',marginBottom:20}}>
              <div style={{background:T.navy,padding:'12px 18px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{color:'#fff',fontSize:13,fontWeight:700}}>Subject: {OUTREACH_TEMPLATES[outreachStage].subject}</span>
                <button onClick={()=>copyText(`Subject: ${OUTREACH_TEMPLATES[outreachStage].subject}\n\n${OUTREACH_TEMPLATES[outreachStage].body}`)} style={{background:T.orange,color:'#fff',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12,fontWeight:700,cursor:'pointer'}}>📋 Copy All</button>
              </div>
              <div style={{padding:20}}>
                <pre style={{fontSize:13,color:T.navy,lineHeight:1.75,whiteSpace:'pre-wrap',fontFamily:'system-ui',margin:0,background:T.paper,borderRadius:8,padding:16}}>{OUTREACH_TEMPLATES[outreachStage].body}</pre>
              </div>
            </div>
          )}

          <div style={{display:'grid',gridTemplateColumns:'300px 1fr',gap:16}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:T.navy,marginBottom:12}}>Outreach Generator</div>
              <label style={flabel}>Select Investor</label>
              <select value={outInvId} onChange={e=>setOutInvId(e.target.value)} style={{...inp,width:'100%',marginBottom:10,boxSizing:'border-box'}}>
                <option value="">— Choose investor —</option>
                {allInvs.map((i:any)=><option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <label style={flabel}>Outreach Type</label>
              <select value={outType} onChange={e=>setOutType(e.target.value)} style={{...inp,width:'100%',marginBottom:10,boxSizing:'border-box'}}>
                {OUTREACH_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <label style={flabel}>Your Company One-liner</label>
              <input value={outOneliner} onChange={e=>setOutOneliner(e.target.value)} placeholder="We are X that helps Y do Z" style={{...inp,width:'100%',marginBottom:10,boxSizing:'border-box'}}/>
              <label style={flabel}>Mutual Connection (optional)</label>
              <input value={outMutual} onChange={e=>setOutMutual(e.target.value)} placeholder="e.g. introduced by Rahul Sharma" style={{...inp,width:'100%',marginBottom:14,boxSizing:'border-box'}}/>
              <button onClick={genOutreach} disabled={!outInvId||outLoading} style={{width:'100%',padding:9,background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit',opacity:!outInvId?0.5:1}}>{outLoading?'⏳ Generating…':'✨ Generate Outreach'}</button>
              <div style={{marginTop:12,padding:10,background:'#FEF3C7',borderRadius:7,fontSize:11,color:'#92400E',lineHeight:1.6}}>
                ⚠️ AI uses investor thesis and your startup data. Never claims false connections.
              </div>
            </div>
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div style={{fontSize:13,fontWeight:700,color:T.navy}}>Generated Message</div>
                <button onClick={()=>copyText(outOutput)} style={{padding:'5px 12px',border:`1px solid ${T.border}`,borderRadius:6,fontSize:11,cursor:'pointer',background:T.white,fontFamily:'inherit'}}>📋 Copy</button>
              </div>
              <textarea value={outOutput} onChange={e=>setOutOutput(e.target.value)} rows={20} placeholder="Your personalized outreach will appear here…"
                style={{width:'100%',padding:14,border:`1px solid ${T.border}`,borderRadius:8,fontSize:13,fontFamily:'inherit',lineHeight:1.7,color:T.ink,outline:'none',resize:'vertical',boxSizing:'border-box',background:T.paper}}/>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ INVESTOR PROFILE MODAL ══════════ */}
      {profileInv && (() => {
        const inv = profileInv
        const score = fitScore(inv, startup)
        const fc = invFitColor(score)
        const { reasons, concerns } = fitReasons(inv, startup)
        const pipeItem = pipeline.find(p => p.invId === inv.id)
        const st = pipeItem ? INV_STAGES.find(s=>s.id===pipeItem.stage) : null
        const firstContactTs = pipeItem?.activities?.length ? pipeItem.activities.reduce((min:string,a:any)=>a.ts<min?a.ts:min, pipeItem.activities[0].ts) : pipeItem?.addedAt
        const daysInPipe = pipeItem ? Math.floor((Date.now()-new Date(firstContactTs||pipeItem.addedAt).getTime())/86400000) : 0
        return (
          <div onClick={()=>setProfileInv(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
            <div onClick={e=>e.stopPropagation()} style={{background:T.white,borderRadius:14,width:'100%',maxWidth:720,maxHeight:'88vh',overflowY:'auto',display:'flex',flexDirection:'column'}}>
              <div style={{padding:'20px 24px 16px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexShrink:0}}>
                <div style={{display:'flex',gap:14,alignItems:'flex-start'}}>
                  <div style={{width:48,height:48,borderRadius:10,background:T.navy,display:'flex',alignItems:'center',justifyContent:'center',fontSize:22,flexShrink:0}}>{inv.emoji||'🏢'}</div>
                  <div>
                    <div style={{fontSize:18,fontWeight:800,color:T.navy}}>{inv.name}</div>
                    <div style={{fontSize:12,color:T.mid}}>{invTypeLabel(inv.type)} · {inv.geo||''} · {inv.checkLabel}</div>
                    <div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
                      {(inv.stage||[]).map((s:string)=><span key={s} style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,fontFamily:'Courier New',background:T.paper,color:T.mid}}>{s}</span>)}
                      <span style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,fontFamily:'Courier New',background:'#EFF6FF',color:'#1D4ED8'}}>{inv.activity||'Active'}</span>
                      {st && <span style={{padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:700,fontFamily:'Courier New',background:'#FEF3C7',color:'#92400E'}}>📋 {st.label}</span>}
                    </div>
                  </div>
                </div>
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <div style={{padding:'5px 12px',borderRadius:20,fontSize:12,fontWeight:700,background:fc.bg,color:fc.color}}>{score}/100 · {score>=80?'Strong Fit':score>=60?'Good Fit':'Potential Fit'}</div>
                  <button onClick={()=>setProfileInv(null)} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:T.mid,padding:'0 4px'}}>×</button>
                </div>
              </div>
              <div style={{padding:'20px 24px',overflowY:'auto',flex:1}}>
                {pipeItem && (
                  <>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:16,padding:12,background:T.paper,borderRadius:8}}>
                      {[
                        ['First Contact', firstContactTs?new Date(firstContactTs).toLocaleDateString():'—','#6D28D9'],
                        ['Last Contact', pipeItem.lastContact?new Date(pipeItem.lastContact).toLocaleDateString():'—','#0EA5E9'],
                        ['Interactions', String(pipeItem.interactions||0),'#F59E0B'],
                        ['In Pipeline', daysInPipe+'d','#10B981'],
                      ].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:'center'}}>
                          <div style={{fontSize:16,fontWeight:800,color:c as string}}>{v}</div>
                          <div style={{fontSize:10,color:T.mid,fontFamily:'Courier New',textTransform:'uppercase',marginTop:2}}>{l}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{background:'#FEF3C7',borderRadius:7,padding:'10px 14px',marginBottom:14,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                      <div style={{fontSize:12,color:'#92400E'}}>📅 Follow-up: <strong>{pipeItem.nextDate?new Date(pipeItem.nextDate).toLocaleDateString():'—'}</strong></div>
                      <button onClick={()=>scheduleFollowup(pipeItem.id)} style={{padding:'4px 12px',background:T.orange,color:'#fff',border:'none',borderRadius:5,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Set Date</button>
                    </div>
                    <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
                      <div style={{fontSize:11,fontWeight:700,color:T.navy,width:'100%',marginBottom:4}}>Log Activity:</div>
                      {ACTIVITY_TYPES.map(a=>(
                        <button key={a.id} onClick={()=>quickLog(pipeItem.id,a.id)} style={{padding:'5px 10px',border:`1px solid ${T.border}`,borderRadius:6,background:T.white,fontSize:11,cursor:'pointer',fontFamily:'inherit',fontWeight:600}}>{a.label}</button>
                      ))}
                    </div>
                    <div style={{background:T.paper,borderRadius:7,padding:'10px 14px',marginBottom:14}}>
                      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
                        <div style={{fontSize:11,fontWeight:700,color:T.navy}}>Deal Probability</div>
                        <div style={{fontSize:13,fontWeight:800,color:T.orange}}>{pipeItem.prob||0}%</div>
                      </div>
                      <input type="range" min={0} max={100} value={pipeItem.prob||0}
                        onChange={e=>updateInvItem(pipeItem.id, {prob:+e.target.value, probManual:true})}
                        style={{width:'100%',accentColor:T.orange}}/>
                    </div>
                    <div style={{marginBottom:14}}>
                      <label style={flabel}>Update Next Action</label>
                      <input value={profileNextAction} onChange={e=>setProfileNextAction(e.target.value)} className="finput" placeholder="What to do next…" style={{...inp,width:'100%',marginTop:4,boxSizing:'border-box'}}/>
                      <button onClick={saveProfileNextAction} style={{marginTop:6,padding:'5px 12px',background:T.teal,color:'#fff',border:'none',borderRadius:5,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Save</button>
                    </div>
                  </>
                )}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:16}}>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:T.mid,textTransform:'uppercase',fontFamily:'Courier New',marginBottom:6}}>Investment Thesis</div>
                    <div style={{fontSize:13,color:T.ink,lineHeight:1.7}}>{inv.thesis||'No thesis available.'}</div>
                  </div>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:T.mid,textTransform:'uppercase',fontFamily:'Courier New',marginBottom:8}}>Investment Profile</div>
                    <div style={{display:'flex',flexDirection:'column',gap:5,fontSize:12}}>
                      <div><span style={{color:T.mid}}>Check Size:</span> <strong>{inv.checkLabel}</strong></div>
                      <div><span style={{color:T.mid}}>Stages:</span> <strong>{(inv.stage||[]).join(', ')}</strong></div>
                      <div><span style={{color:T.mid}}>Sectors:</span> <strong>{(inv.sectors||[]).join(', ')}</strong></div>
                      <div><span style={{color:T.mid}}>Geography:</span> <strong>{inv.geo||'Not specified'}</strong></div>
                      <div><span style={{color:T.mid}}>Activity:</span> <strong>{inv.activity||'Unknown'}</strong></div>
                      {inv.lastDeal && <div><span style={{color:T.mid}}>Last Deal:</span> <strong>{inv.lastDeal}</strong></div>}
                      {inv.website && <div><a href={inv.website} target="_blank" rel="noopener noreferrer" style={{color:T.teal,fontSize:11}}>🌐 Website ↗</a></div>}
                    </div>
                  </div>
                </div>
                <div style={{background:T.paper,borderRadius:9,padding:14,marginBottom:14}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.navy,marginBottom:10}}>🎯 Why This Investor?</div>
                  {reasons.map((r,i)=><div key={i} style={{fontSize:12,color:'#065F46',marginBottom:4}}>✅ {r}</div>)}
                  {concerns.map((r,i)=><div key={i} style={{fontSize:12,color:'#92400E',marginBottom:4}}>⚠️ {r}</div>)}
                </div>
                {!!inv.portfolio?.length && (
                  <div style={{marginBottom:14}}>
                    <div style={{fontSize:11,fontWeight:700,color:T.mid,textTransform:'uppercase',fontFamily:'Courier New',marginBottom:8}}>Portfolio (Sample)</div>
                    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                      {inv.portfolio.map((p:string)=><span key={p} style={{padding:'4px 10px',background:T.paper,border:`1px solid ${T.border}`,borderRadius:5,fontSize:11,color:T.navy}}>{p}</span>)}
                    </div>
                  </div>
                )}
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:T.mid,textTransform:'uppercase',fontFamily:'Courier New',marginBottom:8}}>Activity Timeline</div>
                  {pipeItem?.activities?.length ? (
                    [...pipeItem.activities].reverse().map((a:any,i:number)=>(
                      <div key={i} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'8px 0',borderBottom:`1px solid ${T.border}`}}>
                        <div style={{fontSize:16,flexShrink:0}}>{({stage:'🔄',note:'📝',email:'📧',meeting:'📅',call:'📞',intro:'🤝',document:'📄'} as any)[a.type]||'•'}</div>
                        <div><div style={{fontSize:12,color:T.ink}}>{a.note}</div><div style={{fontSize:10,color:T.mid,fontFamily:'Courier New'}}>{new Date(a.ts).toLocaleDateString()}</div></div>
                      </div>
                    ))
                  ) : <div style={{fontSize:12,color:T.mid,textAlign:'center',padding:'16px 0',border:`1px dashed ${T.border}`,borderRadius:6}}>No activity recorded yet.</div>}
                </div>
              </div>
              <div style={{padding:'14px 24px',borderTop:`1px solid ${T.border}`,display:'flex',gap:8,justifyContent:'flex-end',flexShrink:0}}>
                <button onClick={()=>setProfileInv(null)} style={{padding:'8px 16px',border:`1px solid ${T.border}`,background:T.white,borderRadius:7,fontSize:13,cursor:'pointer',fontFamily:'inherit'}}>Close</button>
                <button onClick={()=>{setOutInvId(inv.id);setTab('outreach');setProfileInv(null)}} style={{padding:'8px 16px',background:T.white,border:`1px solid ${T.border}`,borderRadius:7,fontSize:13,cursor:'pointer',fontFamily:'inherit'}}>✉️ Generate Outreach</button>
                {!pipeItem && <button onClick={()=>{addToPipeline(inv);setProfileInv(null)}} style={{padding:'8px 18px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>+ Add to Pipeline</button>}
                {pipeItem && <button onClick={()=>addWarmIntro(pipeItem.id)} style={{padding:'8px 16px',background:T.white,border:`1px solid ${T.border}`,borderRadius:7,fontSize:13,cursor:'pointer',fontFamily:'inherit',color:T.teal}}>🤝 Add Warm Intro</button>}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ══════════ ADD CUSTOM INVESTOR MODAL ══════════ */}
      {showAddModal && (
        <div onClick={()=>setShowAddModal(false)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.white,borderRadius:13,width:'100%',maxWidth:520,padding:24}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <div style={{fontSize:16,fontWeight:700,color:T.navy}}>Add Custom Investor</div>
              <button onClick={()=>setShowAddModal(false)} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:T.mid}}>×</button>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div style={{gridColumn:'1/-1'}}><label style={flabel}>Investor / Fund Name *</label><input value={customForm.name} onChange={e=>setCustomForm(x=>({...x,name:e.target.value}))} placeholder="e.g. Accel Partners" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              <div><label style={flabel}>Type</label>
                <select value={customForm.type} onChange={e=>setCustomForm(x=>({...x,type:e.target.value}))} style={{...inp,width:'100%',boxSizing:'border-box'}}>
                  <option value="vc">VC Fund</option><option value="angel">Angel</option>
                  <option value="accelerator">Accelerator</option><option value="family">Family Office</option><option value="cvc">Corporate VC</option>
                </select>
              </div>
              <div><label style={flabel}>Check Size</label><input value={customForm.checkLabel} onChange={e=>setCustomForm(x=>({...x,checkLabel:e.target.value}))} placeholder="e.g. $500K–$2M" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              <div><label style={flabel}>Focus Geography</label><input value={customForm.geo} onChange={e=>setCustomForm(x=>({...x,geo:e.target.value}))} placeholder="e.g. India, Global" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              <div><label style={flabel}>Website</label><input value={customForm.website} onChange={e=>setCustomForm(x=>({...x,website:e.target.value}))} placeholder="https://…" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              <div style={{gridColumn:'1/-1'}}><label style={flabel}>Investment Thesis</label><textarea value={customForm.thesis} onChange={e=>setCustomForm(x=>({...x,thesis:e.target.value}))} rows={2} placeholder="What do they look for?" style={{...inp,width:'100%',boxSizing:'border-box',resize:'vertical'}}/></div>
              <div style={{gridColumn:'1/-1'}}><label style={flabel}>Add to Pipeline Stage</label>
                <select value={customForm.stage} onChange={e=>setCustomForm(x=>({...x,stage:e.target.value}))} style={{...inp,width:'100%',boxSizing:'border-box'}}>
                  <option value="research">Research</option><option value="target">Target</option>
                  <option value="outreach">Outreach Sent</option><option value="intro">Warm Intro</option>
                </select>
              </div>
            </div>
            <div style={{display:'flex',gap:8,marginTop:16,justifyContent:'flex-end'}}>
              <button onClick={()=>setShowAddModal(false)} style={{padding:'8px 16px',border:`1px solid ${T.border}`,background:T.white,borderRadius:7,fontSize:13,cursor:'pointer',fontFamily:'inherit'}}>Cancel</button>
              <button onClick={saveCustomInvestor} style={{padding:'8px 18px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Save &amp; Add</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════ NEW ROUND MODAL ══════════ */}
      {showRoundModal && (
        <div onClick={()=>setShowRoundModal(false)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.white,borderRadius:13,width:'100%',maxWidth:480,padding:24}}>
            <div style={{fontSize:16,fontWeight:700,color:T.navy,marginBottom:16}}>Create Fundraising Round</div>
            <div style={{display:'grid',gap:10}}>
              <div><label style={flabel}>Round Name *</label><input value={roundForm.name} onChange={e=>setRoundForm(x=>({...x,name:e.target.value}))} placeholder="e.g. Seed Round 2026" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={flabel}>Round Type</label>
                  <select value={roundForm.type} onChange={e=>setRoundForm(x=>({...x,type:e.target.value}))} style={{...inp,width:'100%',boxSizing:'border-box'}}>
                    <option value="pre-seed">Pre-Seed</option><option value="seed">Seed</option><option value="series-a">Series A</option>
                    <option value="bridge">Bridge</option><option value="safe">SAFE</option>
                  </select>
                </div>
                <div><label style={flabel}>Instrument</label>
                  <select value={roundForm.instrument} onChange={e=>setRoundForm(x=>({...x,instrument:e.target.value}))} style={{...inp,width:'100%',boxSizing:'border-box'}}>
                    <option value="equity">Equity</option><option value="safe">SAFE</option><option value="convertible">Convertible Note</option>
                  </select>
                </div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><label style={flabel}>Target Amount *</label><input value={roundForm.target} onChange={e=>setRoundForm(x=>({...x,target:e.target.value}))} placeholder="e.g. $500,000" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
                <div><label style={flabel}>Pre-money Valuation</label><input value={roundForm.valuation} onChange={e=>setRoundForm(x=>({...x,valuation:e.target.value}))} placeholder="e.g. $3,000,000" style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
              </div>
              <div><label style={flabel}>Target Close Date</label><input type="date" value={roundForm.close} onChange={e=>setRoundForm(x=>({...x,close:e.target.value}))} style={{...inp,width:'100%',boxSizing:'border-box'}}/></div>
            </div>
            <div style={{display:'flex',gap:8,marginTop:16,justifyContent:'flex-end'}}>
              <button onClick={()=>setShowRoundModal(false)} style={{padding:'8px 16px',border:`1px solid ${T.border}`,background:T.white,borderRadius:7,fontSize:13,cursor:'pointer',fontFamily:'inherit'}}>Cancel</button>
              <button onClick={createRound} style={{padding:'8px 18px',background:T.orange,color:'#fff',border:'none',borderRadius:7,fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>Create Round</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
