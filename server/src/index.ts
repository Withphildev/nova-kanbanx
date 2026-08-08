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
const reminderHookUrl = process.env.KANBAN_REMINDER_HOOK_URL?.trim()
const envMilliseconds = (name: string, fallback: number, minimum: number) => {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback
}
const reminderPollMs = envMilliseconds('KANBAN_REMINDER_POLL_MS', 60_000, 1_000)
const reminderTimeoutMs = envMilliseconds('KANBAN_REMINDER_TIMEOUT_MS', 5_000, 250)

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
type ItemType = 'PROJECT' | 'MILESTONE' | 'TASK'
type ReminderStatus = 'NONE' | 'PENDING' | 'DELIVERED' | 'ACKNOWLEDGED' | 'CANCELLED'
type EnergyDemand = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH'
type RecurrenceFrequency = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

const priorities: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4']
const itemTypes: ItemType[] = ['PROJECT', 'MILESTONE', 'TASK']
const reminderStatuses: ReminderStatus[] = ['NONE', 'PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'CANCELLED']
const energyDemands: EnergyDemand[] = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH']
const recurrenceFrequencies: RecurrenceFrequency[] = ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

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
  item_type: ItemType
  parent_id: number | null
  goal: string
  estimate_minutes: number | null
  position: number
  captured_text: string
  remind_at: string | null
  reminder_timezone: string
  reminder_status: ReminderStatus
  reminder_acknowledged_at: string | null
  reviewed_at: string | null
  energy_demand: EnergyDemand
  recurrence_frequency: RecurrenceFrequency
  recurrence_interval: number
  recurrence_end_at: string | null
  recurrence_occurrences: number
  recurrence_anchor_month: number
  recurrence_anchor_day: number
  created_at: string
  updated_at: string
}

type ChecklistRow = {
  id: number
  card_id: number
  text: string
  is_done: number
  position: number
  revision: number
  created_at: string
  updated_at: string
}

type ReminderDeliveryReceiptRow = {
  delivery_id: string
  card_id: number | null
  task_key: string
  remind_at: string
  reminder_timezone: string
  status: 'ATTEMPTING' | 'FAILED' | 'DELIVERED'
  attempt_count: number
  last_attempt_at: string | null
  delivered_at: string | null
  response_status: number | null
  error: string | null
  created_at: string
  updated_at: string
}

const startupIntegrity = runIntegrityCheck()
runMigrations(db)

const progressForCard = (row: CardRow) => {
  if (row.item_type === 'TASK') {
    const result = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(is_done), 0) AS completed
         FROM checklist_items WHERE card_id = ?`,
      )
      .get(row.id) as { total: number; completed: number }
    return {
      completed: result.completed,
      total: result.total,
      percent: result.total === 0 ? null : Math.round((result.completed / result.total) * 100),
    }
  }

  const result = db
    .prepare(
      `WITH RECURSIVE descendants(id, item_type, lane) AS (
         SELECT id, item_type, lane FROM cards WHERE parent_id = ?
         UNION ALL
         SELECT cards.id, cards.item_type, cards.lane
         FROM cards JOIN descendants ON cards.parent_id = descendants.id
       )
       SELECT
         SUM(CASE WHEN item_type = 'TASK' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN item_type = 'TASK' AND lane = 'DONE' THEN 1 ELSE 0 END) AS completed
       FROM descendants`,
    )
    .get(row.id) as { total: number | null; completed: number | null }
  const total = result.total ?? 0
  const completed = result.completed ?? 0
  return {
    completed,
    total,
    percent: total === 0 ? null : Math.round((completed / total) * 100),
  }
}

const checklistRowToJson = (row: ChecklistRow) => ({
  id: row.id,
  cardId: row.card_id,
  text: row.text,
  isDone: row.is_done === 1,
  position: row.position,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

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
  itemType: row.item_type,
  parentId: row.parent_id,
  goal: row.goal,
  estimateMinutes: row.estimate_minutes,
  position: row.position,
  capturedText: row.captured_text,
  remindAt: row.remind_at,
  reminderTimezone: row.reminder_timezone,
  reminderStatus: row.reminder_status,
  reminderAcknowledgedAt: row.reminder_acknowledged_at,
  reviewedAt: row.reviewed_at,
  energyDemand: row.energy_demand,
  recurrenceFrequency: row.recurrence_frequency,
  recurrenceInterval: row.recurrence_interval,
  recurrenceEndAt: row.recurrence_end_at,
  recurrenceOccurrences: row.recurrence_occurrences,
  recurrenceAnchorMonth: row.recurrence_anchor_month,
  recurrenceAnchorDay: row.recurrence_anchor_day,
  progress: progressForCard(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

type StructureNode = ReturnType<typeof cardRowToJson> & {
  checklist: ReturnType<typeof checklistRowToJson>[]
  children: StructureNode[]
}

const structureForCard = (row: CardRow): StructureNode => {
  const children = db
    .prepare('SELECT * FROM cards WHERE parent_id = ? ORDER BY position ASC, id ASC')
    .all(row.id) as CardRow[]
  const checklist = db
    .prepare('SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position ASC, id ASC')
    .all(row.id) as ChecklistRow[]
  return {
    ...cardRowToJson(row),
    checklist: checklist.map(checklistRowToJson),
    children: children.map(structureForCard),
  }
}

const logActivity = db.prepare(
  'INSERT INTO activity_log (card_id, action, detail, created_at) VALUES (?, ?, ?, ?)',
)

const eventIdFor = (req: express.Request, body?: { eventId?: unknown }) => {
  const header = req.get('Idempotency-Key')?.trim()
  const bodyId = typeof body?.eventId === 'string' ? body.eventId.trim() : ''
  return header || bodyId || randomUUID()
}

const existingEvent = (eventId: string) =>
  db.prepare('SELECT card_id, event_type, payload, result_status FROM task_events WHERE event_id = ?').get(
    eventId,
  ) as
    | { card_id: number | null; event_type: string; payload: string; result_status: number }
    | undefined

const eventPayload = (event: { payload: string }) => {
  try {
    return JSON.parse(event.payload) as Record<string, unknown>
  } catch {
    return {}
  }
}

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

const validInstant = (value: unknown) =>
  value === null ||
  (typeof value === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim()) &&
    !Number.isNaN(Date.parse(value)))

const validDate = (value: unknown) => {
  if (value === null) return true
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = new Date(`${normalized}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(normalized)
  }
  return validInstant(normalized)
}

const validTimezone = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format()
    return true
  } catch {
    return false
  }
}

const requireExpectedRevision = (
  res: express.Response,
  value: unknown,
  currentRevision: number,
) => {
  if (!Number.isInteger(value)) {
    res.status(400).json({ error: 'expectedRevision is required and must be an integer' })
    return false
  }
  if (value !== currentRevision) {
    res.status(409).json({ error: 'revision conflict', currentRevision })
    return false
  }
  return true
}

const localDateKey = (instant: string | Date, timezone: string) => {
  const date = instant instanceof Date ? instant : new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

type LocalDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const localDateTimeParts = (instant: string | Date, timezone: string): LocalDateTimeParts => {
  const date = instant instanceof Date ? instant : new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
    second: number('second'),
  }
}

const localPartsToInstant = (target: LocalDateTimeParts, timezone: string) => {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  )
  let candidate = targetAsUtc
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localDateTimeParts(new Date(candidate), timezone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    const correction = targetAsUtc - observedAsUtc
    if (correction === 0) break
    candidate += correction
  }
  return new Date(candidate).toISOString()
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

const nextRecurringInstant = (
  current: string,
  timezone: string,
  frequency: Exclude<RecurrenceFrequency, 'NONE'>,
  interval: number,
  anchorMonth = 0,
  anchorDay = 0,
) => {
  const local = localDateTimeParts(current, timezone)
  if (frequency === 'DAILY' || frequency === 'WEEKLY') {
    const addDays = interval * (frequency === 'WEEKLY' ? 7 : 1)
    const advanced = new Date(
      Date.UTC(local.year, local.month - 1, local.day + addDays, local.hour, local.minute, local.second),
    )
    return localPartsToInstant(
      {
        year: advanced.getUTCFullYear(),
        month: advanced.getUTCMonth() + 1,
        day: advanced.getUTCDate(),
        hour: local.hour,
        minute: local.minute,
        second: local.second,
      },
      timezone,
    )
  }

  const absoluteMonth =
    frequency === 'MONTHLY'
      ? local.year * 12 + (local.month - 1) + interval
      : (local.year + interval) * 12 + ((anchorMonth || local.month) - 1)
  const year = Math.floor(absoluteMonth / 12)
  const month = (absoluteMonth % 12) + 1
  return localPartsToInstant(
    {
      year,
      month,
      day: Math.min(anchorDay || local.day, daysInMonth(year, month)),
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    timezone,
  )
}

const planningScheduledAt = (row: CardRow) =>
  (row.reminder_status === 'PENDING' || row.reminder_status === 'DELIVERED'
    ? row.remind_at
    : null) || row.due_at

type ReviewEnergy = 'ANY' | Exclude<EnergyDemand, 'UNKNOWN'>

const reviewRecommendation = (
  rows: CardRow[],
  at: Date,
  timezone: string,
  availableMinutes: number,
  energy: ReviewEnergy,
) => {
  const todayKey = localDateKey(at, timezone)
  const laneScore: Record<Lane, number> = {
    RUNNING: 80,
    READY: 60,
    TODO: 40,
    TRIAGE: 15,
    BLOCKED: -1000,
    DONE: -1000,
  }
  const priorityScore: Record<Priority, number> = { P0: 50, P1: 40, P2: 25, P3: 10, P4: 0 }
  const scored = rows
    .filter((row) => row.item_type === 'TASK' && row.lane !== 'DONE' && row.lane !== 'BLOCKED')
    .map((row) => {
      const schedule = planningScheduledAt(row)
      const scheduleKey = schedule ? localDateKey(schedule, timezone) : null
      const fitsTime = row.estimate_minutes !== null && row.estimate_minutes <= availableMinutes
      const energyMatches = energy !== 'ANY' && row.energy_demand === energy
      let score = laneScore[row.lane] + priorityScore[row.priority]
      if (scheduleKey !== null && scheduleKey < todayKey) score += 70
      if (scheduleKey === todayKey) score += 60
      if (fitsTime) score += 25
      if (row.estimate_minutes !== null && row.estimate_minutes > availableMinutes) score -= 30
      if (energyMatches) score += 20
      if (energy === 'LOW' && row.energy_demand === 'HIGH') score -= 35
      if (row.next_action) score += 10

      const reasons: string[] = []
      if (row.lane === 'RUNNING') reasons.push('It is already in motion, so restarting costs less.')
      if (scheduleKey !== null && scheduleKey < todayKey) {
        reasons.push('It was scheduled earlier; this is information, not a failure.')
      } else if (scheduleKey === todayKey) {
        reasons.push('It is scheduled for today.')
      }
      if (row.priority === 'P0' || row.priority === 'P1') reasons.push(`It is marked ${row.priority}.`)
      if (fitsTime) reasons.push(`Its ${row.estimate_minutes}-minute estimate fits the time available.`)
      if (energyMatches) reasons.push(`Its ${row.energy_demand.toLowerCase()} energy demand matches.`)
      if (row.next_action) reasons.push('It already has a concrete next action.')
      if (reasons.length === 0) reasons.push('It is the best available unblocked task right now.')
      return { row, score, reasons }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.row.estimate_minutes ?? Number.MAX_SAFE_INTEGER) -
          (b.row.estimate_minutes ?? Number.MAX_SAFE_INTEGER) ||
        a.row.position - b.row.position ||
        a.row.id - b.row.id,
    )

  const best = scored[0]
  return {
    focus: best
      ? {
          card: cardRowToJson(best.row),
          action: best.row.next_action || best.row.title,
          reasons: best.reasons,
        }
      : null,
    quickWins: scored
      .filter(({ row }) => row.estimate_minutes !== null && row.estimate_minutes <= 15)
      .slice(0, 3)
      .map(({ row }) => cardRowToJson(row)),
  }
}

const validNonNegativeInteger = (value: unknown) =>
  value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)

const hierarchyError = (itemType: ItemType, parent: CardRow | undefined) => {
  if (!parent) {
    return itemType === 'MILESTONE' ? 'a milestone requires a project parent' : null
  }
  if (parent.source === 'loopx') return 'LoopX-managed cards cannot own local child work'
  if (itemType === 'PROJECT') return 'a project cannot have a parent'
  if (parent.item_type === 'TASK') return 'a task cannot own child cards'
  if (parent.item_type === 'MILESTONE' && itemType !== 'TASK') {
    return 'a milestone can contain tasks only'
  }
  return null
}

type DecompositionTask = {
  title: string
  nextAction: string
  acceptanceCriteria: string
  estimateMinutes: number | null
  energyDemand: EnergyDemand
  priority: Priority
}

type DecompositionMilestone = {
  title: string
  goal: string
  tasks: DecompositionTask[]
}

const normalizedDecomposition = (value: unknown) => {
  if (!Array.isArray(value)) return { error: 'milestones must be an array' as const }
  if (value.length === 0 || value.length > 6) {
    return { error: 'provide between 1 and 6 milestones' as const }
  }
  const milestones: DecompositionMilestone[] = []
  let taskCount = 0
  for (const [milestoneIndex, rawMilestone] of value.entries()) {
    if (!rawMilestone || typeof rawMilestone !== 'object') {
      return { error: `milestone ${milestoneIndex + 1} must be an object` as const }
    }
    const milestone = rawMilestone as Record<string, unknown>
    const title = typeof milestone.title === 'string' ? milestone.title.trim() : ''
    if (!title) return { error: `milestone ${milestoneIndex + 1} requires a title` as const }
    if (!Array.isArray(milestone.tasks) || milestone.tasks.length === 0 || milestone.tasks.length > 8) {
      return { error: `milestone ${milestoneIndex + 1} requires between 1 and 8 tasks` as const }
    }
    const tasks: DecompositionTask[] = []
    for (const [taskIndex, rawTask] of milestone.tasks.entries()) {
      if (!rawTask || typeof rawTask !== 'object') {
        return { error: `task ${milestoneIndex + 1}.${taskIndex + 1} must be an object` as const }
      }
      const task = rawTask as Record<string, unknown>
      const taskTitle = typeof task.title === 'string' ? task.title.trim() : ''
      if (!taskTitle) return { error: `task ${milestoneIndex + 1}.${taskIndex + 1} requires a title` as const }
      const estimateMinutes = task.estimateMinutes === undefined ? null : task.estimateMinutes
      if (!validNonNegativeInteger(estimateMinutes)) {
        return { error: `task ${milestoneIndex + 1}.${taskIndex + 1} has invalid estimateMinutes` as const }
      }
      const energyDemand = task.energyDemand === undefined ? 'UNKNOWN' : task.energyDemand
      if (typeof energyDemand !== 'string' || !energyDemands.includes(energyDemand as EnergyDemand)) {
        return { error: `task ${milestoneIndex + 1}.${taskIndex + 1} has invalid energyDemand` as const }
      }
      const priority = task.priority === undefined ? 'P2' : task.priority
      if (typeof priority !== 'string' || !priorities.includes(priority as Priority)) {
        return { error: `task ${milestoneIndex + 1}.${taskIndex + 1} has invalid priority` as const }
      }
      tasks.push({
        title: taskTitle,
        nextAction:
          typeof task.nextAction === 'string' && task.nextAction.trim()
            ? task.nextAction.trim()
            : taskTitle,
        acceptanceCriteria:
          typeof task.acceptanceCriteria === 'string' ? task.acceptanceCriteria.trim() : '',
        estimateMinutes: estimateMinutes as number | null,
        energyDemand: energyDemand as EnergyDemand,
        priority: priority as Priority,
      })
      taskCount += 1
    }
    milestones.push({
      title,
      goal: typeof milestone.goal === 'string' ? milestone.goal.trim() : '',
      tasks,
    })
  }
  if (taskCount > 24) return { error: 'a decomposition can contain at most 24 tasks' as const }
  return { milestones, taskCount }
}

const transitionError = (from: Lane, to: Lane) => {
  if (from === to || allowedTransitions[from].includes(to)) return null
  return `invalid lifecycle transition: ${from} -> ${to}`
}

const emitWorkflowHook = async (event: {
  eventId: string
  event: 'card.created' | 'card.captured' | 'card.updated' | 'card.moved' | 'card.deleted'
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

const reminderDeliveryId = (card: Pick<CardRow, 'task_key' | 'remind_at'>) =>
  `kanban-reminder-${createHash('sha256')
    .update(`${card.task_key}:${card.remind_at ?? ''}`)
    .digest('hex')
    .slice(0, 32)}`

const reminderReceiptToJson = (row: ReminderDeliveryReceiptRow) => ({
  deliveryId: row.delivery_id,
  cardId: row.card_id,
  taskKey: row.task_key,
  remindAt: row.remind_at,
  reminderTimezone: row.reminder_timezone,
  status: row.status,
  attemptCount: row.attempt_count,
  lastAttemptAt: row.last_attempt_at,
  deliveredAt: row.delivered_at,
  responseStatus: row.response_status,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const dueReminderRows = (at: string) =>
  db
    .prepare(
      `SELECT * FROM cards
       WHERE reminder_status = 'PENDING' AND remind_at IS NOT NULL AND remind_at <= ?
       ORDER BY remind_at ASC, id ASC LIMIT 100`,
    )
    .all(at) as CardRow[]

type ReminderPollResult = {
  ok: true
  dryRun: boolean
  generatedAt: string
  summary: { due: number; delivered: number; failed: number }
  deliveries: Array<{
    deliveryId: string
    cardId: number
    taskKey: string
    status: 'DUE' | 'FAILED' | 'DELIVERED'
    attemptCount?: number
    responseStatus?: number | null
    error?: string | null
  }>
}

let reminderPollInFlight: Promise<ReminderPollResult> | null = null

const executeReminderPoll = async (at: string): Promise<ReminderPollResult> => {
  const cards = dueReminderRows(at)
  const deliveries: ReminderPollResult['deliveries'] = []
  let delivered = 0
  let failed = 0

  for (const card of cards) {
    const deliveryId = reminderDeliveryId(card)
    const attemptAt = new Date().toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO reminder_delivery_receipts
        (delivery_id, card_id, task_key, remind_at, reminder_timezone, status,
         attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'FAILED', 0, ?, ?)`,
    ).run(
      deliveryId,
      card.id,
      card.task_key,
      card.remind_at,
      card.reminder_timezone,
      attemptAt,
      attemptAt,
    )
    db.prepare(
      `UPDATE reminder_delivery_receipts
       SET status = 'ATTEMPTING', attempt_count = attempt_count + 1,
           last_attempt_at = ?, response_status = NULL, error = NULL, updated_at = ?
       WHERE delivery_id = ?`,
    ).run(attemptAt, attemptAt, deliveryId)

    const receipt = db
      .prepare('SELECT * FROM reminder_delivery_receipts WHERE delivery_id = ?')
      .get(deliveryId) as ReminderDeliveryReceiptRow
    let responseStatus: number | null = null
    let deliveryError: string | null = null

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), reminderTimeoutMs)
      try {
        const response = await fetch(reminderHookUrl!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': deliveryId,
          },
          signal: controller.signal,
          body: JSON.stringify({
            event: 'reminder.due',
            deliveryId,
            timestamp: attemptAt,
            card: {
              id: card.id,
              taskKey: card.task_key,
              title: card.title,
              capturedText: card.captured_text,
              lane: card.lane,
              priority: card.priority,
              remindAt: card.remind_at,
              reminderTimezone: card.reminder_timezone,
              recurrenceFrequency: card.recurrence_frequency,
              recurrenceInterval: card.recurrence_interval,
              recurrenceEndAt: card.recurrence_end_at,
              recurrenceOccurrence: card.recurrence_occurrences + 1,
              dueAt: card.due_at,
              nextAction: card.next_action,
              acceptanceCriteria: card.acceptance_criteria,
            },
          }),
        })
        responseStatus = response.status
        if (!response.ok) deliveryError = `reminder hook returned HTTP ${response.status}`
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      deliveryError = error instanceof Error ? error.message : String(error)
    }

    if (deliveryError === null) {
      const deliveredAt = new Date().toISOString()
      db.transaction(() => {
        db.prepare(
          `UPDATE reminder_delivery_receipts
           SET status = 'DELIVERED', delivered_at = ?, response_status = ?, error = NULL, updated_at = ?
           WHERE delivery_id = ?`,
        ).run(deliveredAt, responseStatus, deliveredAt, deliveryId)
        const update = db.prepare(
          `UPDATE cards SET reminder_status = 'DELIVERED', revision = revision + 1, updated_at = ?
           WHERE id = ? AND reminder_status = 'PENDING' AND remind_at = ?`,
        ).run(deliveredAt, card.id, card.remind_at)
        if (update.changes > 0) {
          logActivity.run(card.id, 'reminder.delivered', deliveryId, deliveredAt)
          insertEvent.run(
            `reminder-delivery:${deliveryId}`,
            card.id,
            'reminder.delivered',
            card.lane,
            card.lane,
            JSON.stringify({ deliveryId, remindAt: card.remind_at, responseStatus }),
            200,
            deliveredAt,
          )
        }
      })()
      delivered += 1
      deliveries.push({
        deliveryId,
        cardId: card.id,
        taskKey: card.task_key,
        status: 'DELIVERED',
        attemptCount: receipt.attempt_count,
        responseStatus,
      })
    } else {
      const failedAt = new Date().toISOString()
      db.prepare(
        `UPDATE reminder_delivery_receipts
         SET status = 'FAILED', response_status = ?, error = ?, updated_at = ?
         WHERE delivery_id = ?`,
      ).run(responseStatus, deliveryError.slice(0, 1000), failedAt, deliveryId)
      failed += 1
      deliveries.push({
        deliveryId,
        cardId: card.id,
        taskKey: card.task_key,
        status: 'FAILED',
        attemptCount: receipt.attempt_count,
        responseStatus,
        error: deliveryError,
      })
    }
  }

  return {
    ok: true,
    dryRun: false,
    generatedAt: at,
    summary: { due: cards.length, delivered, failed },
    deliveries,
  }
}

const runReminderPoll = (at = new Date().toISOString()) => {
  if (!reminderPollInFlight) {
    reminderPollInFlight = executeReminderPoll(at).finally(() => {
      reminderPollInFlight = null
    })
  }
  return reminderPollInFlight
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
      reminders: { configured: Boolean(reminderHookUrl), pollMs: reminderPollMs },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ ok: false, service: 'nova-kanbanx-api', dbIntegrity: { ok: false, detail: message } })
  }
})

app.get('/api/reminders/status', (_req, res) => {
  const now = new Date().toISOString()
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN reminder_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN reminder_status = 'PENDING' AND remind_at <= ? THEN 1 ELSE 0 END) AS due
       FROM cards`,
    )
    .get(now) as { pending: number | null; due: number | null }
  const receipts = db
    .prepare('SELECT * FROM reminder_delivery_receipts ORDER BY id DESC LIMIT 20')
    .all() as ReminderDeliveryReceiptRow[]
  return res.json({
    ok: true,
    configured: Boolean(reminderHookUrl),
    pollMs: reminderPollMs,
    timeoutMs: reminderTimeoutMs,
    counts: { pending: counts.pending ?? 0, due: counts.due ?? 0 },
    latestReceipts: receipts.map(reminderReceiptToJson),
  })
})

app.post('/api/reminders/poll', async (req, res) => {
  const at = typeof req.body?.at === 'string' ? req.body.at.trim() : new Date().toISOString()
  if (!validInstant(at)) {
    return res.status(400).json({ error: 'invalid at; use an ISO instant with an offset' })
  }
  const cards = dueReminderRows(at)
  if (req.body?.execute !== true) {
    return res.json({
      ok: true,
      dryRun: true,
      generatedAt: at,
      summary: { due: cards.length, delivered: 0, failed: 0 },
      deliveries: cards.map((card) => ({
        deliveryId: reminderDeliveryId(card),
        cardId: card.id,
        taskKey: card.task_key,
        status: 'DUE',
      })),
    })
  }
  if (!reminderHookUrl) {
    return res.status(409).json({ error: 'reminder delivery is not configured' })
  }
  return res.json(await runReminderPoll(at))
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

app.get('/api/cards', (req, res) => {
  const rows = (req.query.scope === 'roots'
    ? db.prepare('SELECT * FROM cards WHERE parent_id IS NULL ORDER BY updated_at DESC').all()
    : db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all()) as CardRow[]
  res.json({ cards: rows.map(cardRowToJson) })
})

app.get('/api/agenda', (req, res) => {
  const timezone = typeof req.query.timezone === 'string' ? req.query.timezone.trim() : 'UTC'
  if (!validTimezone(timezone)) return res.status(400).json({ error: 'invalid timezone' })
  const at = typeof req.query.at === 'string' ? req.query.at.trim() : new Date().toISOString()
  if (!validInstant(at)) return res.status(400).json({ error: 'invalid at; use an ISO instant with an offset' })

  const now = new Date(at)
  const todayKey = localDateKey(now, timezone)
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as CardRow[]
  const open = rows.filter((row) => row.lane !== 'DONE')
  const scheduledAt = planningScheduledAt
  const scheduledKey = (row: CardRow) => {
    const value = scheduledAt(row)
    return value ? localDateKey(value, timezone) : null
  }
  const sections = {
    inbox: open.filter(
      (row) => row.parent_id === null && row.lane === 'TRIAGE' && !scheduledAt(row),
    ),
    overdue: open.filter((row) => {
      const key = scheduledKey(row)
      return key !== null && key < todayKey
    }),
    today: open.filter((row) => scheduledKey(row) === todayKey),
    upcoming: open.filter((row) => {
      const key = scheduledKey(row)
      return key !== null && key > todayKey
    }),
    waiting: open.filter((row) => row.lane === 'BLOCKED'),
    done: rows.filter((row) => row.lane === 'DONE').slice(0, 50),
  }

  return res.json({
    timezone,
    generatedAt: now.toISOString(),
    counts: Object.fromEntries(
      Object.entries(sections).map(([name, cards]) => [name, cards.length]),
    ),
    sections: Object.fromEntries(
      Object.entries(sections).map(([name, cards]) => [name, cards.map(cardRowToJson)]),
    ),
  })
})

app.get('/api/review/daily', (req, res) => {
  const timezone = typeof req.query.timezone === 'string' ? req.query.timezone.trim() : 'UTC'
  if (!validTimezone(timezone)) return res.status(400).json({ error: 'invalid timezone' })
  const at = typeof req.query.at === 'string' ? req.query.at.trim() : new Date().toISOString()
  if (!validInstant(at)) return res.status(400).json({ error: 'invalid at; use an ISO instant with an offset' })
  const availableMinutes = req.query.availableMinutes === undefined ? 30 : Number(req.query.availableMinutes)
  if (!Number.isInteger(availableMinutes) || availableMinutes < 5 || availableMinutes > 480) {
    return res.status(400).json({ error: 'availableMinutes must be an integer from 5 to 480' })
  }
  const requestedEnergy =
    typeof req.query.energy === 'string' ? req.query.energy.trim().toUpperCase() : 'ANY'
  if (!['ANY', 'LOW', 'MEDIUM', 'HIGH'].includes(requestedEnergy)) {
    return res.status(400).json({ error: 'energy must be ANY, LOW, MEDIUM, or HIGH' })
  }

  const now = new Date(at)
  const todayKey = localDateKey(now, timezone)
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as CardRow[]
  const open = rows.filter((row) => row.lane !== 'DONE')
  const scheduleKey = (row: CardRow) => {
    const scheduled = planningScheduledAt(row)
    return scheduled ? localDateKey(scheduled, timezone) : null
  }
  const recommendation = reviewRecommendation(
    open,
    now,
    timezone,
    availableMinutes,
    requestedEnergy as ReviewEnergy,
  )
  const overdue = open.filter((row) => {
    const key = scheduleKey(row)
    return key !== null && key < todayKey
  })
  const today = open.filter((row) => scheduleKey(row) === todayKey)
  const inbox = open.filter(
    (row) => row.parent_id === null && row.lane === 'TRIAGE' && !planningScheduledAt(row),
  )
  const waiting = open.filter((row) => row.lane === 'BLOCKED')
  const needsClarity = open
    .filter(
      (row) =>
        row.item_type === 'TASK' &&
        row.lane === 'TRIAGE' &&
        (!row.next_action || row.estimate_minutes === null || row.energy_demand === 'UNKNOWN'),
    )
    .slice(0, 5)

  return res.json({
    timezone,
    generatedAt: now.toISOString(),
    preferences: { availableMinutes, energy: requestedEnergy },
    message:
      recommendation.focus === null
        ? 'Nothing needs your attention right now.'
        : 'One reachable next action is enough.',
    counts: {
      inbox: inbox.length,
      overdue: overdue.length,
      today: today.length,
      waiting: waiting.length,
      needsClarity: needsClarity.length,
    },
    ...recommendation,
    needsClarity: needsClarity.map(cardRowToJson),
  })
})

app.get('/api/review/weekly', (req, res) => {
  const timezone = typeof req.query.timezone === 'string' ? req.query.timezone.trim() : 'UTC'
  if (!validTimezone(timezone)) return res.status(400).json({ error: 'invalid timezone' })
  const at = typeof req.query.at === 'string' ? req.query.at.trim() : new Date().toISOString()
  if (!validInstant(at)) return res.status(400).json({ error: 'invalid at; use an ISO instant with an offset' })

  const now = new Date(at)
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const staleBefore = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as CardRow[]
  const open = rows.filter((row) => row.lane !== 'DONE')
  const wins = rows
    .filter(
      (row) =>
        row.lane === 'DONE' &&
        row.completed_at !== null &&
        new Date(row.completed_at).getTime() >= weekStart.getTime() &&
        new Date(row.completed_at).getTime() <= now.getTime(),
    )
    .slice(0, 20)
  const stale = open
    .filter((row) => {
      const lastTouched = row.reviewed_at || row.updated_at
      return new Date(lastTouched).getTime() < staleBefore.getTime()
    })
    .slice(0, 20)
  const inbox = open.filter((row) => row.parent_id === null && row.lane === 'TRIAGE')
  const waiting = open.filter((row) => row.lane === 'BLOCKED')
  const projects = open.filter((row) => row.item_type === 'PROJECT')
  const unplanned = open
    .filter(
      (row) =>
        row.item_type === 'TASK' &&
        !planningScheduledAt(row) &&
        !row.next_action &&
        row.estimate_minutes === null,
    )
    .slice(0, 20)

  return res.json({
    timezone,
    generatedAt: now.toISOString(),
    window: { start: weekStart.toISOString(), end: now.toISOString() },
    message:
      wins.length > 0
        ? `${wins.length} win${wins.length === 1 ? '' : 's'} this week. Progress counts.`
        : 'A quiet week is not a failed week. Reset from what is true now.',
    counts: {
      wins: wins.length,
      inbox: inbox.length,
      waiting: waiting.length,
      projects: projects.length,
      stale: stale.length,
      unplanned: unplanned.length,
    },
    sections: {
      wins: wins.map(cardRowToJson),
      inbox: inbox.map(cardRowToJson),
      waiting: waiting.map(cardRowToJson),
      projects: projects.map(cardRowToJson),
      stale: stale.map(cardRowToJson),
      unplanned: unplanned.map(cardRowToJson),
    },
  })
})

app.get('/api/cards/:id/structure', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!row) return res.status(404).json({ error: 'card not found' })
  return res.json({ structure: structureForCard(row) })
})

app.get('/api/cards/:id/restart-packet', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const root = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!root) return res.status(404).json({ error: 'card not found' })

  const descendants = db
    .prepare(
      `WITH RECURSIVE tree(id, depth) AS (
         SELECT id, 1 FROM cards WHERE parent_id = ?
         UNION ALL
         SELECT cards.id, tree.depth + 1 FROM cards JOIN tree ON cards.parent_id = tree.id
       )
       SELECT cards.*, tree.depth FROM cards JOIN tree ON cards.id = tree.id`,
    )
    .all(id) as Array<CardRow & { depth: number }>
  const currentMilestone =
    root.item_type === 'MILESTONE' && root.lane !== 'DONE'
      ? root
      : descendants
          .filter((row) => row.item_type === 'MILESTONE' && row.lane !== 'DONE')
          .sort((a, b) => a.depth - b.depth || a.position - b.position || a.id - b.id)[0]
  const taskCandidates = (root.item_type === 'TASK' ? [root] : descendants).filter(
    (row) => row.item_type === 'TASK' && row.lane !== 'DONE',
  )
  const laneRank: Record<Lane, number> = {
    RUNNING: 0,
    READY: 1,
    TODO: 2,
    TRIAGE: 3,
    BLOCKED: 4,
    DONE: 5,
  }
  const nextTask = taskCandidates.sort(
    (a, b) =>
      laneRank[a.lane] - laneRank[b.lane] ||
      priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
      a.position - b.position ||
      a.id - b.id,
  )[0]
  const blockers = (root.item_type === 'TASK' ? [root] : descendants)
    .filter((row) => row.lane === 'BLOCKED')
    .sort((a, b) => a.position - b.position || a.id - b.id)
  const recentlyCompleted = (root.item_type === 'TASK' ? [root] : descendants)
    .filter((row) => row.item_type === 'TASK' && row.lane === 'DONE')
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))
    .slice(0, 5)

  return res.json({
    restartPacket: {
      project: cardRowToJson(root),
      goal: root.goal || root.description || root.acceptance_criteria,
      progress: progressForCard(root),
      currentMilestone: currentMilestone ? cardRowToJson(currentMilestone) : null,
      nextTask: nextTask ? cardRowToJson(nextTask) : null,
      nextAction: nextTask?.next_action || nextTask?.title || root.next_action || null,
      definitionOfDone: nextTask?.acceptance_criteria || null,
      estimatedMinutes: nextTask?.estimate_minutes ?? null,
      continuation: nextTask?.continuation || root.continuation || null,
      evidence: nextTask?.evidence || null,
      blockers: blockers.map(cardRowToJson),
      recentlyCompleted: recentlyCompleted.map(cardRowToJson),
    },
  })
})

app.post('/api/cards/:id/promote', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!existing) return res.status(404).json({ error: 'card not found' })
  if (existing.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed cards cannot be promoted locally' })
  }
  if (existing.parent_id !== null) return res.status(409).json({ error: 'only a root task can become a project' })
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    eventId?: string
    expectedRevision?: number
    goal?: string
  }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'card.promoted' || replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
    res.set('Idempotent-Replay', 'true')
    return res.json({ card: cardRowToJson(card), eventId, idempotentReplay: true })
  }
  if (existing.item_type === 'PROJECT') {
    return res.json({ card: cardRowToJson(existing), alreadyPromoted: true })
  }
  if (existing.item_type !== 'TASK') return res.status(409).json({ error: 'only a task can become a project' })
  if (existing.lane === 'DONE') return res.status(409).json({ error: 'reopen a completed task before promoting it' })
  if (!requireExpectedRevision(res, body.expectedRevision, existing.revision)) return

  const now = new Date().toISOString()
  const updated = db.transaction(() => {
    db.prepare(
      `UPDATE cards SET item_type = 'PROJECT', goal = ?, reviewed_at = ?,
         revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(body.goal?.trim() || existing.goal || existing.description || existing.title, now, now, id)
    logActivity.run(id, 'card.promoted', 'TASK -> PROJECT', now)
    insertEvent.run(
      eventId,
      id,
      'card.promoted',
      existing.lane,
      existing.lane,
      JSON.stringify({ goal: body.goal?.trim() || null, preservedTaskKey: existing.task_key }),
      200,
      now,
    )
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
  })()
  void emitWorkflowHook({ eventId, event: 'card.updated', cardId: id, detail: 'TASK -> PROJECT', lane: updated.lane })
  return res.json({ card: cardRowToJson(updated), eventId })
})

app.post('/api/cards/:id/decompose', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const project = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!project) return res.status(404).json({ error: 'card not found' })
  if (project.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed cards cannot own local decomposition' })
  }
  if (project.item_type !== 'PROJECT') {
    return res.status(409).json({ error: 'promote the root task to a project before decomposing it' })
  }
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    eventId?: string
    expectedRevision?: number
    execute?: boolean
    milestones?: unknown
  }
  const normalized = normalizedDecomposition(body.milestones)
  if ('error' in normalized) return res.status(400).json({ error: normalized.error })

  const eventId = eventIdFor(req, body)
  if (body.execute === true) {
    const replay = existingEvent(eventId)
    if (replay) {
      if (replay.event_type !== 'card.decomposed' || replay.card_id !== id) {
        return res.status(409).json({ error: 'idempotency key already used for another event' })
      }
      const current = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
      res.set('Idempotent-Replay', 'true')
      return res.json({
        ok: true,
        dryRun: false,
        eventId,
        idempotentReplay: true,
        project: cardRowToJson(current),
        structure: structureForCard(current),
      })
    }
  }

  const childCount = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE parent_id = ?').get(id) as {
    count: number
  }
  if (childCount.count > 0) {
    return res.status(409).json({ error: 'project already has child work; add or edit it explicitly' })
  }
  const responseBase = {
    ok: true,
    dryRun: body.execute !== true,
    summary: { milestones: normalized.milestones.length, tasks: normalized.taskCount },
    plan: normalized.milestones,
  }
  if (body.execute !== true) return res.json(responseBase)
  if (!requireExpectedRevision(res, body.expectedRevision, project.revision)) return

  const now = new Date().toISOString()
  const createdCardIds: number[] = []
  const updatedProject = db.transaction(() => {
    for (const [milestoneIndex, milestone] of normalized.milestones.entries()) {
      const milestoneResult = db.prepare(
        `INSERT INTO cards
          (title, description, lane, owner, tags, task_key, priority, source,
           acceptance_criteria, next_action, item_type, parent_id, goal, estimate_minutes,
           position, energy_demand, created_at, updated_at)
         VALUES (?, '', 'TRIAGE', '', '', ?, 'P2', ?, '', '', 'MILESTONE', ?, ?, NULL, ?,
           'UNKNOWN', ?, ?)`,
      ).run(milestone.title, randomUUID(), project.source, id, milestone.goal, milestoneIndex, now, now)
      const milestoneId = Number(milestoneResult.lastInsertRowid)
      createdCardIds.push(milestoneId)
      logActivity.run(milestoneId, 'card.created', milestone.title, now)
      insertEvent.run(
        `${eventId}:milestone:${milestoneIndex + 1}`,
        milestoneId,
        'card.created',
        null,
        'TRIAGE',
        JSON.stringify({ parentId: id, itemType: 'MILESTONE', decompositionEventId: eventId }),
        201,
        now,
      )

      for (const [taskIndex, task] of milestone.tasks.entries()) {
        const taskResult = db.prepare(
          `INSERT INTO cards
            (title, description, lane, owner, tags, task_key, priority, source,
             acceptance_criteria, next_action, item_type, parent_id, goal, estimate_minutes,
             position, energy_demand, created_at, updated_at)
           VALUES (?, '', 'TRIAGE', '', '', ?, ?, ?, ?, ?, 'TASK', ?, '', ?, ?, ?, ?, ?)`,
        ).run(
          task.title,
          randomUUID(),
          task.priority,
          project.source,
          task.acceptanceCriteria,
          task.nextAction,
          milestoneId,
          task.estimateMinutes,
          taskIndex,
          task.energyDemand,
          now,
          now,
        )
        const taskId = Number(taskResult.lastInsertRowid)
        createdCardIds.push(taskId)
        logActivity.run(taskId, 'card.created', task.title, now)
        insertEvent.run(
          `${eventId}:task:${milestoneIndex + 1}:${taskIndex + 1}`,
          taskId,
          'card.created',
          null,
          'TRIAGE',
          JSON.stringify({ parentId: milestoneId, itemType: 'TASK', decompositionEventId: eventId }),
          201,
          now,
        )
      }
    }
    db.prepare(
      `UPDATE cards SET reviewed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(now, now, id)
    logActivity.run(id, 'card.decomposed', `${normalized.milestones.length} milestones, ${normalized.taskCount} tasks`, now)
    insertEvent.run(
      eventId,
      id,
      'card.decomposed',
      project.lane,
      project.lane,
      JSON.stringify({ milestones: normalized.milestones, createdCardIds }),
      200,
      now,
    )
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
  })()

  for (const cardId of createdCardIds) {
    void emitWorkflowHook({ eventId: `${eventId}:card:${cardId}`, event: 'card.created', cardId, lane: 'TRIAGE' })
  }
  return res.json({
    ...responseBase,
    dryRun: false,
    eventId,
    project: cardRowToJson(updatedProject),
    structure: structureForCard(updatedProject),
  })
})

const createCard = async (req: express.Request, res: express.Response) => {
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
    itemType?: ItemType
    parentId?: number | null
    goal?: string
    estimateMinutes?: number | null
    position?: number
    capturedText?: string
    remindAt?: string | null
    reminderTimezone?: string
    energyDemand?: EnergyDemand
    recurrenceFrequency?: RecurrenceFrequency
    recurrenceInterval?: number
    recurrenceEndAt?: string | null
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
  if (body.energyDemand !== undefined && !energyDemands.includes(body.energyDemand)) {
    return res.status(400).json({ error: 'invalid energyDemand' })
  }
  if (
    body.recurrenceFrequency !== undefined &&
    !recurrenceFrequencies.includes(body.recurrenceFrequency)
  ) {
    return res.status(400).json({ error: 'invalid recurrenceFrequency' })
  }
  if (
    body.recurrenceInterval !== undefined &&
    (!Number.isInteger(body.recurrenceInterval) || body.recurrenceInterval < 1 || body.recurrenceInterval > 365)
  ) {
    return res.status(400).json({ error: 'recurrenceInterval must be an integer from 1 to 365' })
  }
  if (body.recurrenceEndAt !== undefined && !validInstant(body.recurrenceEndAt)) {
    return res.status(400).json({ error: 'invalid recurrenceEndAt; use an ISO instant with an offset' })
  }
  if (body.dueAt !== undefined && !validDate(body.dueAt)) {
    return res.status(400).json({
      error: 'invalid dueAt; use YYYY-MM-DD or an ISO instant with an offset',
    })
  }
  if (body.itemType !== undefined && !itemTypes.includes(body.itemType)) {
    return res.status(400).json({ error: 'invalid itemType' })
  }
  if (body.parentId !== undefined && body.parentId !== null && !Number.isInteger(body.parentId)) {
    return res.status(400).json({ error: 'invalid parentId' })
  }
  if (body.estimateMinutes !== undefined && !validNonNegativeInteger(body.estimateMinutes)) {
    return res.status(400).json({ error: 'invalid estimateMinutes' })
  }
  if (body.position !== undefined && !validNonNegativeInteger(body.position)) {
    return res.status(400).json({ error: 'invalid position' })
  }
  if (body.remindAt !== undefined && !validInstant(body.remindAt)) {
    return res.status(400).json({ error: 'invalid remindAt; use an ISO instant with an offset' })
  }
  if (body.reminderTimezone !== undefined && !validTimezone(body.reminderTimezone)) {
    return res.status(400).json({ error: 'invalid reminderTimezone' })
  }
  if (body.remindAt && !body.reminderTimezone) {
    return res.status(400).json({ error: 'reminderTimezone is required with remindAt' })
  }
  const recurrenceFrequency = body.recurrenceFrequency ?? 'NONE'
  if (recurrenceFrequency !== 'NONE' && !body.remindAt) {
    return res.status(400).json({ error: 'recurring reminders require remindAt' })
  }
  if (recurrenceFrequency === 'NONE' && body.recurrenceEndAt) {
    return res.status(400).json({ error: 'recurrenceEndAt requires a recurring reminder' })
  }
  if (
    body.recurrenceEndAt &&
    body.remindAt &&
    new Date(body.recurrenceEndAt).getTime() <= new Date(body.remindAt).getTime()
  ) {
    return res.status(400).json({ error: 'recurrenceEndAt must be after remindAt' })
  }

  const itemType = body.itemType ?? 'TASK'
  const parent =
    body.parentId === undefined || body.parentId === null
      ? undefined
      : (db.prepare('SELECT * FROM cards WHERE id = ?').get(body.parentId) as CardRow | undefined)
  if (body.parentId !== undefined && body.parentId !== null && !parent) {
    return res.status(404).json({ error: 'parent card not found' })
  }
  const invalidHierarchy = hierarchyError(itemType, parent)
  if (invalidHierarchy) return res.status(409).json({ error: invalidHierarchy })

  const eventId = eventIdFor(req, body)
  const createdEventType = body.capturedText?.trim() ? 'card.captured' : 'card.created'
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== createdEventType || replay.card_id === null) {
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
  const recurrenceAnchor =
    recurrenceFrequency !== 'NONE' && body.remindAt && body.reminderTimezone
      ? localDateTimeParts(body.remindAt, body.reminderTimezone.trim())
      : null
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
             started_at, completed_at, revision, item_type, parent_id, goal, estimate_minutes,
             position, captured_text, remind_at, reminder_timezone, reminder_status,
             reminder_acknowledged_at, reviewed_at, energy_demand, recurrence_frequency,
             recurrence_interval, recurrence_end_at, recurrence_anchor_month,
             recurrence_anchor_day, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          itemType,
          parent?.id ?? null,
          body.goal?.trim() ?? '',
          body.estimateMinutes ?? null,
          body.position ?? 0,
          body.capturedText?.trim() ?? '',
          body.remindAt ?? null,
          body.remindAt ? body.reminderTimezone!.trim() : '',
          body.remindAt ? 'PENDING' : 'NONE',
          body.energyDemand ?? 'UNKNOWN',
          recurrenceFrequency,
          body.recurrenceInterval ?? 1,
          body.recurrenceEndAt ?? null,
          recurrenceAnchor?.month ?? 0,
          recurrenceAnchor?.day ?? 0,
          now,
          now,
        )
      const cardId = Number(result.lastInsertRowid)
      logActivity.run(cardId, createdEventType, body.title!.trim(), now)
      insertEvent.run(eventId, cardId, createdEventType, null, lane, JSON.stringify(body), 201, now)
      return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow
    })()
  } catch (error) {
    if (String(error).includes('cards.source, cards.external_id')) {
      return res.status(409).json({ error: 'source and externalId already exist' })
    }
    throw error
  }

  void emitWorkflowHook({ eventId, event: createdEventType, cardId: card.id, lane })

  return res.status(201).json({ card: cardRowToJson(card), eventId })
}

app.post('/api/cards', createCard)

app.post('/api/capture', (req, res) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    text?: string
    title?: string
    source?: string
    itemType?: ItemType
  }
  if (!body.text?.trim()) return res.status(400).json({ error: 'text is required' })
  if (body.itemType !== undefined && body.itemType !== 'TASK') {
    return res.status(409).json({ error: 'quick capture creates tasks; promote it after clarification' })
  }
  req.body = {
    ...req.body,
    title: body.title?.trim() || body.text.trim().split(/\r?\n/, 1)[0],
    capturedText: body.text.trim(),
    source: body.source?.trim() || 'nova',
    itemType: 'TASK',
    lane: 'TRIAGE',
  }
  return createCard(req, res)
})

app.post('/api/cards/:id/snooze', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!existing) return res.status(404).json({ error: 'card not found' })
  if (existing.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed cards cannot be snoozed locally' })
  }
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    eventId?: string
    until?: string
    timezone?: string
    expectedRevision?: number
  }
  if (!validInstant(body.until)) {
    return res.status(400).json({ error: 'invalid until; use a future ISO instant with an offset' })
  }
  if (!validTimezone(body.timezone)) {
    return res.status(400).json({ error: 'invalid timezone' })
  }
  if (new Date(body.until!).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'until must be in the future' })
  }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'reminder.snoozed' || replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
    res.set('Idempotent-Replay', 'true')
    return res.json({ card: cardRowToJson(card), eventId, idempotentReplay: true })
  }
  if (!requireExpectedRevision(res, body.expectedRevision, existing.revision)) return

  const now = new Date().toISOString()
  const updated = db.transaction(() => {
    db.prepare(
      `UPDATE cards SET remind_at = ?, reminder_timezone = ?, reminder_status = 'PENDING',
         reminder_acknowledged_at = NULL, reviewed_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ).run(body.until, body.timezone!.trim(), now, now, id)
    logActivity.run(id, 'reminder.snoozed', body.until, now)
    insertEvent.run(
      eventId,
      id,
      'reminder.snoozed',
      existing.lane,
      existing.lane,
      JSON.stringify({ until: body.until, timezone: body.timezone }),
      200,
      now,
    )
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
  })()
  void emitWorkflowHook({
    eventId,
    event: 'card.updated',
    cardId: id,
    detail: `snoozed until ${body.until}`,
    lane: updated.lane,
  })
  return res.json({ card: cardRowToJson(updated), eventId })
})

app.post('/api/cards/:id/reminders/acknowledge', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!existing) return res.status(404).json({ error: 'card not found' })
  if (existing.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed reminders cannot be acknowledged locally' })
  }
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    eventId?: string
    expectedRevision?: number
  }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'reminder.acknowledged' || replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
    res.set('Idempotent-Replay', 'true')
    return res.json({ card: cardRowToJson(card), eventId, idempotentReplay: true })
  }
  if (existing.reminder_status !== 'PENDING' && existing.reminder_status !== 'DELIVERED') {
    return res.status(409).json({ error: 'reminder is not awaiting acknowledgement' })
  }
  if (!requireExpectedRevision(res, body.expectedRevision, existing.revision)) return

  const now = new Date().toISOString()
  let nextRemindAt: string | null = null
  let seriesComplete = false
  if (existing.recurrence_frequency !== 'NONE' && existing.remind_at) {
    nextRemindAt = nextRecurringInstant(
      existing.remind_at,
      existing.reminder_timezone,
      existing.recurrence_frequency,
      existing.recurrence_interval,
      existing.recurrence_anchor_month,
      existing.recurrence_anchor_day,
    )
    if (
      existing.recurrence_end_at &&
      new Date(nextRemindAt).getTime() > new Date(existing.recurrence_end_at).getTime()
    ) {
      nextRemindAt = null
      seriesComplete = true
    }
  }
  const nextStatus: ReminderStatus = nextRemindAt ? 'PENDING' : 'ACKNOWLEDGED'
  const occurrence = existing.recurrence_occurrences + 1
  const updated = db.transaction(() => {
    db.prepare(
      `UPDATE cards SET remind_at = ?, reminder_status = ?, reminder_acknowledged_at = ?,
         recurrence_occurrences = ?, reviewed_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ).run(nextRemindAt ?? existing.remind_at, nextStatus, now, occurrence, now, now, id)
    logActivity.run(
      id,
      'reminder.acknowledged',
      nextRemindAt ? `next occurrence ${nextRemindAt}` : seriesComplete ? 'series complete' : 'one-time reminder',
      now,
    )
    insertEvent.run(
      eventId,
      id,
      'reminder.acknowledged',
      existing.lane,
      existing.lane,
      JSON.stringify({
        acknowledgedRemindAt: existing.remind_at,
        nextRemindAt,
        occurrence,
        recurrenceFrequency: existing.recurrence_frequency,
        seriesComplete,
      }),
      200,
      now,
    )
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
  })()
  void emitWorkflowHook({
    eventId,
    event: 'card.updated',
    cardId: id,
    detail: nextRemindAt ? `next reminder ${nextRemindAt}` : 'reminder acknowledged',
    lane: updated.lane,
  })
  return res.json({
    card: cardRowToJson(updated),
    eventId,
    nextRemindAt,
    seriesComplete,
  })
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
    goal?: string
    estimateMinutes?: number | null
    remindAt?: string | null
    reminderTimezone?: string
    reminderStatus?: ReminderStatus
    reviewedAt?: string | null
    energyDemand?: EnergyDemand
    recurrenceFrequency?: RecurrenceFrequency
    recurrenceInterval?: number
    recurrenceEndAt?: string | null
    expectedRevision?: number
  }

  if (body.lane !== undefined && !lanes.includes(body.lane)) {
    return res.status(400).json({ error: 'invalid lane' })
  }
  if (body.priority !== undefined && !priorities.includes(body.priority)) {
    return res.status(400).json({ error: 'invalid priority' })
  }
  if (body.energyDemand !== undefined && !energyDemands.includes(body.energyDemand)) {
    return res.status(400).json({ error: 'invalid energyDemand' })
  }
  if (
    body.recurrenceFrequency !== undefined &&
    !recurrenceFrequencies.includes(body.recurrenceFrequency)
  ) {
    return res.status(400).json({ error: 'invalid recurrenceFrequency' })
  }
  if (
    body.recurrenceInterval !== undefined &&
    (!Number.isInteger(body.recurrenceInterval) || body.recurrenceInterval < 1 || body.recurrenceInterval > 365)
  ) {
    return res.status(400).json({ error: 'recurrenceInterval must be an integer from 1 to 365' })
  }
  if (body.recurrenceEndAt !== undefined && !validInstant(body.recurrenceEndAt)) {
    return res.status(400).json({ error: 'invalid recurrenceEndAt; use an ISO instant with an offset' })
  }
  if (body.dueAt !== undefined && !validDate(body.dueAt)) {
    return res.status(400).json({
      error: 'invalid dueAt; use YYYY-MM-DD or an ISO instant with an offset',
    })
  }
  if (body.estimateMinutes !== undefined && !validNonNegativeInteger(body.estimateMinutes)) {
    return res.status(400).json({ error: 'invalid estimateMinutes' })
  }
  if (body.remindAt !== undefined && !validInstant(body.remindAt)) {
    return res.status(400).json({ error: 'invalid remindAt; use an ISO instant with an offset' })
  }
  if (body.reminderTimezone !== undefined && !validTimezone(body.reminderTimezone)) {
    return res.status(400).json({ error: 'invalid reminderTimezone' })
  }
  if (body.reminderStatus !== undefined && !reminderStatuses.includes(body.reminderStatus)) {
    return res.status(400).json({ error: 'invalid reminderStatus' })
  }
  if (body.reviewedAt !== undefined && !validInstant(body.reviewedAt)) {
    return res.status(400).json({ error: 'invalid reviewedAt; use an ISO instant with an offset' })
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

  if (!requireExpectedRevision(res, body.expectedRevision, existing.revision)) return

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
  const nextRemindAt = body.remindAt === undefined ? existing.remind_at : body.remindAt
  const nextReminderTimezone =
    body.reminderTimezone === undefined
      ? body.remindAt === null
        ? ''
        : existing.reminder_timezone
      : body.reminderTimezone.trim()
  const nextReminderStatus =
    body.reminderStatus ??
    (body.remindAt === null ? 'NONE' : body.remindAt !== undefined ? 'PENDING' : existing.reminder_status)
  const nextRecurrenceFrequency = body.recurrenceFrequency ?? existing.recurrence_frequency
  const nextRecurrenceInterval = body.recurrenceInterval ?? existing.recurrence_interval
  const nextRecurrenceEndAt =
    body.recurrenceEndAt === undefined
      ? body.recurrenceFrequency === 'NONE'
        ? null
        : existing.recurrence_end_at
      : body.recurrenceEndAt
  if (nextRemindAt && !nextReminderTimezone) {
    return res.status(400).json({ error: 'reminderTimezone is required with remindAt' })
  }
  if (nextReminderStatus !== 'NONE' && !nextRemindAt) {
    return res.status(400).json({ error: 'a reminder status requires remindAt' })
  }
  if (nextReminderStatus === 'NONE' && nextRemindAt) {
    return res.status(400).json({ error: 'clear remindAt before setting reminderStatus to NONE' })
  }
  if (nextRecurrenceFrequency !== 'NONE' && !nextRemindAt) {
    return res.status(400).json({ error: 'recurring reminders require remindAt' })
  }
  if (nextRecurrenceFrequency === 'NONE' && nextRecurrenceEndAt) {
    return res.status(400).json({ error: 'recurrenceEndAt requires a recurring reminder' })
  }
  if (nextRecurrenceFrequency !== 'NONE' && body.reminderStatus === 'ACKNOWLEDGED') {
    return res.status(409).json({
      error: 'acknowledge recurring reminders with the reminder acknowledgement endpoint',
    })
  }
  if (
    nextRecurrenceEndAt &&
    nextRemindAt &&
    new Date(nextRecurrenceEndAt).getTime() <= new Date(nextRemindAt).getTime()
  ) {
    return res.status(400).json({ error: 'recurrenceEndAt must be after remindAt' })
  }
  const nextReminderAcknowledgedAt =
    nextReminderStatus === 'ACKNOWLEDGED'
      ? existing.reminder_acknowledged_at ?? now
      : nextReminderStatus === 'PENDING' || nextReminderStatus === 'NONE'
        ? null
        : existing.reminder_acknowledged_at
  const nextRecurrenceAnchor =
    nextRecurrenceFrequency === 'NONE'
      ? { month: 0, day: 0 }
      : body.remindAt !== undefined || existing.recurrence_anchor_day === 0
        ? localDateTimeParts(nextRemindAt!, nextReminderTimezone)
        : {
            month: existing.recurrence_anchor_month,
            day: existing.recurrence_anchor_day,
          }
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
           goal = ?, estimate_minutes = ?, remind_at = ?, reminder_timezone = ?,
           reminder_status = ?, reminder_acknowledged_at = ?, reviewed_at = ?, energy_demand = ?,
           recurrence_frequency = ?, recurrence_interval = ?, recurrence_end_at = ?,
           recurrence_anchor_month = ?, recurrence_anchor_day = ?,
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
        body.goal?.trim() ?? existing.goal,
        body.estimateMinutes === undefined ? existing.estimate_minutes : body.estimateMinutes,
        nextRemindAt,
        nextReminderTimezone,
        nextReminderStatus,
        nextReminderAcknowledgedAt,
        body.reviewedAt === undefined ? existing.reviewed_at : body.reviewedAt,
        body.energyDemand ?? existing.energy_demand,
        nextRecurrenceFrequency,
        nextRecurrenceInterval,
        nextRecurrenceEndAt,
        nextRecurrenceAnchor.month,
        nextRecurrenceAnchor.day,
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

app.post('/api/cards/:id/checklist', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!card) return res.status(404).json({ error: 'card not found' })
  if (card.source === 'loopx') {
    return res.status(409).json({ error: 'LoopX-managed cards cannot own local checklist items' })
  }
  if (card.item_type !== 'TASK') {
    return res.status(409).json({ error: 'checklist items belong to tasks only' })
  }

  const body = req.body as {
    eventId?: string
    text?: string
    position?: number
    expectedRevision?: number
  }
  if (!body.text?.trim()) return res.status(400).json({ error: 'text is required' })
  if (body.position !== undefined && !validNonNegativeInteger(body.position)) {
    return res.status(400).json({ error: 'invalid position' })
  }
  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (replay.event_type !== 'checklist.created' || replay.card_id !== id) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    res.set('Idempotent-Replay', 'true')
    return res.json({ structure: structureForCard(card), eventId, idempotentReplay: true })
  }
  if (!requireExpectedRevision(res, body.expectedRevision, card.revision)) return

  const now = new Date().toISOString()
  const defaultPosition = (
    db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM checklist_items WHERE card_id = ?').get(id) as {
      position: number
    }
  ).position
  let item: ChecklistRow
  db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO checklist_items
          (card_id, text, is_done, position, revision, created_at, updated_at)
         VALUES (?, ?, 0, ?, 1, ?, ?)`,
      )
      .run(id, body.text!.trim(), body.position ?? defaultPosition, now, now)
    const checklistId = Number(inserted.lastInsertRowid)
    db.prepare('UPDATE cards SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, id)
    logActivity.run(id, 'checklist.created', body.text!.trim(), now)
    insertEvent.run(
      eventId,
      id,
      'checklist.created',
      card.lane,
      card.lane,
      JSON.stringify({ checklistId, text: body.text!.trim() }),
      201,
      now,
    )
    item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(checklistId) as ChecklistRow
  })()
  const updatedCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
  return res.status(201).json({ item: checklistRowToJson(item!), card: cardRowToJson(updatedCard), eventId })
})

app.patch('/api/checklist-items/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' })
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id) as ChecklistRow | undefined
  if (!item) return res.status(404).json({ error: 'checklist item not found' })
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id) as CardRow
  const body = req.body as {
    eventId?: string
    text?: string
    isDone?: boolean
    position?: number
    expectedRevision?: number
  }
  if (body.text !== undefined && !body.text.trim()) {
    return res.status(400).json({ error: 'text cannot be empty' })
  }
  if (body.isDone !== undefined && typeof body.isDone !== 'boolean') {
    return res.status(400).json({ error: 'isDone must be boolean' })
  }
  if (body.position !== undefined && !validNonNegativeInteger(body.position)) {
    return res.status(400).json({ error: 'invalid position' })
  }
  if (body.text === undefined && body.isDone === undefined && body.position === undefined) {
    return res.status(400).json({ error: 'no checklist changes supplied' })
  }

  const eventId = eventIdFor(req, body)
  const replay = existingEvent(eventId)
  if (replay) {
    if (
      replay.event_type !== 'checklist.updated' ||
      replay.card_id !== card.id ||
      eventPayload(replay).checklistId !== id
    ) {
      return res.status(409).json({ error: 'idempotency key already used for another event' })
    }
    const current = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id) as ChecklistRow
    res.set('Idempotent-Replay', 'true')
    return res.json({ item: checklistRowToJson(current), eventId, idempotentReplay: true })
  }
  if (!requireExpectedRevision(res, body.expectedRevision, item.revision)) return

  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(
      `UPDATE checklist_items SET text = ?, is_done = ?, position = ?,
       revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(
      body.text?.trim() ?? item.text,
      body.isDone === undefined ? item.is_done : body.isDone ? 1 : 0,
      body.position ?? item.position,
      now,
      id,
    )
    db.prepare('UPDATE cards SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
      now,
      card.id,
    )
    const detail = body.isDone === undefined ? 'checklist fields updated' : body.isDone ? 'completed' : 'reopened'
    logActivity.run(card.id, 'checklist.updated', `${item.text}: ${detail}`, now)
    insertEvent.run(
      eventId,
      card.id,
      'checklist.updated',
      card.lane,
      card.lane,
      JSON.stringify({ checklistId: id, ...body }),
      200,
      now,
    )
  })()
  const updated = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id) as ChecklistRow
  const updatedCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) as CardRow
  return res.json({ item: checklistRowToJson(updated), card: cardRowToJson(updatedCard), eventId })
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
  const childCount = (
    db.prepare('SELECT COUNT(*) AS count FROM cards WHERE parent_id = ?').get(id) as { count: number }
  ).count
  if (childCount > 0) {
    return res.status(409).json({ error: 'card has child work; complete or move children before deleting it' })
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
    if (reminderHookUrl) {
      console.log(`reminder delivery enabled (polling every ${reminderPollMs}ms)`)
      void runReminderPoll().catch((error) => console.error('reminder poll failed', error))
      const reminderTimer = setInterval(() => {
        void runReminderPoll().catch((error) => console.error('reminder poll failed', error))
      }, reminderPollMs)
      reminderTimer.unref()
    }
  })
}
