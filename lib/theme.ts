// Ported verbatim from launchpad_v5's frontend/src/lib/theme.ts — only the pieces
// the Investor OS page actually uses.
export const T = {
  navy:   '#0D2137',
  navy2:  '#1B4F72',
  orange: '#C94F1C',
  orange2:'#E8602A',
  teal:   '#0E7E72',
  green:  '#22C55E',
  yellow: '#F59E0B',
  red:    '#EF4444',
  purple: '#8B5CF6',
  mid:    '#6B6560',
  paper:  '#F7F6F2',
  white:  '#FFFFFF',
  border: '#DDD9D0',
  ink:    '#2A2520',
} as const

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
