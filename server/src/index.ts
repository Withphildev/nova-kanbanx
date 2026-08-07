import cors from 'cors'
import Database from 'better-sqlite3'
import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrations.js'
import {
  listLoopxTodos,
  loopxConfigFromEnv,
  projectLoopxTodo,
  writeLoopxTodo,
  type LoopxProjection,
  type LoopxWriteAction,
} from './loopx.js'

const PORT = Number(process.env.PORT ?? 3001)
const dbPath = process.env.KANBAN_DB_PATH?.trim() || fileURLToPath(new URL('../kanban.db', import.meta.url))
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const workflowHookUrl = process.env.OPENCLAW_WORKFLOW_HOOK_URL?.trim()

const quarantineMalformedDb = (targetPath: string, reason: string) => {
  const quarantineDir = path.join(path.dirname(targetPath), 'quarantine')
  mkdirSync(quarantineDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.basename(targetPath)
  const quarantinePath = path.join(quarantineDir, `${base}.${timestamp}.malformed.sqlite`)
  cpSync(targetPath, quarantinePath)
  throw new Error(
    `SQLite integrity check failed (${reason}). Quarantined copy: ${quarantinePath}. Refusing to continue.`,
  )
}

const runIntegrityCheck = () => {
  if (!existsSync(dbPath)) {
    return { ok: true as const, detail: 'new database path (file not created yet)' }
  }

  if (statSync(dbPath).size === 0) {
    return { ok: true as const, detail: 'empty database file' }
  }

  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }> | string[]
  const values = rows.map((row) => (typeof row === 'string' ? row : String(row.integrity_check ?? '')))
  const failed = values.some((value) => value.toLowerCase() !== 'ok')
  if (failed) {
    quarantineMalformedDb(dbPath, values.join('; '))
  }
  return { ok: true as const, detail: values[0] ?? 'ok' }
}

export const app = express()
app.use(cors())
app.use(express.json())

const lanes = ['TRIAGE', 'TODO', 'READY', 'RUNNING', 'BLOCKED', 'DONE'] as const

type Lane = (typeof lanes)[number]
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4']

const allowedTransitions: Record<Lane, readonly Lane[]> = {
  TRIAGE: ['TODO'],
  TODO: ['TRIAGE', 'READY'],
  READY: ['TODO', 'RUNNING'],
  RUNNING: ['READY', 'BLOCKED', 'DONE'],
  BLOCKED: ['TODO', 'READY', 'RUNNING'],
  DONE: ['TRIAGE'],
}

type CardRow = {
  id: number
  title: string
  description: string
  lane: Lane
  owner: string
  tags: string
  task_key: string
  priority: Priority
  source: string
  external_id: string | null
  acceptance_criteria: string
  blocked_reason: string
  next_action: string
  continuation: string
  evidence: string
  due_at: string | null
  started_at: string | null
  completed_at: string | null
  revision: number
  created_at: string
  updated_at: string
}

const startupIntegrity = runIntegrityCheck()
runMigrations(db)

const cardRowToJson = (row: CardRow) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  lane: row.lane,
  owner: row.owner,
  tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
  taskKey: row.task_key,
  priority: row.priority,
  source: row.source,
  externalId: row.external_id,
  acceptanceCriteria: row.acceptance_criteria,
  blockedReason: row.blocked_reason,
  nextAction: row.next_action,
  continuation: row.continuation,
  evidence: row.evidence,
  dueAt: row.due_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const logActivity = db.prepare(
  'INSERT INTO activity_log (card_id, action, detail, created_at) VALUES (?, ?, ?, ?)',
)

const eventIdFor = (req: express.Request, body?: { eventId?: unknown }) => {
  const header = req.get('Idempotency-Key')?.trim()
  const bodyId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
  return header || bodyId || randomUUID()
}

const existingEvent = (eventId: string) =>
  db.prepare('SELECT card_id, event_type, result_status FROM task_events WHERE event_id = ?').get(
    eventId,
  ) as { card_id: number | null; event_type: string; result_status: number } | undefined

const insertEvent = db.prepare(`
  INSERT INTO task_events
    (event_id, card_id, event_type, from_lane, to_lane, payload, result_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)

const loopxProjectionDiffers = (row: CardRow, projection: LoopxProjection) =>
  row.title !== projection.title ||
  row.description !== projection.description ||
  row.lane !== projection.lane ||
  row.owner !== projection.owner ||
  row.tags !== projection.tags.join(',') ||
  row.priority !== projection.priority ||
  row.acceptance_criteria !== projection.acceptanceCriteria ||
  row.blocked_reason !== projection.blockedReason ||
  row.next_action !== projection.nextAction ||
  row.continuation !== projection.continuation ||
  row.evidence !== projection.evidence ||
  row.due_at !== projection.dueAt

const loopxEventId = (projection: LoopxProjection) => {
  const fingerprint = createHash('sha256').update(JSON.stringify(projection)).digest('hex').slice(0, 20)
  return `loopx:${projection.externalId}:${fingerprint}`
}

const reconcileLoopx = async (execute: boolean) => {
  const config = loopxConfigFromEnv()
  if (!config.goalId) throw new Error('LoopX is not configured: LOOPX_GOAL_ID is required')
  const result = await listLoopxTodos(config)
  const projections = result.todos.map((todo) => projectLoopxTodo(config.goalId!, todo))
  const current = db.prepare("SELECT * FROM cards WHERE source = 'loopx'").all() as CardRow[]
  const byExternalId = new Map(current.map((row) => [row.external_id, row]))
  const changes = projections.map((projection) => {
    const row = byExternalId.get(projection.externalId)
    return {
      action: !row ? ('create' as const) : loopxProjectionDiffers(row, projection) ? ('update' as const) : ('unchanged' as const),
      cardId: row?.id ?? null,
      externalId: projection.externalId,
      todoId: projection.todoId,
      title: projection.title,
      lane: projection.lane,
      projection,
    }
  })
  const summary = {
    source: projections.length,
    created: changes.filter((change) => change.action === 'create').length,
    updated: changes.filter((change) => change.action === 'update').length,
    unchanged: changes.filter((change) => change.action === 'unchanged').length,
  }
  const syncId = randomUUID()

  if (execute) {
    db.transaction(() => {
      const now = new Date().toISOString()
      for (const change of changes) {
        if (change.action === 'unchanged') continue
        const projection = change.projection
        const eventId = loopxEventId(projection)
        if (existingEvent(eventId)) continue

        let cardId = change.cardId
        let fromLane: Lane | null = null
        if (change.action === 'create') {
          const inserted = db.prepare(
            `INSERT INTO cards (
               title, description, lane, owner, tags, task_key, priority, source, external_id,
               acceptance_criteria, blocked_reason, next_action, continuation, evidence, due_at,
               started_at, completed_at, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'loopx', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          ).run(
            projection.title,
            projection.description,
            projection.lane,
            projection.owner,
            projection.tags.join(','),
            randomUUID(),
            projection.priority,
            projection.externalId,
            projection.acceptanceCriteria,
            projection.blockedReason,
            projection.nextAction,
            projection.continuation,
            projection.evidence,
            projection.dueAt,
            projection.lane === 'RUNNING' ? now : null,
            projection.lane === 'DONE' ? now : null,
            now,
            now,
          )
          cardId = Number(inserted.lastInsertRowid)
        } else {
          const existing = byExternalId.get(projection.externalId)!
          fromLane = existing.lane
          db.prepare(
            `UPDATE cards SET title = ?, description = ?, lane = ?, owner = ?, tags = ?,
               priority = ?, acceptance_criteria = ?, blocked_reason = ?, next_action = ?,
               continuation = ?, evidence = ?, due_at = ?,
               started_at = COALESCE(started_at, ?), completed_at = ?,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
          ).run(
            projection.title,
            projection.description,
            projection.lane,
            projection.owner,
            projection.tags.join(','),
            projection.priority,
            projection.acceptanceCriteria,
            projection.blockedReason,
            projection.nextAction,
            projection.continuation,
            projection.evidence,
            projection.dueAt,
            projection.lane === 'RUNNING' ? now : null,
            projection.lane === 'DONE' ? existing.completed_at ?? now : null,
            now,
            existing.id,
          )
        }
        logActivity.run(cardId, 'loopx.reconciled', `${change.action}: ${projection.externalId}`, now)
        insertEvent.run(
          eventId,
          cardId,
          'loopx.reconciled',
          fromLane,
          projection.lane,
          JSON.stringify({ goalId: config.goalId, todoId: projection.todoId, action: change.action }),
          200,
          now,
        )
      }
      db.prepare(
        `INSERT INTO loopx_reconciliation_receipts
          (sync_id, goal_id, mode, source_count, created_count, updated_count, unchanged_count,
           status, error, created_at) VALUES (?, ?, 'apply', ?, ?, ?, ?, 'ok', NULL, ?)`,
      ).run(syncId, config.goalId, summary.source, summary.created, summary.updated, summary.unchanged, now)
    })()
  }

  return {
    ok: true,
    configured: true,
    goalId: config.goalId,
    dryRun: !execute,
    syncId: execute ? syncId : null,
    summary,
    changes: changes.map(({ projection: _projection, ...change }) => change),
  }
}

const validDate = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value)))

const transitionError = (from: Lane, to: Lane) => {
  if (from === to || allowedTransitions[from].includes(to)) return null
  return `invalid lifecycle transition: ${from} -> ${to}`
}

const emitWorkflowHook = async (event: {
  eventId: string
  event: 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted'
  cardId: number
  detail?: string
  lane?: Lane
}) => {
  if (!workflowHookUrl) return

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      await fetch(workflowHookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...event,
          timestamp: new Date().toISOString(),
        }),
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('workflow hook emit failed', error)
  }
}

app.get('/api/health', (_req, res) => {
  try {
    const integrity = runIntegrityCheck()
    const loopx = loopxConfigFromEnv()
    res.json({
      ok: true,
      service: 'nova-kanbanx-api',
      dbIntegrity: integrity,
      loopx: { configured: Boolean(loopx.goalId), goalId: loopx.goalId ?? null },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ ok: false, service: 'nova-kanbanx-api', dbIntegrity: { ok: false, detail: message } })
  }
})

app.get('/api/loopx/status', async (_req, res) => {
  const config = loopxConfigFromEnv()
  if (!config.goalId) {
    return res.json({ ok: true, configured: false, goalId: null, message: 'Set LOOPX_GOAL_ID to enable LoopX.' })
  }
  try {
    const result = await listLoopxTodos(config)
    const lastReceipt = db
      .prepare(
        `SELECT sync_id, goal_id, mode, source_count, created_count, updated_count,
                unchanged_count, status, error, created_at
         FROM loopx_reconciliation_receipts WHERE goal_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(config.goalId)
    return res.json({
      ok: true,
      configured: true,
      available: true,
      goalId: config.goalId,
      todoCount: result.todos.length,
      lastReceipt: lastReceipt ?? null,
    })
  } catch (error) {
    return res.status(503).json({
      ok: false,
      configured: true,
      available: false,
      goalId: config.goalId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/loopx/reconcile', async (req, res) => {
  try {
    const execute = req.body?.execute === true
    return res.json(await reconcileLoopx(execute))
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/loopx/cards/:id/actions', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!card) return res.status(404).json({ error: 'card not found' })
  if (card.source !== 'loopx' || !card.external_id) {
    return res.status(409).json({ error: 'card is not managed by LoopX' })
  }
  const config = loopxConfigFromEnv()
  if (!config.goalId || !card.external_id.startsWith(`${config.goalId}:`)) {
    return res.status(409).json({ error: 'card does not belong to the configured LoopX goal' })
  }
  const action = (req.body && typeof req.body === 'object' ? req.body : {}) as LoopxWriteAction
  if (!['claim', 'update', 'complete'].includes(action.action)) {
    return res.status(400).json({ error: 'action must be claim, update, or complete' })
  }
  try {
    const todoId = card.external_id.slice(config.goalId.length + 1)
    const loopx = await writeLoopxTodo(config, todoId, action)
    const reconciliation = action.execute ? await reconcileLoopx(true) : null
    return res.json({ ok: true, dryRun: action.execute !== true, loopx, reconciliation })
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/lanes', (_req, res) => {
  res.json({ lanes, allowedTransitions })
})

app.get('/api/cards', (_req, res) => {
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as CardRow[]
  res.json({ cards: rows.map(cardRowToJson) })
})

app.post('/api/cards', async (req, res) => {
  const body = req.body as {
    eventId?: string
    title?: string
    description?: string
    lane?: Lane
    owner?: string
    tags?: string[]
    priority?: Priority
    source?: string
    externalId?: string | null
    acceptanceCriteria?: string
    blockedReason?: string
    nextAction?: string
    continuation?: string
    evidence?: string
    dueAt?: string | null
  }

  if (!body.title || !body.title.trim()) {
    return res.status(400).json({ error: 'title is required' })
  }
  if (body.source?.trim().toLowerCase() === 'loopx') {
    return res.status(409).json({ error: 'source "loopx" is reserved for LoopX reconciliation' })
  }

  if (body.lane !== undefined && !lanes.includes(body.lane)) {
    return res.status(400).json({ error: 'invalid lane' })
  }
  if (body.priority !== undefined && !priorities.includes(body.priority)) {
    return res.status(400).json({ error: 'invalid priority' })
  }
  if (body.dueAt !== undefined && !validDate(body.dueAt)) {
    return res.status(400).json({ error: 'invalid dueAt' })
  }

  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'card.created' || replay.card_id === null) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(replay.card_id) as CardRow | undefined
    if (!card) return res.status(409).json({ error: 'idempotent result is no longer available' })
    res.set('Idempotent-Replay', 'true')
    return res
      .status(replay.result_status)
      .json({ card: cardRowToJson(card), eventId, idempotentReplay: true })
  }

  const lane = body.lane ?? 'TRIAGE'
  const now = new Date().toISOString()
  const tags = (body.tags ?? []).map((t) => t.trim()).filter(Boolean).join(',')
  const taskKey = randomUUID()

  let card: CardRow
  try {
    card = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO cards (
             title, description, lane, owner, tags, task_key, priority, source, external_id,
             acceptance_criteria, blocked_reason, next_action, continuation, evidence, due_at,
             started_at, completed_at, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          body.title!.trim(),
          body.description?.trim() ?? '',
          lane,
          body.owner?.trim() ?? '',
          tags,
          taskKey,
          body.priority ?? 'P2',
          body.source?.trim() || 'manual',
          body.externalId?.trim() || null,
          body.acceptanceCriteria?.trim() ?? '',
          body.blockedReason?.trim() ?? '',
          body.nextAction?.trim() ?? '',
          body.continuation?.trim() ?? '',
          body.evidence?.trim() ?? '',
          body.dueAt ?? null,
          lane === 'RUNNING' ? now : null,
          lane === 'DONE' ? now : null,
          now,
          now,
        )
      const cardId = Number(result.lastInsertRowid)
      logActivity.run(cardId, 'card.created', body.title!.trim(), now)
      insertEvent.run(eventId, cardId, 'card.created', null, lane, JSON.stringify(body), 201, now)
      return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow
    })()
  } catch (error) {
    if (String(error).includes('cards.source, cards.external_id')) {
      return res.status(409).json({ error: 'source and externalId already exist' })
    }
    throw error
  }

  void emitWorkflowHook({ eventId, event: 'card.created', cardId: card.id, lane })

  return res.status(201).json({ card: cardRowToJson(card), eventId })
})

app.patch('/api/cards/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined

  if (!existing) {
    return res.status(404).json({ error: 'card not found' })
  }
  if (existing.source === 'loopx') {
    return res.status(409).json({
      error: 'LoopX-managed cards are read-only; use /api/loopx/cards/:id/actions',
    })
  }

  const body = req.body as {
    eventId?: string
    title?: string
    description?: string
    lane?: Lane
    owner?: string
    tags?: string[]
    priority?: Priority
    source?: string
    externalId?: string | null
    acceptanceCriteria?: string
    blockedReason?: string
    nextAction?: string
    continuation?: string
    evidence?: string
    dueAt?: string | null
    expectedRevision?: number
  }

  if (body.lane !== undefined && !lanes.includes(body.lane)) {
    return res.status(400).json({ error: 'invalid lane' })
  }
  if (body.priority !== undefined && !priorities.includes(body.priority)) {
    return res.status(400).json({ error: 'invalid priority' })
  }
  if (body.dueAt !== undefined && !validDate(body.dueAt)) {
    return res.status(400).json({ error: 'invalid dueAt' })
  }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'card.updated' && replay.event_type !== 'card.moved') {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    if (replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key belongs to another card' })
    }
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
    res.set('Idempotent-Replay', 'true')
    return res.json({ card: cardRowToJson(card), eventId, idempotentReplay: true })
  }

  if (body.expectedRevision !== undefined && body.expectedRevision !== existing.revision) {
    return res.status(409).json({ error: 'revision conflict', currentRevision: existing.revision })
  }

  const nextLane = body.lane ?? existing.lane
  const invalidTransition = transitionError(existing.lane, nextLane)
  if (invalidTransition) {
    return res.status(409).json({
      error: invalidTransition,
      allowedTransitions: allowedTransitions[existing.lane],
    })
  }
  const nextTitle = body.title?.trim() ? body.title.trim() : existing.title
  const nextDescription = body.description?.trim() ?? existing.description
  const nextOwner = body.owner?.trim() ?? existing.owner
  const nextTags = body.tags ? body.tags.map((t) => t.trim()).filter(Boolean).join(',') : existing.tags
  const now = new Date().toISOString()
  const wasMoved = existing.lane !== nextLane
  const detail = wasMoved ? `${existing.lane} -> ${nextLane}` : 'fields updated'
  const eventType = wasMoved ? 'card.moved' : 'card.updated'
  const nextStartedAt = existing.started_at ?? (nextLane === 'RUNNING' ? now : null)
  const nextCompletedAt = nextLane === 'DONE' ? existing.completed_at ?? now : null

  let updated: CardRow
  try {
    updated = db.transaction(() => {
      db.prepare(
        `UPDATE cards SET
           title = ?, description = ?, lane = ?, owner = ?, tags = ?, priority = ?, source = ?,
           external_id = ?, acceptance_criteria = ?, blocked_reason = ?, next_action = ?,
           continuation = ?, evidence = ?, due_at = ?, started_at = ?, completed_at = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextTitle,
        nextDescription,
        nextLane,
        nextOwner,
        nextTags,
        body.priority ?? existing.priority,
        body.source?.trim() || existing.source,
        body.externalId === undefined ? existing.external_id : body.externalId?.trim() || null,
        body.acceptanceCriteria?.trim() ?? existing.acceptance_criteria,
        body.blockedReason?.trim() ?? existing.blocked_reason,
        body.nextAction?.trim() ?? existing.next_action,
        body.continuation?.trim() ?? existing.continuation,
        body.evidence?.trim() ?? existing.evidence,
        body.dueAt === undefined ? existing.due_at : body.dueAt,
        nextStartedAt,
        nextCompletedAt,
        now,
        id,
      )
      logActivity.run(id, eventType, detail, now)
      insertEvent.run(
        eventId,
        id,
        eventType,
        existing.lane,
        nextLane,
        JSON.stringify(body),
        200,
        now,
      )
      return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
    })()
  } catch (error) {
    if (String(error).includes('cards.source, cards.external_id')) {
      return res.status(409).json({ error: 'source and externalId already exist' })
    }
    throw error
  }

  void emitWorkflowHook({
    eventId,
    event: eventType,
    cardId: id,
    detail,
    lane: nextLane,
  })

  return res.json({ card: cardRowToJson(updated), eventId })
})

app.delete('/api/cards/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const body = req.body as { eventId?: string }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'card.deleted' || replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    res.set('Idempotent-Replay', 'true')
    return res.status(204).send()
  }

  const existing = db.prepare('SELECT id, lane FROM cards WHERE id = ?').get(id) as
    | { id: number; lane: Lane }
    | undefined
  if (!existing) {
    return res.status(404).json({ error: 'card not found' })
  }
  const managed = db.prepare('SELECT source FROM cards WHERE id = ?').get(id) as { source: string } | undefined
  if (managed?.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed cards cannot be deleted from the projection' })
  }

  const now = new Date().toISOString()
  const removeCard = db.transaction((cardId: number) => {
    db.prepare('DELETE FROM activity_log WHERE card_id = ?').run(cardId)
    db.prepare('DELETE FROM cards WHERE id = ?').run(cardId)
    insertEvent.run(eventId, cardId, 'card.deleted', existing.lane, null, '{}', 204, now)
    logActivity.run(null, 'card.deleted', `card:${id}`, now)
  })

  removeCard(id)
  void emitWorkflowHook({ eventId, event: 'card.deleted', cardId: id })

  return res.status(204).send()
})

app.get('/api/activity', (_req, res) => {
  const rows = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50').all()
  res.json({ activity: rows })
})

app.get('/api/cards/:id/events', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const rows = db
    .prepare(
      `SELECT event_id, event_type, from_lane, to_lane, payload, result_status, created_at
       FROM task_events WHERE card_id = ? ORDER BY id ASC`,
    )
    .all(id) as Array<{
    event_id: string
    event_type: string
    from_lane: Lane | null
    to_lane: Lane | null
    payload: string
    result_status: number
    created_at: string
  }>

  res.json({
    events: rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      fromLane: row.from_lane,
      toLane: row.to_lane,
      payload: JSON.parse(row.payload) as unknown,
      resultStatus: row.result_status,
      createdAt: row.created_at,
    })),
  })
})

if (process.env.NODE_ENV !== 'test') {
  console.log(`db integrity check: ${startupIntegrity.detail}`)
  app.listen(PORT, () => {
    console.log(`nova-kanbanx api listening on http://localhost:${PORT}`)
  })
}
