import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations.js'

describe('database migrations', () => {
  it('upgrades legacy cards without losing data and is repeatable', () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        lane TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO cards (title, lane, created_at, updated_at)
      VALUES ('Legacy card', 'In Progress', '2026-01-01', '2026-01-01');
    `)

    runMigrations(database)
    runMigrations(database)

    const card = database.prepare('SELECT * FROM cards WHERE id = 1').get() as Record<string, unknown>
    const migrations = database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all()

    expect(card).toMatchObject({
      title: 'Legacy card',
      lane: 'RUNNING',
      priority: 'P2',
      source: 'manual',
      revision: 1,
      item_type: 'TASK',
      goal: '',
      captured_text: '',
      reminder_status: 'NONE',
      reminder_timezone: '',
      energy_demand: 'UNKNOWN',
      recurrence_frequency: 'NONE',
      recurrence_interval: 1,
      recurrence_occurrences: 0,
      recurrence_anchor_month: 0,
      recurrence_anchor_day: 0,
    })
    expect(card.task_key).toMatch(/^[0-9a-f-]{36}$/)
    expect(migrations).toEqual([
      { version: 1, name: 'initial_cards_and_activity' },
      { version: 2, name: 'loopx_task_foundation' },
      { version: 3, name: 'loopx_reconciliation_receipts' },
      { version: 4, name: 'progressive_decomposition' },
      { version: 5, name: 'assistant_capture_and_reminders' },
      { version: 6, name: 'reminder_delivery_receipts' },
      { version: 7, name: 'adhd_friendly_planning' },
      { version: 8, name: 'recurring_reminders' },
    ])
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checklist_items'").get(),
    ).toEqual({ name: 'checklist_items' })
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_delivery_receipts'")
        .get(),
    ).toEqual({ name: 'reminder_delivery_receipts' })
    database.close()
  })
})
