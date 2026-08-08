import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export type GentleNudgeCadence = 'TODAY' | 'OVERDUE' | 'WEEK' | 'MONTH' | 'LATER' | 'UNDATED'

export type GentleNudgeCardRow = {
  id: number
  due_at: string | null
  updated_at: string
  reviewed_at: string | null
}

export type GentleNudgeSerializedCard = {
  id: number
  taskKey: string
  title: string
  lane: string
  priority: string
  dueAt: string | null
  nextAction: string
  [key: string]: unknown
}

type GentleNudgeStateRow = {
  card_id: number
  last_nudged_at: string
  nudge_count: number
}

type GentleNudgeReceiptRow = {
  nudge_id: string
  timezone: string
  window_key: string
  status: 'ATTEMPTING' | 'FAILED' | 'DELIVERED'
  item_count: number
  card_ids: string
  message: string
  payload: string | null
  attempt_count: number
  last_attempt_at: string | null
  delivered_at: string | null
  response_status: number | null
  error: string | null
  created_at: string
  updated_at: string
}

export type GentleNudgeItem<TCard extends GentleNudgeSerializedCard> = {
  card: TCard
  cadence: GentleNudgeCadence
  reason: string
}

export type GentleNudgePlan<TCard extends GentleNudgeSerializedCard> = {
  generatedAt: string
  timezone: string
  quietHours: { startHour: number; endHour: number; active: boolean }
  windowKey: string
  nudgeId: string
  message: string | null
  items: GentleNudgeItem<TCard>[]
  overflowCount: number
}

type GentleNudgeWebhookPayload = {
  event: 'gentle_nudge.due'
  nudgeId: string
  timestamp: string
  timezone: string
  message: string
  overflowCount: number
  items: Array<{
    id: number
    taskKey: string
    title: string
    lane: string
    priority: string
    dueAt: string | null
    nextAction: string
    cadence: GentleNudgeCadence
    reason: string
  }>
}

type GentleNudgeDeliverySnapshot<TCard extends GentleNudgeSerializedCard> = {
  plan: GentleNudgePlan<TCard>
  cardIds: number[]
  webhook: GentleNudgeWebhookPayload
}

type GentleNudgeConfig = {
  hookUrl?: string
  hookToken?: string
  timeoutMs: number
  pollMs: number
  timezone: string
  quietStartHour: number
  quietEndHour: number
}

type GentleNudgeDependencies<
  TRow extends GentleNudgeCardRow,
  TCard extends GentleNudgeSerializedCard,
> = {
  db: Database.Database
  config: GentleNudgeConfig
  serializeCard: (row: TRow) => TCard
  localDateKey: (instant: string | Date, timezone: string) => string
  planningDateKey: (value: string, timezone: string) => string
  localHour: (instant: string | Date, timezone: string) => number
}

const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs
const gentleNudgeIntervals: Record<GentleNudgeCadence, number> = {
  TODAY: 3 * hourMs,
  OVERDUE: dayMs,
  WEEK: dayMs,
  MONTH: 7 * dayMs,
  LATER: 30 * dayMs,
  UNDATED: 7 * dayMs,
}

const calendarDayNumber = (key: string) => Date.parse(`${key}T00:00:00.000Z`) / dayMs

const nudgeReason = (cadence: GentleNudgeCadence) => {
  if (cadence === 'TODAY') return 'It is on today’s list and has no alert time.'
  if (cadence === 'OVERDUE') return 'It is still open from an earlier day; this is information, not failure.'
  if (cadence === 'WEEK') return 'It is coming up within seven days.'
  if (cadence === 'MONTH') return 'It is coming up within the next month.'
  if (cadence === 'LATER') return 'It is a longer-range item worth keeping visible occasionally.'
  return 'It is an undated captured note that has been quiet for a week.'
}

const gentleNudgeMessage = <TCard extends GentleNudgeSerializedCard>(
  items: GentleNudgeItem<TCard>[],
  overflowCount: number,
) => {
  if (items.length === 0) return null
  if (items.length === 1 && overflowCount === 0) {
    return `Gentle reminder: ${items[0]!.card.title} is still on your list. No pressure—would you like to handle it, move it, or leave it for later?`
  }
  const total = items.length + overflowCount
  return `You have ${total} reminders waiting. Want to choose one, move something, or leave them for later?`
}

const receiptToJson = (row: GentleNudgeReceiptRow) => ({
  nudgeId: row.nudge_id,
  timezone: row.timezone,
  windowKey: row.window_key,
  status: row.status,
  itemCount: row.item_count,
  cardIds: JSON.parse(row.card_ids) as number[],
  message: row.message,
  attemptCount: row.attempt_count,
  lastAttemptAt: row.last_attempt_at,
  deliveredAt: row.delivered_at,
  responseStatus: row.response_status,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const deliveryHeaders = (token: string | undefined, idempotencyKey: string) => ({
  'Content-Type': 'application/json',
  'Idempotency-Key': idempotencyKey,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

export const createGentleNudgeService = <
  TRow extends GentleNudgeCardRow,
  TCard extends GentleNudgeSerializedCard,
>({
  db,
  config,
  serializeCard,
  localDateKey,
  planningDateKey,
  localHour,
}: GentleNudgeDependencies<TRow, TCard>) => {
  const isQuietHour = (hour: number) =>
    config.quietStartHour > config.quietEndHour
      ? hour >= config.quietStartHour || hour < config.quietEndHour
      : hour >= config.quietStartHour && hour < config.quietEndHour

  const cadenceForCard = (row: TRow, todayKey: string, timezone: string): GentleNudgeCadence => {
    if (!row.due_at) return 'UNDATED'
    const dueKey = planningDateKey(row.due_at, timezone)
    const daysUntilDue = calendarDayNumber(dueKey) - calendarDayNumber(todayKey)
    if (daysUntilDue < 0) return 'OVERDUE'
    if (daysUntilDue === 0) return 'TODAY'
    if (daysUntilDue <= 7) return 'WEEK'
    if (daysUntilDue <= 31) return 'MONTH'
    return 'LATER'
  }

  const plan = (at: string, timezone = config.timezone): GentleNudgePlan<TCard> => {
    const now = new Date(at)
    const todayKey = localDateKey(now, timezone)
    const hour = localHour(now, timezone)
    const quiet = isQuietHour(hour)
    const bucket = Math.max(0, Math.floor((hour - config.quietEndHour) / 3))
    const windowKey = `${todayKey}:${bucket}`
    const nudgeId = `kanban-nudge-${createHash('sha256')
      .update(`${timezone}:${windowKey}`)
      .digest('hex')
      .slice(0, 32)}`

    if (quiet) {
      return {
        generatedAt: now.toISOString(),
        timezone,
        quietHours: { startHour: config.quietStartHour, endHour: config.quietEndHour, active: true },
        windowKey,
        nudgeId,
        message: null,
        items: [],
        overflowCount: 0,
      }
    }

    const rows = db
      .prepare(
        `SELECT * FROM cards
         WHERE lane NOT IN ('DONE', 'BLOCKED')
           AND item_type = 'TASK'
           AND (remind_at IS NULL OR reminder_status = 'NONE')
           AND (due_at IS NOT NULL OR (source = 'nova' AND captured_text != ''))
         ORDER BY due_at IS NULL ASC, due_at ASC, priority ASC, id ASC`,
      )
      .all() as TRow[]
    const states = new Map(
      (db.prepare('SELECT * FROM gentle_nudge_state').all() as GentleNudgeStateRow[]).map((row) => [
        row.card_id,
        row,
      ]),
    )

    const eligible = rows
      .map((row) => {
        const cadence = cadenceForCard(row, todayKey, timezone)
        const state = states.get(row.id)
        const recentTimes = [row.updated_at, row.reviewed_at, state?.last_nudged_at]
          .filter((value): value is string => Boolean(value))
          .map((value) => new Date(value).getTime())
        const mostRecent = Math.max(...recentTimes)
        return { row, cadence, eligible: now.getTime() - mostRecent >= gentleNudgeIntervals[cadence] }
      })
      .filter((candidate) => candidate.eligible)

    const visible = eligible.slice(0, 8)
    const items = visible.map(({ row, cadence }) => ({
      card: serializeCard(row),
      cadence,
      reason: nudgeReason(cadence),
    }))
    const overflowCount = Math.max(0, eligible.length - visible.length)
    return {
      generatedAt: now.toISOString(),
      timezone,
      quietHours: { startHour: config.quietStartHour, endHour: config.quietEndHour, active: false },
      windowKey,
      nudgeId,
      message: gentleNudgeMessage(items, overflowCount),
      items,
      overflowCount,
    }
  }

  const makeSnapshot = (
    currentPlan: GentleNudgePlan<TCard>,
    timestamp: string,
  ): GentleNudgeDeliverySnapshot<TCard> => {
    const message = currentPlan.message!
    const cardIds = currentPlan.items.map((item) => item.card.id)
    return {
      plan: currentPlan,
      cardIds,
      webhook: {
        event: 'gentle_nudge.due',
        nudgeId: currentPlan.nudgeId,
        timestamp,
        timezone: currentPlan.timezone,
        message,
        overflowCount: currentPlan.overflowCount,
        items: currentPlan.items.map((item) => ({
          id: item.card.id,
          taskKey: item.card.taskKey,
          title: item.card.title,
          lane: item.card.lane,
          priority: item.card.priority,
          dueAt: item.card.dueAt,
          nextAction: item.card.nextAction,
          cadence: item.cadence,
          reason: item.reason,
        })),
      },
    }
  }

  type PollResult = GentleNudgePlan<TCard> & {
    ok: true
    dryRun: boolean
    summary: { eligible: number; delivered: number; failed: number }
    receipt?: ReturnType<typeof receiptToJson>
  }

  const executePoll = async (at: string, timezone: string): Promise<PollResult> => {
    const currentPlan = plan(at, timezone)
    let receipt = db
      .prepare('SELECT * FROM gentle_nudge_receipts WHERE nudge_id = ?')
      .get(currentPlan.nudgeId) as GentleNudgeReceiptRow | undefined

    if (receipt?.status === 'DELIVERED') {
      return { ...currentPlan, ok: true, dryRun: false, summary: { eligible: 0, delivered: 0, failed: 0 } }
    }
    if (!receipt && (currentPlan.items.length === 0 || !currentPlan.message)) {
      return { ...currentPlan, ok: true, dryRun: false, summary: { eligible: 0, delivered: 0, failed: 0 } }
    }

    const attemptAt = new Date().toISOString()
    if (!receipt) {
      const snapshot = makeSnapshot(currentPlan, attemptAt)
      db.prepare(
        `INSERT OR IGNORE INTO gentle_nudge_receipts
          (nudge_id, timezone, window_key, status, item_count, card_ids, message, payload,
           attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, 'FAILED', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        currentPlan.nudgeId,
        timezone,
        currentPlan.windowKey,
        snapshot.cardIds.length + currentPlan.overflowCount,
        JSON.stringify(snapshot.cardIds),
        currentPlan.message,
        JSON.stringify(snapshot),
        attemptAt,
        attemptAt,
      )
      receipt = db
        .prepare('SELECT * FROM gentle_nudge_receipts WHERE nudge_id = ?')
        .get(currentPlan.nudgeId) as GentleNudgeReceiptRow
    }

    // Receipts created before the payload-snapshot migration can still retry. New receipts always
    // reuse this stored snapshot, so edits between attempts cannot change the delivered digest.
    let snapshot = receipt.payload
      ? (JSON.parse(receipt.payload) as GentleNudgeDeliverySnapshot<TCard>)
      : makeSnapshot(currentPlan, receipt.created_at)
    if (!receipt.payload) {
      const frozenIds = JSON.parse(receipt.card_ids) as number[]
      snapshot = {
        ...snapshot,
        cardIds: frozenIds,
        plan: { ...snapshot.plan, message: receipt.message },
        webhook: { ...snapshot.webhook, message: receipt.message },
      }
      db.prepare('UPDATE gentle_nudge_receipts SET payload = ? WHERE nudge_id = ?').run(
        JSON.stringify(snapshot),
        receipt.nudge_id,
      )
    }

    db.prepare(
      `UPDATE gentle_nudge_receipts
       SET status = 'ATTEMPTING', attempt_count = attempt_count + 1,
           last_attempt_at = ?, response_status = NULL, error = NULL, updated_at = ?
       WHERE nudge_id = ? AND status != 'DELIVERED'`,
    ).run(attemptAt, attemptAt, receipt.nudge_id)

    let responseStatus: number | null = null
    let deliveryError: string | null = null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const response = await fetch(config.hookUrl!, {
          method: 'POST',
          headers: deliveryHeaders(config.hookToken, receipt.nudge_id),
          signal: controller.signal,
          body: JSON.stringify(snapshot.webhook),
        })
        responseStatus = response.status
        if (!response.ok) deliveryError = `nudge hook returned HTTP ${response.status}`
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
          `UPDATE gentle_nudge_receipts
           SET status = 'DELIVERED', delivered_at = ?, response_status = ?, error = NULL, updated_at = ?
           WHERE nudge_id = ?`,
        ).run(deliveredAt, responseStatus, deliveredAt, receipt!.nudge_id)
        const upsertState = db.prepare(
          `INSERT INTO gentle_nudge_state (card_id, last_nudged_at, nudge_count)
           VALUES (?, ?, 1)
           ON CONFLICT(card_id) DO UPDATE SET
             last_nudged_at = excluded.last_nudged_at,
             nudge_count = gentle_nudge_state.nudge_count + 1`,
        )
        for (const cardId of snapshot.cardIds) upsertState.run(cardId, at)
      })()
    } else {
      const failedAt = new Date().toISOString()
      db.prepare(
        `UPDATE gentle_nudge_receipts
         SET status = 'FAILED', response_status = ?, error = ?, updated_at = ?
         WHERE nudge_id = ?`,
      ).run(responseStatus, deliveryError.slice(0, 1000), failedAt, receipt.nudge_id)
    }

    const updatedReceipt = db
      .prepare('SELECT * FROM gentle_nudge_receipts WHERE nudge_id = ?')
      .get(receipt.nudge_id) as GentleNudgeReceiptRow
    return {
      ...snapshot.plan,
      ok: true,
      dryRun: false,
      summary: {
        eligible: updatedReceipt.item_count,
        delivered: deliveryError === null ? 1 : 0,
        failed: deliveryError === null ? 0 : 1,
      },
      receipt: receiptToJson(updatedReceipt),
    }
  }

  let pollInFlight: Promise<PollResult> | null = null
  const runPoll = (at = new Date().toISOString(), timezone = config.timezone) => {
    if (!pollInFlight) {
      pollInFlight = executePoll(at, timezone).finally(() => {
        pollInFlight = null
      })
    }
    return pollInFlight
  }

  const status = (at: string, timezone = config.timezone) => {
    const currentPlan = plan(at, timezone)
    const receipts = db
      .prepare('SELECT * FROM gentle_nudge_receipts ORDER BY id DESC LIMIT 20')
      .all() as GentleNudgeReceiptRow[]
    return {
      configured: Boolean(config.hookUrl),
      pollMs: config.pollMs,
      ...currentPlan,
      summary: { eligible: currentPlan.items.length + currentPlan.overflowCount },
      latestReceipts: receipts.map(receiptToJson),
    }
  }

  const requiresDelivery = (currentPlan: GentleNudgePlan<TCard>) => {
    if (currentPlan.items.length > 0 && currentPlan.message) return true
    const receipt = db
      .prepare('SELECT status FROM gentle_nudge_receipts WHERE nudge_id = ?')
      .get(currentPlan.nudgeId) as Pick<GentleNudgeReceiptRow, 'status'> | undefined
    return Boolean(receipt && receipt.status !== 'DELIVERED')
  }

  return { plan, runPoll, status, requiresDelivery }
}
