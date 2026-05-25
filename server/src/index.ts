import cors from 'cors'
import Database from 'better-sqlite3'
import express from 'express'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

type CardRow = {
  id: number
  title: string
  description: string
  lane: Lane
  owner: string
  tags: string
  created_at: string
  updated_at: string
}

const runMigration = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lane TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(card_id) REFERENCES cards(id)
    );
  `)

  const cardColumns = (db.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>).map(
    (col) => col.name,
  )

  if (!cardColumns.includes('description')) {
    db.exec("ALTER TABLE cards ADD COLUMN description TEXT NOT NULL DEFAULT ''")
  }

  if (!cardColumns.includes('owner')) {
    db.exec("ALTER TABLE cards ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
  }

  if (!cardColumns.includes('tags')) {
    db.exec("ALTER TABLE cards ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
  }

  // Normalize legacy lane names into the current lane set.
  db.exec(`
    UPDATE cards SET lane = 'TODO' WHERE lane IN ('Backlog', 'TODO');
    UPDATE cards SET lane = 'RUNNING' WHERE lane IN ('In Progress', 'RUNNING');
    UPDATE cards SET lane = 'BLOCKED' WHERE lane IN ('Blocked', 'BLOCKED');
    UPDATE cards SET lane = 'DONE' WHERE lane IN ('Done', 'DONE');
    UPDATE cards SET lane = 'TRIAGE' WHERE lane IN ('Triage', 'TRIAGE');
  `)
}

runMigration()
const startupIntegrity = runIntegrityCheck()

const cardRowToJson = (row: CardRow) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  lane: row.lane,
  owner: row.owner,
  tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const logActivity = db.prepare(
  'INSERT INTO activity_log (card_id, action, detail, created_at) VALUES (?, ?, ?, ?)',
)

const emitWorkflowHook = async (event: {
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
    res.json({ ok: true, service: 'openclaw-kanban-api', dbIntegrity: integrity })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ ok: false, service: 'openclaw-kanban-api', dbIntegrity: { ok: false, detail: message } })
  }
})

app.get('/api/lanes', (_req, res) => {
  res.json({ lanes })
})

app.get('/api/cards', (_req, res) => {
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all() as CardRow[]
  res.json({ cards: rows.map(cardRowToJson) })
})

app.post('/api/cards', async (req, res) => {
  const body = req.body as {
    title?: string
    description?: string
    lane?: Lane
    owner?: string
    tags?: string[]
  }

  if (!body.title || !body.title.trim()) {
    return res.status(400).json({ error: 'title is required' })
  }

  const lane = body.lane && lanes.includes(body.lane) ? body.lane : 'TRIAGE'
  const now = new Date().toISOString()
  const tags = (body.tags ?? []).map((t) => t.trim()).filter(Boolean).join(',')

  const result = db
    .prepare(
      `INSERT INTO cards (title, description, lane, owner, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.title.trim(),
      body.description?.trim() ?? '',
      lane,
      body.owner?.trim() ?? '',
      tags,
      now,
      now,
    )

  logActivity.run(result.lastInsertRowid, 'card.created', body.title.trim(), now)
  void emitWorkflowHook({ event: 'card.created', cardId: Number(result.lastInsertRowid), lane })

  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid) as CardRow

  return res.status(201).json({ card: cardRowToJson(card) })
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

  const body = req.body as {
    title?: string
    description?: string
    lane?: Lane
    owner?: string
    tags?: string[]
  }

  const nextLane = body.lane && lanes.includes(body.lane) ? body.lane : existing.lane
  const nextTitle = body.title?.trim() ? body.title.trim() : existing.title
  const nextDescription = body.description?.trim() ?? existing.description
  const nextOwner = body.owner?.trim() ?? existing.owner
  const nextTags = body.tags ? body.tags.map((t) => t.trim()).filter(Boolean).join(',') : existing.tags
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE cards
     SET title = ?, description = ?, lane = ?, owner = ?, tags = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextTitle, nextDescription, nextLane, nextOwner, nextTags, now, id)

  const wasMoved = existing.lane !== nextLane
  const detail = wasMoved ? `${existing.lane} -> ${nextLane}` : 'fields updated'
  logActivity.run(id, wasMoved ? 'card.moved' : 'card.updated', detail, now)

  void emitWorkflowHook({
    event: wasMoved ? 'card.moved' : 'card.updated',
    cardId: id,
    detail,
    lane: nextLane,
  })

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow

  return res.json({ card: cardRowToJson(updated) })
})

app.delete('/api/cards/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const existing = db.prepare('SELECT id FROM cards WHERE id = ?').get(id) as { id: number } | undefined
  if (!existing) {
    return res.status(404).json({ error: 'card not found' })
  }

  const now = new Date().toISOString()
  const removeCard = db.transaction((cardId: number) => {
    db.prepare('DELETE FROM activity_log WHERE card_id = ?').run(cardId)
    db.prepare('DELETE FROM cards WHERE id = ?').run(cardId)
  })

  removeCard(id)
  logActivity.run(null, 'card.deleted', `card:${id}`, now)
  void emitWorkflowHook({ event: 'card.deleted', cardId: id })

  return res.status(204).send()
})

app.get('/api/activity', (_req, res) => {
  const rows = db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50').all()
  res.json({ activity: rows })
})

if (process.env.NODE_ENV !== 'test') {
  console.log(`db integrity check: ${startupIntegrity.detail}`)
  app.listen(PORT, () => {
    console.log(`openclaw-kanban api listening on http://localhost:${PORT}`)
  })
}
