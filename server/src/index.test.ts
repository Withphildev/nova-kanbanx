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
  it('reports db integrity on health endpoint', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const healthRes = await request(mod.app).get('/api/health')
    expect(healthRes.status).toBe(200)
    expect(healthRes.body.ok).toBe(true)
    expect(healthRes.body.dbIntegrity.ok).toBe(true)
  })

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

  it('deletes card successfully', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const createRes = await request(mod.app).post('/api/cards').send({ title: 'Delete me' })
    expect(createRes.status).toBe(201)
    const id = createRes.body.card.id as number

    const deleteRes = await request(mod.app).delete(`/api/cards/${id}`)
    expect(deleteRes.status).toBe(204)

    const cardsRes = await request(mod.app).get('/api/cards')
    expect(cardsRes.status).toBe(200)
    expect((cardsRes.body.cards as Array<{ id: number }>).some((c) => c.id === id)).toBe(false)
  })
})
