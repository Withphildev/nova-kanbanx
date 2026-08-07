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
- `LOOPX_GOAL_ID` (enables the LoopX adapter for this goal)
- `LOOPX_BIN` (LoopX executable, default `loopx`)
- `LOOPX_REGISTRY` / `LOOPX_PROJECT` (optional explicit LoopX paths)
- `LOOPX_AGENT_ID` (optional lifecycle actor for write-back commands)
- `LOOPX_TIMEOUT_MS` (CLI timeout, default `5000`)

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
- `expectedRevision` on updates provides optimistic concurrency protection.
- `GET /api/cards/:id/events` exposes the append-only event ledger for a task.
- Numbered, transactional SQLite migrations preserve and backfill legacy databases.

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

## Development plan
1. Scaffold web app + API
2. Add board and card model
3. Add OpenClaw-oriented workflow hooks
4. Add tests and release docs

## Workflow hook payload
Set `OPENCLAW_WORKFLOW_HOOK_URL` on the server to receive JSON events:
- `card.created`
- `card.updated`
- `card.moved`
- `card.deleted`

Payload shape:
- `event` (string)
- `cardId` (number)
- `lane` (optional string)
- `detail` (optional string)
- `timestamp` (ISO string)
