import request from 'supertest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalFetch = global.fetch

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
  delete process.env.LOOPX_BIN
  delete process.env.LOOPX_GOAL_ID
  delete process.env.LOOPX_REGISTRY
  delete process.env.LOOPX_PROJECT
  delete process.env.LOOPX_AGENT_ID
  global.fetch = originalFetch
  const mod = await import('./index.js')
  await request(mod.app).get('/api/cards')
})

const fakeLoopx = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'openclaw-loopx-test-'))
  const executable = path.join(directory, 'loopx')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('list')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    goal_id: 'goal-fixture',
    todos: [
      { todo_id: 'todo_ready', text: '[P1] Build adapter', title: 'Build adapter', status: 'open', role: 'agent', task_class: 'advancement_task', priority: 'P1', updated_at: '2026-08-06T12:00:00Z' },
      { todo_id: 'todo_gate', text: 'Approve release', status: 'open', role: 'user', task_class: 'user_gate', updated_at: '2026-08-06T12:01:00Z' }
    ]
  }))
} else {
  process.stdout.write(JSON.stringify({ ok: true, dry_run: args.includes('--dry-run'), args }))
}
`,
  )
  chmodSync(executable, 0o755)
  return { executable, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

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
    expect(payload.lane).toBe('TRIAGE')
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

  it('persists LoopX task fields with stable defaults', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const createRes = await request(mod.app).post('/api/cards').send({
      title: 'Durable task',
      priority: 'P1',
      source: 'openclaw',
      externalId: 'run-42',
      acceptanceCriteria: 'All checks pass',
      nextAction: 'Run integration suite',
      continuation: 'Resume after approval',
      evidence: 'test://baseline',
      dueAt: '2026-08-07T12:00:00.000Z',
    })

    expect(createRes.status).toBe(201)
    expect(createRes.body.card).toMatchObject({
      priority: 'P1',
      source: 'openclaw',
      externalId: 'run-42',
      acceptanceCriteria: 'All checks pass',
      nextAction: 'Run integration suite',
      continuation: 'Resume after approval',
      evidence: 'test://baseline',
      revision: 1,
    })
    expect(createRes.body.card.taskKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('rejects invalid lifecycle jumps and records valid transitions', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const createRes = await request(mod.app).post('/api/cards').send({ title: 'Lifecycle task' })
    const id = createRes.body.card.id as number

    const invalid = await request(mod.app).patch(`/api/cards/${id}`).send({ lane: 'RUNNING' })
    expect(invalid.status).toBe(409)
    expect(invalid.body.allowedTransitions).toEqual(['TODO'])

    for (const lane of ['TODO', 'READY', 'RUNNING', 'DONE']) {
      const move = await request(mod.app).patch(`/api/cards/${id}`).send({ lane })
      expect(move.status).toBe(200)
    }

    const cardsRes = await request(mod.app).get('/api/cards')
    const card = cardsRes.body.cards.find((candidate: { id: number }) => candidate.id === id)
    expect(card.lane).toBe('DONE')
    expect(card.startedAt).toBeTypeOf('string')
    expect(card.completedAt).toBeTypeOf('string')
    expect(card.revision).toBe(5)
  })

  it('replays duplicate create events without duplicating cards or hooks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = 'https://example.test/hook'
    const mod = await import('./index.js')
    const payload = { title: 'Exactly once', eventId: 'evt-create-1' }

    const first = await request(mod.app).post('/api/cards').send(payload)
    const replay = await request(mod.app).post('/api/cards').send(payload)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.card.id).toBe(first.body.card.id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('applies an update event once and guards stale revisions', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const createRes = await request(mod.app)
      .post('/api/cards')
      .send({ title: 'Revision task', eventId: 'evt-revision-create' })
    const id = createRes.body.card.id as number

    const first = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ title: 'Updated once', expectedRevision: 1, eventId: 'evt-update-1' })
    const replay = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ title: 'Ignored duplicate payload', expectedRevision: 1, eventId: 'evt-update-1' })
    const stale = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ title: 'Stale update', expectedRevision: 1, eventId: 'evt-update-2' })
    const events = await request(mod.app).get(`/api/cards/${id}/events`)

    expect(first.body.card.revision).toBe(2)
    expect(replay.body.card.title).toBe('Updated once')
    expect(replay.body.card.revision).toBe(2)
    expect(stale.status).toBe(409)
    expect(events.body.events).toHaveLength(2)
    expect(events.body.events.map((event: { eventId: string }) => event.eventId)).toEqual([
      'evt-revision-create',
      'evt-update-1',
    ])
  })

  it('previews and applies non-destructive LoopX reconciliation', async () => {
    const fixture = fakeLoopx()
    process.env.LOOPX_BIN = fixture.executable
    process.env.LOOPX_GOAL_ID = 'goal-fixture'
    const mod = await import('./index.js')

    try {
      const preview = await request(mod.app).post('/api/loopx/reconcile').send({})
      expect(preview.status).toBe(200)
      expect(preview.body).toMatchObject({
        dryRun: true,
        summary: { source: 2, created: 2, updated: 0, unchanged: 0 },
      })
      expect((await request(mod.app).get('/api/cards')).body.cards).toHaveLength(0)

      const applied = await request(mod.app).post('/api/loopx/reconcile').send({ execute: true })
      expect(applied.status).toBe(200)
      expect(applied.body.dryRun).toBe(false)

      const cards = (await request(mod.app).get('/api/cards')).body.cards as Array<Record<string, unknown>>
      expect(cards).toHaveLength(2)
      expect(cards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'loopx', externalId: 'goal-fixture:todo_ready', lane: 'READY' }),
          expect.objectContaining({ source: 'loopx', externalId: 'goal-fixture:todo_gate', lane: 'BLOCKED' }),
        ]),
      )

      const replay = await request(mod.app).post('/api/loopx/reconcile').send({ execute: true })
      expect(replay.body.summary).toMatchObject({ created: 0, updated: 0, unchanged: 2 })
    } finally {
      fixture.cleanup()
    }
  })

  it('keeps LoopX projections read-only and dry-runs explicit writeback', async () => {
    const fixture = fakeLoopx()
    process.env.LOOPX_BIN = fixture.executable
    process.env.LOOPX_GOAL_ID = 'goal-fixture'
    process.env.LOOPX_AGENT_ID = 'codex-main'
    const mod = await import('./index.js')

    try {
      await request(mod.app).post('/api/loopx/reconcile').send({ execute: true })
      const cards = (await request(mod.app).get('/api/cards')).body.cards as Array<{ id: number; externalId: string }>
      const ready = cards.find((card) => card.externalId.endsWith('todo_ready'))!

      const ordinaryEdit = await request(mod.app).patch(`/api/cards/${ready.id}`).send({ title: 'Invented state' })
      expect(ordinaryEdit.status).toBe(409)

      const claim = await request(mod.app)
        .post(`/api/loopx/cards/${ready.id}/actions`)
        .send({ action: 'claim', claimedBy: 'codex-main' })
      expect(claim.status).toBe(200)
      expect(claim.body.dryRun).toBe(true)
      expect(claim.body.loopx.args).toEqual(
        expect.arrayContaining(['claim', '--todo-id', 'todo_ready', '--claimed-by', 'codex-main', '--dry-run']),
      )
    } finally {
      fixture.cleanup()
    }
  })
})
