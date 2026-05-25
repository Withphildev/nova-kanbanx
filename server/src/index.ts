import cors from 'cors'
import Database from 'better-sqlite3'
import express from 'express'

const PORT = Number(process.env.PORT ?? 3001)
const db = new Database('kanban.db')

const app = express()
app.use(cors())
app.use(express.json())

const lanes = ['Backlog', 'In Progress', 'Blocked', 'Done'] as const

type Lane = (typeof lanes)[number]

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

const cardRowToJson = (row: {
  id: number
  title: string
  description: string
  lane: Lane
  owner: string
  tags: string
  created_at: string
  updated_at: string
}) => ({
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openclaw-kanban-api' })
})

app.get('/api/lanes', (_req, res) => {
  res.json({ lanes })
})

app.get('/api/cards', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM cards ORDER BY updated_at DESC')
    .all() as Array<{
    id: number
    title: string
    description: string
    lane: Lane
    owner: string
    tags: string
    created_at: string
    updated_at: string
  }>

  res.json({ cards: rows.map(cardRowToJson) })
})

app.post('/api/cards', (req, res) => {
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

  const lane = body.lane && lanes.includes(body.lane) ? body.lane : 'Backlog'
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

  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid) as {
    id: number
    title: string
    description: string
    lane: Lane
    owner: string
    tags: string
    created_at: string
    updated_at: string
  }

  return res.status(201).json({ card: cardRowToJson(card) })
})

app.patch('/api/cards/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as
    | {
        id: number
        title: string
        description: string
        lane: Lane
        owner: string
        tags: string
        created_at: string
        updated_at: string
      }
    | undefined

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

  logActivity.run(id, 'card.updated', `${existing.lane} -> ${nextLane}`, now)

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as {
    id: number
    title: string
    description: string
    lane: Lane
    owner: string
    tags: string
    created_at: string
    updated_at: string
  }

  return res.json({ card: cardRowToJson(updated) })
})

app.delete('/api/cards/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid id' })
  }

  const now = new Date().toISOString()
  const result = db.prepare('DELETE FROM cards WHERE id = ?').run(id)
  if (!result.changes) {
    return res.status(404).json({ error: 'card not found' })
  }

  logActivity.run(id, 'card.deleted', '', now)

  return res.status(204).send()
})

app.get('/api/activity', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50')
    .all()
  res.json({ activity: rows })
})

app.listen(PORT, () => {
  console.log(`openclaw-kanban api listening on http://localhost:${PORT}`)
})
