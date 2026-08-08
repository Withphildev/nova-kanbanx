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
  {
    version: 4,
    name: 'progressive_decomposition',
    up: (db) => {
      addColumn(db, 'cards', 'item_type', "TEXT NOT NULL DEFAULT 'TASK'")
      addColumn(db, 'cards', 'parent_id', 'INTEGER REFERENCES cards(id) ON DELETE RESTRICT')
      addColumn(db, 'cards', 'goal', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'estimate_minutes', 'INTEGER')
      addColumn(db, 'cards', 'position', 'INTEGER NOT NULL DEFAULT 0')

      db.exec(`
        CREATE INDEX IF NOT EXISTS cards_parent_position_idx
          ON cards(parent_id, position, id);

        CREATE TABLE IF NOT EXISTS checklist_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          is_done INTEGER NOT NULL DEFAULT 0 CHECK(is_done IN (0, 1)),
          position INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS checklist_items_card_position_idx
          ON checklist_items(card_id, position, id);
      `)
    },
  },
  {
    version: 5,
    name: 'assistant_capture_and_reminders',
    up: (db) => {
      addColumn(db, 'cards', 'captured_text', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'remind_at', 'TEXT')
      addColumn(db, 'cards', 'reminder_timezone', "TEXT NOT NULL DEFAULT ''")
      addColumn(db, 'cards', 'reminder_status', "TEXT NOT NULL DEFAULT 'NONE'")
      addColumn(db, 'cards', 'reminder_acknowledged_at', 'TEXT')
      addColumn(db, 'cards', 'reviewed_at', 'TEXT')

      db.exec(`
        CREATE INDEX IF NOT EXISTS cards_reminder_schedule_idx
          ON cards(reminder_status, remind_at, id);
        CREATE INDEX IF NOT EXISTS cards_due_schedule_idx
          ON cards(due_at, id);
      `)
    },
  },
  {
    version: 6,
    name: 'reminder_delivery_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminder_delivery_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_id TEXT NOT NULL UNIQUE,
          card_id INTEGER,
          task_key TEXT NOT NULL,
          remind_at TEXT NOT NULL,
          reminder_timezone TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          delivered_at TEXT,
          response_status INTEGER,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS reminder_delivery_receipts_status_idx
          ON reminder_delivery_receipts(status, updated_at, id);
        CREATE INDEX IF NOT EXISTS reminder_delivery_receipts_card_idx
          ON reminder_delivery_receipts(card_id, id DESC);
      `)
    },
  },
  {
    version: 7,
    name: 'adhd_friendly_planning',
    up: (db) => {
      addColumn(db, 'cards', 'energy_demand', "TEXT NOT NULL DEFAULT 'UNKNOWN'")
      db.exec(`
        CREATE INDEX IF NOT EXISTS cards_review_idx
          ON cards(reviewed_at, updated_at, id);
        CREATE INDEX IF NOT EXISTS cards_planning_idx
          ON cards(lane, item_type, priority, energy_demand, estimate_minutes, id);
      `)
    },
  },
  {
    version: 8,
    name: 'recurring_reminders',
    up: (db) => {
      addColumn(db, 'cards', 'recurrence_frequency', "TEXT NOT NULL DEFAULT 'NONE'")
      addColumn(db, 'cards', 'recurrence_interval', 'INTEGER NOT NULL DEFAULT 1')
      addColumn(db, 'cards', 'recurrence_end_at', 'TEXT')
      addColumn(db, 'cards', 'recurrence_occurrences', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'cards', 'recurrence_anchor_month', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'cards', 'recurrence_anchor_day', 'INTEGER NOT NULL DEFAULT 0')
      db.exec(`
        CREATE INDEX IF NOT EXISTS cards_recurrence_idx
          ON cards(recurrence_frequency, reminder_status, remind_at, id);
      `)
    },
  },
  {
    version: 9,
    name: 'gentle_nudge_delivery',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gentle_nudge_state (
          card_id INTEGER PRIMARY KEY,
          last_nudged_at TEXT NOT NULL,
          nudge_count INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS gentle_nudge_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nudge_id TEXT NOT NULL UNIQUE,
          timezone TEXT NOT NULL,
          window_key TEXT NOT NULL,
          status TEXT NOT NULL,
          item_count INTEGER NOT NULL,
          card_ids TEXT NOT NULL,
          message TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          delivered_at TEXT,
          response_status INTEGER,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS gentle_nudge_receipts_status_idx
          ON gentle_nudge_receipts(status, updated_at, id);
        CREATE INDEX IF NOT EXISTS gentle_nudge_receipts_window_idx
          ON gentle_nudge_receipts(timezone, window_key, id);
      `)
    },
  },
  {
    version: 10,
    name: 'freeze_gentle_nudge_payloads',
    up: (db) => {
      addColumn(db, 'gentle_nudge_receipts', 'payload', 'TEXT')
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
