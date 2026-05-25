import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalFetch = global.fetch

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
  global.fetch = originalFetch
  const mod = await import('./index.js')
  await request(mod.app).get('/api/cards')
})

describe('workflow hooks', () => {
  it('emits card.created webhook when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = 'https://example.test/hook'

    const mod = await import('./index.js')

    const createRes = await request(mod.app)
      .post('/api/cards')
      .send({ title: 'Test webhook card' })

    expect(createRes.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/hook')

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      event: string
      cardId: number
      lane: string
    }

    expect(payload.event).toBe('card.created')
    expect(payload.cardId).toBeTypeOf('number')
    expect(payload.lane).toBe('Backlog')
  })
})
