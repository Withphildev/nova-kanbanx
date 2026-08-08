# Nova KanbanX

A durable agent task board powered by [LoopX](https://github.com/huangruiteng/loopx), with an
operator-friendly Kanban interface for OpenClaw workflows.

## Quick start
1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`
4. Open `http://localhost:5173`

Environment variables:
- `PORT` (default `3001`)
- `KANBAN_DB_PATH` (optional absolute SQLite file path; defaults to `server/kanban.db`)
- `OPENCLAW_WORKFLOW_HOOK_URL` (optional webhook endpoint)
- `KANBAN_REMINDER_HOOK_URL` (optional reminder receiver; enables delivery polling)
- `KANBAN_REMINDER_HOOK_TOKEN` (optional bearer token; falls back to `NOVA_KANBANX_HOOK_TOKEN`)
- `KANBAN_REMINDER_POLL_MS` (delivery poll interval, default `60000`, minimum `1000`)
- `KANBAN_REMINDER_TIMEOUT_MS` (per-attempt webhook timeout, default `5000`)
- `KANBAN_NUDGE_HOOK_URL` (optional gentle-nudge receiver; falls back to the reminder hook)
- `KANBAN_NUDGE_HOOK_TOKEN` (optional bearer token; falls back to the shared Nova token)
- `KANBAN_NUDGE_POLL_MS` (nudge eligibility poll, default `900000` / 15 minutes)
- `KANBAN_NUDGE_TIMEZONE` (automatic poll timezone, default `America/Los_Angeles`)
- `KANBAN_NUDGE_QUIET_START_HOUR` / `KANBAN_NUDGE_QUIET_END_HOUR` (defaults `21` / `8`)
- `LOOPX_GOAL_ID` (enables the LoopX adapter for this goal)
- `LOOPX_BIN` (LoopX executable, default `loopx`)
- `LOOPX_REGISTRY` / `LOOPX_PROJECT` (optional explicit LoopX paths)
- `LOOPX_AGENT_ID` (optional lifecycle actor for write-back commands)
- `LOOPX_TIMEOUT_MS` (CLI timeout, default `5000`)

Keep hook URLs on localhost or use HTTPS whenever delivery leaves the machine. Bearer tokens are
credentials and must not be sent over unencrypted HTTP.

## Validation
- `npm test`
- `npm run build`
- `npm run agent:smoke` (requires API running on `http://localhost:3001` or set `KANBAN_API_URL`)

## DB integrity guard
- Server runs `PRAGMA integrity_check` during startup and on `GET /api/health`.
- If an existing DB file is malformed, server copies it to `server/quarantine/*.malformed.sqlite` and refuses to start.
- No silent malformed-DB recreation path is used.

## Phase 1 goals
- Kanban board with lanes (`TRIAGE`, `TODO`, `READY`, `RUNNING`, `BLOCKED`, `DONE`)
- Card CRUD with lightweight tags and owner
- Local persistence (SQLite)
- Basic activity log for agent actions

## Phase 2 delivered
- Inline card editing for title, description, owner, tags, and lane
- Optimistic UI updates for edit/move/delete actions with rollback on failure
- SQLite startup migration guardrails for legacy card schemas
- OpenClaw workflow webhooks on card create/update/move/delete via `OPENCLAW_WORKFLOW_HOOK_URL`

## LoopX foundation
- Every card has a stable `taskKey`, `revision`, priority, source/external identity,
  acceptance criteria, blocker/continuation/evidence fields, and lifecycle timestamps.
- Lane changes use a validated lifecycle: `TRIAGE -> TODO -> READY -> RUNNING -> DONE`,
  with explicit backflow, blocking, and reopening routes exposed by `GET /api/lanes`.
- Create, update, and delete requests accept an `Idempotency-Key` header or `eventId`
  body field. Replays return the original task identity without repeating side effects.
- Local card, snooze, promotion, decomposition, reminder acknowledgement, and checklist updates
  require `expectedRevision`. Missing revisions return `400`; stale revisions return `409` with
  the current revision so an agent can reload before deciding whether to retry.
- `GET /api/cards/:id/events` exposes the append-only event ledger for a task.
- Numbered, transactional SQLite migrations preserve and backfill legacy databases.

### Date and time semantics

- `dueAt` is planning information. It accepts either a calendar date (`YYYY-MM-DD`) or an ISO 8601
  instant ending in `Z` or a numeric offset. Offset-less date-times are rejected because their
  meaning changes with the machine timezone.
- `remindAt`, `recurrenceEndAt`, and snooze times are delivery instants. They always require an ISO
  8601 value with `Z` or a numeric offset plus an IANA timezone where the endpoint requests one.
- Natural-language dates are interpreted conversationally by Nova and confirmed before the API
  receives them; KanbanX never guesses phrases such as “later” or “next Friday.”

### Audit model

- `task_events` is the durable, append-only source of truth for task mutations and idempotency.
  Events remain queryable by the former card ID after a card is deleted, including the final
  `card.deleted` event.
- `activity_log` is a compact recent-activity feed for the UI and operations. It is prunable, and
  card-specific activity rows are removed with a deleted card; a detached deletion marker remains.
- Checklist rows are task-owned materialized state and are deleted by foreign-key cascade. Their
  already-recorded task events remain in the durable ledger.

The board keeps its existing visual design while offering only valid lifecycle moves, surfacing API
errors, and sending idempotency/revision guards.

## LoopX control-plane adapter

This phase follows the official [LoopX](https://github.com/huangruiteng/loopx) external-board
contract: LoopX owns todo identity and lifecycle state; Kanban is a non-destructive projection.

1. Install/configure the official `loopx` CLI and connect the project to a goal.
2. Set `LOOPX_GOAL_ID`; optionally set the registry, project, executable, and agent variables above.
3. Check `GET /api/loopx/status`.
4. Preview with `POST /api/loopx/reconcile` and `{}`. Preview is the default and writes nothing.
5. Apply with `POST /api/loopx/reconcile` and `{ "execute": true }`.

Projection behavior:

- Stable external identity is `goal_id:todo_id`; the adapter never invents a LoopX todo id.
- Reconciliation only creates or updates `source=loopx` cards. Missing todos are not deleted.
- Repeating an unchanged sync does not revise cards or duplicate task events.
- Applied reconciliation writes an auditable receipt and per-card event.
- LoopX cards reject ordinary card edit/delete endpoints so the projection cannot overwrite authority.

Explicit write-back uses `POST /api/loopx/cards/:id/actions` with `action` set to `claim`, `update`,
or `complete`. These calls also dry-run unless the body contains `"execute": true`. Claim accepts
`claimedBy`; update accepts `status`, `note`, `evidence`, and `reason`; complete accepts `evidence`,
`note`, `reason`, and `noFollowUp`. Successful executed actions immediately reconcile the board.

## Durable task workspace
- Priority is visible on every card and selectable during creation.
- Expandable task details show stable identity, source/external reference, due date, acceptance
  criteria, blocker context, next action, continuation/handoff notes, evidence, and revision.
- The complete durable task contract can be edited inline with optimistic concurrency protection.
- Each task can load its append-only lifecycle event history directly from the board.

## Assistant notebook and progressive work

Nova KanbanX can act as Nova's durable notebook: quick thoughts become tasks instead of chat memory
or one-off cron jobs, and larger goals can be broken into work that feels finishable.

- Work is organized as `Project -> Milestone -> Task -> Checklist item`.
- The board shows root projects and standalone tasks, preserving a calm top-level view.
- Opening **Details** reveals the small-step tree and lets a user add milestones, tasks, or checklist
  items without leaving the card.
- Project and milestone progress rolls up from completed descendant tasks. Task progress rolls up
  from checklist items.
- **What next?** generates a restart packet with the current milestone, one preferred next action,
  estimated time, definition of done, blockers, continuation notes, and recent wins.
- Hierarchy and checklist mutations use the same event idempotency and optimistic revision guards as
  the original durable card lifecycle.

The product principles and delivery roadmap are documented in
[`docs/assistant-notebook.md`](docs/assistant-notebook.md).

### Conversational capture and reminders

- `POST /api/capture` stores Nova's original captured text as a `TRIAGE` task in one idempotent
  request.
- Optional reminders require an ISO 8601 instant with an offset plus an IANA timezone. Natural
  phrases are rejected so Nova can clarify ambiguity before writing.
- `GET /api/agenda?timezone=America%2FLos_Angeles` returns Inbox, Overdue, Today, Upcoming,
  Waiting, and Done sections derived from the durable cards.
- Reminders can recur daily, weekly, monthly, or yearly at an explicit interval and optional end
  instant. Their confirmed local wall-clock time survives daylight-saving changes, while monthly
  and yearly calendar anchors survive short months.
- `POST /api/cards/:id/reminders/acknowledge` is revision-guarded and idempotent. It stops a
  one-time reminder or schedules the next recurring occurrence without completing the task.
- Reminder sending is inactive by default. When `KANBAN_REMINDER_HOOK_URL` is configured, the
  server polls due reminders, retries failures, and keeps durable delivery receipts.
- `GET /api/reminders/status` reports configuration, pending/due counts, and recent receipts.
- `POST /api/reminders/poll` previews due delivery by default; `{ "execute": true }` sends only
  when a hook is configured.
- Date-level and undated notebook items can receive bundled gentle nudges without gaining an
  invented alert time. Today items are eligible every three hours, overdue and week-level items
  daily, month-level and undated items weekly, and longer-range items monthly.
- Gentle nudges are quiet from 9 PM through 8 AM by default, suppress recently edited or surfaced
  tasks, exclude blocked/done work and exact-time reminders, and bundle up to eight visible items
  into one calm prompt.
- `GET /api/nudges/status` shows current eligibility, quiet-hour state, configuration, and durable
  receipts. `POST /api/nudges/poll` previews by default; `{ "execute": true }` sends a bundle only
  when a nudge or reminder hook is configured.
- `GET /api/review/daily` returns one explained, unblocked next action plus small wins and gentle
  counts. Optional `availableMinutes` and `energy` preferences change the deterministic ranking.
- `GET /api/review/weekly` starts with recent wins, then summarizes inbox, waiting work, open
  projects, stale work, and tasks that still need a next step.
- `POST /api/cards/:id/snooze` moves scheduling forward without deleting the original due date or
  task history. It is revision-guarded and idempotent.
- `POST /api/cards/:id/promote` turns a standalone captured task into a project in place, preserving
  its card ID, task key, original wording, reminders, revision history, and source identity.
- `POST /api/cards/:id/decompose` validates and previews a bounded milestone/task plan by default.
  Explicit execution creates the complete hierarchy transactionally and idempotently.
- Tasks can carry `energyDemand` (`UNKNOWN`, `LOW`, `MEDIUM`, or `HIGH`) alongside their existing
  time estimate.

Nova's exact conversational and retry behavior is documented in
[`docs/nova-conversation-contract.md`](docs/nova-conversation-contract.md).

### Reminder delivery contract

Each due reminder uses a deterministic `deliveryId` derived from its stable task key and reminder
instant. Retries send the same value in both the JSON body and `Idempotency-Key` header, allowing
the receiver to deduplicate a response lost between delivery and receipt persistence. Delivery is
therefore at least once: receivers must treat `deliveryId` as the side-effect identity.

The hook receives `event: "reminder.due"`, a timestamp, the delivery ID, and a compact card payload
containing task identity, title, original captured text, lane, priority, reminder time/timezone,
recurrence metadata, due date, next action, and acceptance criteria. Only a 2xx response marks the
reminder `DELIVERED`.
Failures retain `PENDING`, increment the receipt attempt count, and are eligible for the next poll.
Acknowledgement remains a separate user action and never marks the task itself complete.

### Gentle nudge delivery contract

Each three-hour active window has a deterministic `nudgeId`. The first attempt durably freezes the
complete delivery payload; failed retries within that window reuse the same JSON body and
`Idempotency-Key`, even if a card is edited between attempts. Successful delivery updates per-card
nudge state without revising the task or adding audit noise. The hook receives
`event: "gentle_nudge.due"`, one non-judgmental message, the timezone, and a compact list of eligible
items with cadence and reason. Multiple tasks are one digest, never one notification per card.

Recent task updates count as recent attention, so a newly captured or edited item is not immediately
echoed back. Successful delivery starts the next cadence window. Quiet hours and cadence are
derived in the configured IANA timezone.

## Development plan

1. Reliable capture and reminder semantics — **Delivered, including recurrence**
2. Progressive decomposition and restart packets
3. Daily/weekly review views with gentle prioritization — **Delivered**
4. Nova conversational commands over the durable API — **Delivered foundation**
5. Optional LoopX execution without giving up local notebook authority

## Workflow hook payload
Set `OPENCLAW_WORKFLOW_HOOK_URL` on the server to receive JSON events:
- `card.created`
- `card.captured`
- `card.updated`
- `card.moved`
- `card.deleted`

Payload shape:
- `event` (string)
- `cardId` (number)
- `lane` (optional string)
- `detail` (optional string)
- `timestamp` (ISO string)
