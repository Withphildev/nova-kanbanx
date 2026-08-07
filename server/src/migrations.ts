import type Database from 'better-sqlite3'

type SqliteDatabase = Database.Database

const columnNames = (db: SqliteDatabase, table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  )

const addColumn = (db: SqliteDatabase, table: string, name: string, definition: string) => {
  if (!columnNames(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

const migrations: Array<{ version: number; name: string; up: (db: SqliteDatabase) => void }> = [
  {
    version: 1,
    name: 'initial_cards_and_activity',
    up: (db) => {
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

        CREATE TABLE IF NOT EXISTS activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id INTEGER,
          action TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES cards(id)
        );
      `)

      addColumn(db, 'cards', 'description', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'owner', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'tags', "TEXT NOT NULL DEFAULT ''")

      db.exec(`
        UPDATE cards SET lane = 'TODO' WHERE lane IN ('Backlog', 'TODO');
        UPDATE cards SET lane = 'RUNNING' WHERE lane IN ('In Progress', 'RUNNING');
        UPDATE cards SET lane = 'BLOCKED' WHERE lane IN ('Blocked', 'BLOCKED');
        UPDATE cards SET lane = 'DONE' WHERE lane IN ('Done', 'DONE');
        UPDATE cards SET lane = 'TRIAGE' WHERE lane IN ('Triage', 'TRIAGE');
      `)
    },
  },
  {
    version: 2,
    name: 'loopx_task_foundation',
    up: (db) => {
      addColumn(db, 'cards', 'task_key', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'priority', "TEXT NOT NULL DEFAULT 'P2'")
      addColumn(db, 'cards', 'source', "TEXT NOT NULL DEFAULT 'manual'")
      addColumn(db, 'cards', 'external_id', 'TEXT')
      addColumn(db, 'cards', 'acceptance_criteria', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'blocked_reason', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'next_action', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'continuation', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'evidence', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'due_at', 'TEXT')
      addColumn(db, 'cards', 'started_at', 'TEXT')
      addColumn(db, 'cards', 'completed_at', 'TEXT')
      addColumn(db, 'cards', 'revision', 'INTEGER NOT NULL DEFAULT 1')

      // SQLite cannot add a non-constant UUID default to an existing table. Give
      // every legacy row a stable identifier during the migration instead.
      db.exec(`
        UPDATE cards
        SET task_key = lower(
          hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
          substr(hex(randomblob(2)), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) ||
          substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
        )
        WHERE task_key = '';

        CREATE UNIQUE INDEX IF NOT EXISTS cards_task_key_unique ON cards(task_key);
        CREATE UNIQUE INDEX IF NOT EXISTS cards_source_external_id_unique
          ON cards(source, external_id) WHERE external_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          card_id INTEGER,
          event_type TEXT NOT NULL,
          from_lane TEXT,
          to_lane TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          result_status INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS task_events_card_id_idx ON task_events(card_id, id);
      `)
    },
  },
  {
    version: 3,
    name: 'loopx_reconciliation_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS loopx_reconciliation_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sync_id TEXT NOT NULL UNIQUE,
          goal_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          source_count INTEGER NOT NULL,
          created_count INTEGER NOT NULL,
          updated_count INTEGER NOT NULL,
          unchanged_count INTEGER NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS loopx_reconciliation_receipts_goal_idx
          ON loopx_reconciliation_receipts(goal_id, id DESC);
      `)
    },
  },
]

export const runMigrations = (db: SqliteDatabase) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  )

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue

    db.transaction(() => {
      migration.up(db)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString())
    })()
  }
}
