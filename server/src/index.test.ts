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
  delete process.env.KANBAN_REMINDER_HOOK_URL
  delete process.env.KANBAN_REMINDER_POLL_MS
  delete process.env.KANBAN_REMINDER_TIMEOUT_MS
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
    expect(healthRes.body.reminders).toMatchObject({ configured: false, pollMs: 60000 })
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
    const checklist = await request(mod.app).post(`/api/cards/${id}/checklist`).send({
      text: 'Temporary child step',
      expectedRevision: 1,
      eventId: 'evt-delete-checklist',
    })
    expect(checklist.status).toBe(201)

    const deleteRes = await request(mod.app).delete(`/api/cards/${id}`)
    expect(deleteRes.status).toBe(204)

    const cardsRes = await request(mod.app).get('/api/cards')
    expect(cardsRes.status).toBe(200)
    expect((cardsRes.body.cards as Array<{ id: number }>).some((c) => c.id === id)).toBe(false)

    const deletedChecklist = await request(mod.app)
      .patch(`/api/checklist-items/${checklist.body.item.id}`)
      .send({ isDone: true, expectedRevision: 1 })
    expect(deletedChecklist.status).toBe(404)

    const events = await request(mod.app).get(`/api/cards/${id}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.created',
      'checklist.created',
      'card.deleted',
    ])

    const activity = await request(mod.app).get('/api/activity')
    expect(activity.body.activity).toContainEqual(
      expect.objectContaining({ card_id: null, action: 'card.deleted', detail: `card:${id}` }),
    )
    expect(
      activity.body.activity.some((entry: { card_id: number | null }) => entry.card_id === id),
    ).toBe(false)
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

  it('separates flexible due dates from exact delivery instants', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const calendarDue = await request(mod.app).post('/api/cards').send({
      title: 'Calendar planning date',
      dueAt: '2026-09-15',
      eventId: 'evt-date-semantics-calendar',
    })
    const exactDue = await request(mod.app).post('/api/cards').send({
      title: 'Exact planning instant',
      dueAt: '2026-09-15T09:00:00-07:00',
      eventId: 'evt-date-semantics-exact',
    })
    const ambiguousDue = await request(mod.app).post('/api/cards').send({
      title: 'Ambiguous planning time',
      dueAt: '2026-09-15T09:00:00',
      eventId: 'evt-date-semantics-ambiguous',
    })
    const impossibleDue = await request(mod.app).post('/api/cards').send({
      title: 'Impossible calendar date',
      dueAt: '2026-02-30',
      eventId: 'evt-date-semantics-impossible',
    })

    expect(calendarDue.status).toBe(201)
    expect(calendarDue.body.card.dueAt).toBe('2026-09-15')
    expect(exactDue.status).toBe(201)
    expect(ambiguousDue.status).toBe(400)
    expect(ambiguousDue.body.error).toContain('YYYY-MM-DD or an ISO instant with an offset')
    expect(impossibleDue.status).toBe(400)
  })

  it('rejects invalid lifecycle jumps and records valid transitions', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const createRes = await request(mod.app).post('/api/cards').send({ title: 'Lifecycle task' })
    const id = createRes.body.card.id as number

    const invalid = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ lane: 'RUNNING', expectedRevision: 1 })
    expect(invalid.status).toBe(409)
    expect(invalid.body.allowedTransitions).toEqual(['TODO'])

    let revision = 1
    for (const lane of ['TODO', 'READY', 'RUNNING', 'DONE']) {
      const move = await request(mod.app)
        .patch(`/api/cards/${id}`)
        .send({ lane, expectedRevision: revision })
      expect(move.status).toBe(200)
      revision = move.body.card.revision
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

  it('requires expectedRevision on every local update path', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const created = await request(mod.app).post('/api/cards').send({
      title: 'Revision required everywhere',
      eventId: 'evt-required-revision-create',
    })
    const id = created.body.card.id as number
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const missingPatch = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ title: 'Must not update', eventId: 'evt-required-revision-patch' })
    const missingSnooze = await request(mod.app)
      .post(`/api/cards/${id}/snooze`)
      .send({
        until,
        timezone: 'America/Los_Angeles',
        eventId: 'evt-required-revision-snooze',
      })
    const missingChecklistCreate = await request(mod.app)
      .post(`/api/cards/${id}/checklist`)
      .send({ text: 'Must not create', eventId: 'evt-required-revision-checklist-create' })

    for (const response of [missingPatch, missingSnooze, missingChecklistCreate]) {
      expect(response.status).toBe(400)
      expect(response.body.error).toContain('expectedRevision is required')
    }

    const checklist = await request(mod.app).post(`/api/cards/${id}/checklist`).send({
      text: 'Created with a revision',
      expectedRevision: 1,
      eventId: 'evt-required-revision-checklist-valid',
    })
    expect(checklist.status).toBe(201)

    const missingChecklistUpdate = await request(mod.app)
      .patch(`/api/checklist-items/${checklist.body.item.id}`)
      .send({ isDone: true, eventId: 'evt-required-revision-checklist-update' })
    expect(missingChecklistUpdate.status).toBe(400)
    expect(missingChecklistUpdate.body.error).toContain('expectedRevision is required')

    const stalePatch = await request(mod.app)
      .patch(`/api/cards/${id}`)
      .send({ title: 'Stale', expectedRevision: 1, eventId: 'evt-required-revision-stale' })
    expect(stalePatch.status).toBe(409)
    expect(stalePatch.body).toMatchObject({ error: 'revision conflict', currentRevision: 2 })

    const events = await request(mod.app).get(`/api/cards/${id}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.created',
      'checklist.created',
    ])
  })

  it('captures a confirmed reminder once and supports acknowledgement', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const ambiguous = await request(mod.app).post('/api/capture').send({
      text: 'Pay the car payment',
      remindAt: 'next Friday',
      reminderTimezone: 'America/Los_Angeles',
      eventId: 'evt-capture-ambiguous',
    })
    expect(ambiguous.status).toBe(400)
    expect(ambiguous.body.error).toContain('ISO instant')

    const payload = {
      text: 'Pay the car payment\nUse the lender portal.',
      remindAt: '2026-08-08T09:00:00-07:00',
      reminderTimezone: 'America/Los_Angeles',
      eventId: 'evt-capture-payment',
    }
    const capture = await request(mod.app).post('/api/capture').send(payload)
    const replay = await request(mod.app).post('/api/capture').send(payload)
    expect(capture.status).toBe(201)
    expect(capture.body.card).toMatchObject({
      title: 'Pay the car payment',
      capturedText: payload.text,
      lane: 'TRIAGE',
      itemType: 'TASK',
      source: 'nova',
      remindAt: '2026-08-08T09:00:00-07:00',
      reminderTimezone: 'America/Los_Angeles',
      reminderStatus: 'PENDING',
      revision: 1,
    })
    expect(replay.status).toBe(201)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.card.id).toBe(capture.body.card.id)

    const acknowledge = await request(mod.app).post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`).send({
      expectedRevision: 1,
      eventId: 'evt-capture-payment-ack',
    })
    expect(acknowledge.status).toBe(200)
    expect(acknowledge.body.card).toMatchObject({ reminderStatus: 'ACKNOWLEDGED', revision: 2 })
    expect(acknowledge.body.card.reminderAcknowledgedAt).toBeTypeOf('string')

    const events = await request(mod.app).get(`/api/cards/${capture.body.card.id}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.captured',
      'reminder.acknowledged',
    ])
  })

  it('advances recurring reminders idempotently without month-end or DST drift', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const capture = await request(mod.app).post('/api/capture').send({
      text: 'Pay the car payment',
      remindAt: '2027-01-31T09:00:00-08:00',
      reminderTimezone: 'America/Los_Angeles',
      recurrenceFrequency: 'MONTHLY',
      recurrenceInterval: 1,
      eventId: 'evt-recurring-payment',
    })

    expect(capture.status).toBe(201)
    expect(capture.body.card).toMatchObject({
      recurrenceFrequency: 'MONTHLY',
      recurrenceInterval: 1,
      recurrenceOccurrences: 0,
      recurrenceAnchorMonth: 1,
      recurrenceAnchorDay: 31,
    })

    const first = await request(mod.app)
      .post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`)
      .send({ expectedRevision: 1, eventId: 'evt-recurring-payment-ack-1' })
    const replay = await request(mod.app)
      .post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`)
      .send({ expectedRevision: 1, eventId: 'evt-recurring-payment-ack-1' })
    const second = await request(mod.app)
      .post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`)
      .send({ expectedRevision: 2, eventId: 'evt-recurring-payment-ack-2' })

    expect(first.body.card).toMatchObject({
      remindAt: '2027-02-28T17:00:00.000Z',
      reminderStatus: 'PENDING',
      recurrenceOccurrences: 1,
      revision: 2,
    })
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.card.recurrenceOccurrences).toBe(1)
    expect(second.body.card).toMatchObject({
      remindAt: '2027-03-31T16:00:00.000Z',
      reminderStatus: 'PENDING',
      recurrenceOccurrences: 2,
      revision: 3,
    })
  })

  it('ends a recurring reminder after its final allowed occurrence', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const capture = await request(mod.app).post('/api/capture').send({
      text: 'Monthly paperwork',
      remindAt: '2027-01-31T09:00:00-08:00',
      reminderTimezone: 'America/Los_Angeles',
      recurrenceFrequency: 'MONTHLY',
      recurrenceEndAt: '2027-02-28T23:59:00-08:00',
      eventId: 'evt-recurring-ended',
    })
    const first = await request(mod.app)
      .post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`)
      .send({ expectedRevision: 1, eventId: 'evt-recurring-ended-ack-1' })
    const second = await request(mod.app)
      .post(`/api/cards/${capture.body.card.id}/reminders/acknowledge`)
      .send({ expectedRevision: 2, eventId: 'evt-recurring-ended-ack-2' })

    expect(first.body.card.reminderStatus).toBe('PENDING')
    expect(second.body).toMatchObject({ seriesComplete: true, nextRemindAt: null })
    expect(second.body.card).toMatchObject({
      remindAt: '2027-02-28T17:00:00.000Z',
      reminderStatus: 'ACKNOWLEDGED',
      recurrenceOccurrences: 2,
    })
  })

  it('groups notebook work into timezone-aware agenda sections', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const capture = (text: string, remindAt: string, eventId: string) =>
      request(mod.app).post('/api/capture').send({
        text,
        remindAt,
        reminderTimezone: 'America/Los_Angeles',
        eventId,
      })

    await request(mod.app)
      .post('/api/capture')
      .send({ text: 'Clarify this thought later', eventId: 'evt-agenda-inbox' })
    await capture('Old reminder without guilt', '2026-08-06T18:00:00-07:00', 'evt-agenda-overdue')
    await capture('Pay car payment', '2026-08-07T18:00:00-07:00', 'evt-agenda-today')
    await capture('Plan the weekend', '2026-08-08T09:00:00-07:00', 'evt-agenda-upcoming')
    await request(mod.app).post('/api/cards').send({
      title: 'Waiting for a callback',
      lane: 'BLOCKED',
      eventId: 'evt-agenda-waiting',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'A small win',
      lane: 'DONE',
      eventId: 'evt-agenda-done',
    })

    const agenda = await request(mod.app).get('/api/agenda').query({
      timezone: 'America/Los_Angeles',
      at: '2026-08-07T12:00:00-07:00',
    })
    expect(agenda.status).toBe(200)
    expect(agenda.body.counts).toMatchObject({
      inbox: 1,
      overdue: 1,
      today: 1,
      upcoming: 1,
      waiting: 1,
      done: 1,
    })
    expect(agenda.body.sections.inbox[0].title).toBe('Clarify this thought later')
    expect(agenda.body.sections.overdue[0].title).toBe('Old reminder without guilt')
    expect(agenda.body.sections.today[0].title).toBe('Pay car payment')
    expect(agenda.body.sections.upcoming[0].title).toBe('Plan the weekend')

    const badTimezone = await request(mod.app).get('/api/agenda').query({ timezone: 'Mars/Olympus' })
    expect(badTimezone.status).toBe(400)
  })

  it('retries reminder delivery with a stable id and durable receipt', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    process.env.KANBAN_REMINDER_HOOK_URL = 'https://example.test/reminders'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 202 })
    global.fetch = fetchMock as unknown as typeof fetch
    const mod = await import('./index.js')

    const capture = await request(mod.app).post('/api/capture').send({
      text: 'Pay the car payment',
      remindAt: '2020-08-08T09:00:00-07:00',
      reminderTimezone: 'America/Los_Angeles',
      eventId: 'evt-delivery-payment',
    })
    const cardId = capture.body.card.id as number
    const at = '2026-08-08T16:01:00Z'

    const preview = await request(mod.app).post('/api/reminders/poll').send({ at })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ dryRun: true, summary: { due: 1, delivered: 0, failed: 0 } })
    expect(fetchMock).not.toHaveBeenCalled()

    const failed = await request(mod.app).post('/api/reminders/poll').send({ at, execute: true })
    expect(failed.status).toBe(200)
    expect(failed.body.summary).toEqual({ due: 1, delivered: 0, failed: 1 })
    const deliveryId = failed.body.deliveries[0].deliveryId as string
    expect(deliveryId).toMatch(/^kanban-reminder-[a-f0-9]{32}$/)

    let status = await request(mod.app).get('/api/reminders/status')
    expect(status.body.counts).toMatchObject({ pending: 1, due: 1 })
    expect(status.body.latestReceipts[0]).toMatchObject({
      deliveryId,
      cardId,
      status: 'FAILED',
      attemptCount: 1,
      responseStatus: 503,
    })

    const delivered = await request(mod.app).post('/api/reminders/poll').send({ at, execute: true })
    expect(delivered.body.summary).toEqual({ due: 1, delivered: 1, failed: 0 })
    expect(delivered.body.deliveries[0]).toMatchObject({ deliveryId, attemptCount: 2, responseStatus: 202 })

    const fetchPayloads = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as { deliveryId: string },
    )
    expect(fetchPayloads.map((payload) => payload.deliveryId)).toEqual([deliveryId, deliveryId])
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': deliveryId })

    const cards = await request(mod.app).get('/api/cards')
    expect(cards.body.cards.find((card: { id: number }) => card.id === cardId)).toMatchObject({
      reminderStatus: 'DELIVERED',
      revision: 2,
    })
    const agenda = await request(mod.app).get('/api/agenda').query({ timezone: 'UTC', at })
    expect(agenda.body.sections.overdue).toEqual([
      expect.objectContaining({ id: cardId, reminderStatus: 'DELIVERED' }),
    ])
    const events = await request(mod.app).get(`/api/cards/${cardId}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.captured',
      'reminder.delivered',
    ])

    const noReplay = await request(mod.app).post('/api/reminders/poll').send({ at, execute: true })
    expect(noReplay.body.summary).toEqual({ due: 0, delivered: 0, failed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    status = await request(mod.app).get('/api/reminders/status')
    expect(status.body.latestReceipts[0]).toMatchObject({
      deliveryId,
      status: 'DELIVERED',
      attemptCount: 2,
    })
  })

  it('keeps reminder execution inactive until a delivery hook is configured', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    await request(mod.app).post('/api/capture').send({
      text: 'Unconfigured reminder',
      remindAt: '2026-08-08T16:00:00Z',
      reminderTimezone: 'UTC',
      eventId: 'evt-delivery-inactive',
    })

    const preview = await request(mod.app)
      .post('/api/reminders/poll')
      .send({ at: '2026-08-08T16:01:00Z' })
    expect(preview.body.summary.due).toBe(1)
    const execute = await request(mod.app)
      .post('/api/reminders/poll')
      .send({ at: '2026-08-08T16:01:00Z', execute: true })
    expect(execute.status).toBe(409)
    expect(execute.body.error).toContain('not configured')
  })

  it('offers one explained daily focus and a wins-first weekly reset', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const now = new Date()
    const overdue = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const at = new Date(now.getTime() + 1_000).toISOString()

    const focus = await request(mod.app).post('/api/cards').send({
      title: 'File the urgent form',
      lane: 'READY',
      priority: 'P1',
      nextAction: 'Open the form and fill the first section',
      estimateMinutes: 20,
      energyDemand: 'LOW',
      dueAt: overdue,
      eventId: 'evt-review-focus',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'Ten-minute quick win',
      lane: 'TODO',
      priority: 'P2',
      estimateMinutes: 10,
      energyDemand: 'LOW',
      eventId: 'evt-review-quick-win',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'Large high-energy project task',
      lane: 'READY',
      priority: 'P0',
      estimateMinutes: 120,
      energyDemand: 'HIGH',
      eventId: 'evt-review-too-large',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'Waiting for a response',
      lane: 'BLOCKED',
      priority: 'P0',
      eventId: 'evt-review-blocked',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'Unclear inbox thought',
      eventId: 'evt-review-clarify',
    })
    await request(mod.app).post('/api/cards').send({
      title: 'Finished small thing',
      lane: 'DONE',
      eventId: 'evt-review-win',
    })

    const daily = await request(mod.app).get('/api/review/daily').query({
      timezone: 'UTC',
      at,
      availableMinutes: 30,
      energy: 'LOW',
    })
    expect(daily.status).toBe(200)
    expect(daily.body.message).toBe('One reachable next action is enough.')
    expect(daily.body.focus).toMatchObject({
      card: { id: focus.body.card.id, energyDemand: 'LOW', estimateMinutes: 20 },
      action: 'Open the form and fill the first section',
    })
    expect(daily.body.focus.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('information, not a failure'),
        expect.stringContaining('fits the time available'),
        expect.stringContaining('energy demand matches'),
      ]),
    )
    expect(daily.body.quickWins).toEqual([
      expect.objectContaining({ title: 'Ten-minute quick win' }),
    ])
    expect(daily.body.counts).toMatchObject({ overdue: 1, waiting: 1, needsClarity: 1 })

    const weekly = await request(mod.app).get('/api/review/weekly').query({ timezone: 'UTC', at })
    expect(weekly.status).toBe(200)
    expect(weekly.body.message).toContain('1 win this week')
    expect(weekly.body.sections.wins).toEqual([
      expect.objectContaining({ title: 'Finished small thing' }),
    ])
    expect(weekly.body.counts).toMatchObject({ wins: 1, waiting: 1 })

    const badEnergy = await request(mod.app)
      .get('/api/review/daily')
      .query({ timezone: 'UTC', energy: 'MAXIMUM' })
    expect(badEnergy.status).toBe(400)
  })

  it('snoozes a task idempotently without erasing its original due date', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const dueAt = '2026-08-01T17:00:00Z'
    const created = await request(mod.app).post('/api/cards').send({
      title: 'Replan without guilt',
      dueAt,
      energyDemand: 'MEDIUM',
      eventId: 'evt-snooze-create',
    })
    const until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const payload = {
      until,
      timezone: 'America/Los_Angeles',
      expectedRevision: 1,
      eventId: 'evt-snooze-once',
    }
    const snoozed = await request(mod.app)
      .post(`/api/cards/${created.body.card.id}/snooze`)
      .send(payload)
    const replay = await request(mod.app)
      .post(`/api/cards/${created.body.card.id}/snooze`)
      .send(payload)

    expect(snoozed.status).toBe(200)
    expect(snoozed.body.card).toMatchObject({
      dueAt,
      remindAt: until,
      reminderTimezone: 'America/Los_Angeles',
      reminderStatus: 'PENDING',
      energyDemand: 'MEDIUM',
      revision: 2,
    })
    expect(snoozed.body.card.reviewedAt).toBeTypeOf('string')
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.card.revision).toBe(2)
    const events = await request(mod.app).get(`/api/cards/${created.body.card.id}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.created',
      'reminder.snoozed',
    ])
  })

  it('promotes a captured thought without losing identity and safely applies a decomposition', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const captured = await request(mod.app).post('/api/capture').send({
      text: 'Create a calmer household paperwork system',
      nextAction: 'List the recurring paperwork',
      eventId: 'evt-promote-capture',
    })
    const original = captured.body.card as {
      id: number
      taskKey: string
      capturedText: string
      revision: number
    }
    const promotePayload = {
      goal: 'Make household paperwork easy to find and finish',
      expectedRevision: 1,
      eventId: 'evt-promote-project',
    }
    const promoted = await request(mod.app)
      .post(`/api/cards/${original.id}/promote`)
      .send(promotePayload)
    const promoteReplay = await request(mod.app)
      .post(`/api/cards/${original.id}/promote`)
      .send(promotePayload)

    expect(promoted.status).toBe(200)
    expect(promoted.body.card).toMatchObject({
      id: original.id,
      taskKey: original.taskKey,
      capturedText: original.capturedText,
      itemType: 'PROJECT',
      goal: promotePayload.goal,
      revision: 2,
    })
    expect(promoteReplay.headers['idempotent-replay']).toBe('true')

    const plan = {
      eventId: 'evt-decompose-project',
      expectedRevision: 2,
      milestones: [
        {
          title: 'Capture the paperwork',
          goal: 'Know what repeats',
          tasks: [
            {
              title: 'List monthly bills',
              nextAction: 'Write down the first three bills',
              acceptanceCriteria: 'Every recurring bill is listed',
              estimateMinutes: 10,
              energyDemand: 'LOW',
              priority: 'P1',
            },
          ],
        },
        {
          title: 'Build the routine',
          tasks: [{ title: 'Choose a weekly review time', estimateMinutes: 5 }],
        },
      ],
    }
    const preview = await request(mod.app)
      .post(`/api/cards/${original.id}/decompose`)
      .send(plan)
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({
      dryRun: true,
      summary: { milestones: 2, tasks: 2 },
    })
    expect((await request(mod.app).get(`/api/cards/${original.id}/structure`)).body.structure.children).toHaveLength(0)

    const applyPayload = { ...plan, execute: true }
    const applied = await request(mod.app)
      .post(`/api/cards/${original.id}/decompose`)
      .send(applyPayload)
    const replay = await request(mod.app)
      .post(`/api/cards/${original.id}/decompose`)
      .send(applyPayload)

    expect(applied.status).toBe(200)
    expect(applied.body).toMatchObject({
      dryRun: false,
      summary: { milestones: 2, tasks: 2 },
      project: { id: original.id, taskKey: original.taskKey, revision: 3 },
    })
    expect(applied.body.structure.children).toHaveLength(2)
    expect(applied.body.structure.children[0]).toMatchObject({
      title: 'Capture the paperwork',
      itemType: 'MILESTONE',
      children: [
        expect.objectContaining({
          title: 'List monthly bills',
          itemType: 'TASK',
          parentId: expect.any(Number),
          nextAction: 'Write down the first three bills',
          estimateMinutes: 10,
          energyDemand: 'LOW',
          priority: 'P1',
        }),
      ],
    })
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.structure.children).toHaveLength(2)

    const events = await request(mod.app).get(`/api/cards/${original.id}/events`)
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'card.captured',
      'card.promoted',
      'card.decomposed',
    ])
    const secondPlan = await request(mod.app)
      .post(`/api/cards/${original.id}/decompose`)
      .send({ ...plan, eventId: 'evt-decompose-again' })
    expect(secondPlan.status).toBe(409)
    expect(secondPlan.body.error).toContain('already has child work')
  })

  it('builds a project into milestones and tasks with validated hierarchy', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')

    const project = await request(mod.app).post('/api/cards').send({
      title: 'Assistant notebook',
      itemType: 'PROJECT',
      goal: 'Never lose the next useful action',
      eventId: 'evt-hierarchy-project',
    })
    expect(project.status).toBe(201)
    expect(project.body.card).toMatchObject({
      itemType: 'PROJECT',
      parentId: null,
      goal: 'Never lose the next useful action',
      progress: { completed: 0, total: 0, percent: null },
    })

    const milestone = await request(mod.app).post('/api/cards').send({
      title: 'Capture and review',
      itemType: 'MILESTONE',
      parentId: project.body.card.id,
      eventId: 'evt-hierarchy-milestone',
    })
    expect(milestone.status).toBe(201)

    const task = await request(mod.app).post('/api/cards').send({
      title: 'Add quick capture',
      itemType: 'TASK',
      parentId: milestone.body.card.id,
      estimateMinutes: 20,
      nextAction: 'Create the capture endpoint',
      acceptanceCriteria: 'A thought becomes a task in one request',
      eventId: 'evt-hierarchy-task',
    })
    expect(task.status).toBe(201)
    expect(task.body.card).toMatchObject({
      itemType: 'TASK',
      parentId: milestone.body.card.id,
      estimateMinutes: 20,
    })

    const invalidRootMilestone = await request(mod.app).post('/api/cards').send({
      title: 'Orphan milestone',
      itemType: 'MILESTONE',
      eventId: 'evt-hierarchy-invalid-root',
    })
    expect(invalidRootMilestone.status).toBe(409)

    const invalidTaskChild = await request(mod.app).post('/api/cards').send({
      title: 'Too deeply nested',
      itemType: 'TASK',
      parentId: task.body.card.id,
      eventId: 'evt-hierarchy-invalid-child',
    })
    expect(invalidTaskChild.status).toBe(409)

    const roots = await request(mod.app).get('/api/cards?scope=roots')
    expect(roots.body.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.body.card.id })]),
    )
    expect(roots.body.cards).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: milestone.body.card.id })]),
    )

    const structure = await request(mod.app).get(`/api/cards/${project.body.card.id}/structure`)
    expect(structure.status).toBe(200)
    expect(structure.body.structure.children[0]).toMatchObject({
      id: milestone.body.card.id,
      children: [expect.objectContaining({ id: task.body.card.id })],
    })

    const cannotDeleteParent = await request(mod.app)
      .delete(`/api/cards/${project.body.card.id}`)
      .set('Idempotency-Key', 'evt-hierarchy-delete-parent')
    expect(cannotDeleteParent.status).toBe(409)
  })

  it('tracks checklist progress idempotently and produces a useful restart packet', async () => {
    process.env.OPENCLAW_WORKFLOW_HOOK_URL = ''
    const mod = await import('./index.js')
    const project = await request(mod.app).post('/api/cards').send({
      title: 'ADHD-friendly notebook',
      itemType: 'PROJECT',
      goal: 'Make returning to work feel easy',
      continuation: 'Open the project and ask for the next small step',
      eventId: 'evt-progress-project',
    })
    const milestone = await request(mod.app).post('/api/cards').send({
      title: 'Small visible wins',
      itemType: 'MILESTONE',
      parentId: project.body.card.id,
      eventId: 'evt-progress-milestone',
    })
    const task = await request(mod.app).post('/api/cards').send({
      title: 'Show one next action',
      itemType: 'TASK',
      parentId: milestone.body.card.id,
      nextAction: 'Render the restart card',
      acceptanceCriteria: 'The card names one concrete action',
      estimateMinutes: 15,
      eventId: 'evt-progress-task',
    })

    const add = await request(mod.app).post(`/api/cards/${task.body.card.id}/checklist`).send({
      text: 'Add restart packet UI',
      expectedRevision: 1,
      eventId: 'evt-checklist-add',
    })
    const replay = await request(mod.app).post(`/api/cards/${task.body.card.id}/checklist`).send({
      text: 'This duplicate payload is ignored',
      expectedRevision: 1,
      eventId: 'evt-checklist-add',
    })
    expect(add.status).toBe(201)
    expect(add.body.card).toMatchObject({
      revision: 2,
      progress: { completed: 0, total: 1, percent: 0 },
    })
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.structure.checklist).toHaveLength(1)

    const complete = await request(mod.app)
      .patch(`/api/checklist-items/${add.body.item.id}`)
      .send({ isDone: true, expectedRevision: 1, eventId: 'evt-checklist-complete' })
    const completeReplay = await request(mod.app)
      .patch(`/api/checklist-items/${add.body.item.id}`)
      .send({ isDone: false, expectedRevision: 1, eventId: 'evt-checklist-complete' })
    expect(complete.status).toBe(200)
    expect(complete.body).toMatchObject({
      item: { isDone: true, revision: 2 },
      card: { revision: 3, progress: { completed: 1, total: 1, percent: 100 } },
    })
    expect(completeReplay.headers['idempotent-replay']).toBe('true')
    expect(completeReplay.body.item.isDone).toBe(true)

    const secondItem = await request(mod.app).post(`/api/cards/${task.body.card.id}/checklist`).send({
      text: 'Do not confuse this item with the first',
      expectedRevision: 3,
      eventId: 'evt-checklist-second',
    })
    const crossItemReplay = await request(mod.app)
      .patch(`/api/checklist-items/${secondItem.body.item.id}`)
      .send({ isDone: true, eventId: 'evt-checklist-complete' })
    expect(crossItemReplay.status).toBe(409)

    const restart = await request(mod.app).get(`/api/cards/${project.body.card.id}/restart-packet`)
    expect(restart.status).toBe(200)
    expect(restart.body.restartPacket).toMatchObject({
      goal: 'Make returning to work feel easy',
      progress: { completed: 0, total: 1, percent: 0 },
      currentMilestone: { id: milestone.body.card.id },
      nextTask: { id: task.body.card.id },
      nextAction: 'Render the restart card',
      definitionOfDone: 'The card names one concrete action',
      estimatedMinutes: 15,
      blockers: [],
    })

    let taskRevision = secondItem.body.card.revision as number
    for (const lane of ['TODO', 'READY', 'RUNNING', 'DONE']) {
      const move = await request(mod.app)
        .patch(`/api/cards/${task.body.card.id}`)
        .send({
          lane,
          expectedRevision: taskRevision,
          eventId: `evt-progress-${lane.toLowerCase()}`,
        })
      expect(move.status).toBe(200)
      taskRevision = move.body.card.revision
    }
    const completedRestart = await request(mod.app).get(
      `/api/cards/${project.body.card.id}/restart-packet`,
    )
    expect(completedRestart.body.restartPacket).toMatchObject({
      progress: { completed: 1, total: 1, percent: 100 },
      nextTask: null,
      recentlyCompleted: [expect.objectContaining({ id: task.body.card.id })],
    })
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
