import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6'

export async function callClaude(system: string, prompt: string, maxTokens = 1200): Promise<string> {
  const msg = await client.messages.create({
    model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }],
  })
  return (msg.content[0] as any).text || ''
}
