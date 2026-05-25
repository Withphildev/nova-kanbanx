# openclaw-kanban

MIT-licensed Kanban for OpenClaw workflows.

## Quick start
1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`
4. Open `http://localhost:5173`

Environment variables:
- `PORT` (default `3001`)
- `KANBAN_DB_PATH` (optional absolute SQLite file path; defaults to `server/kanban.db`)
- `OPENCLAW_WORKFLOW_HOOK_URL` (optional webhook endpoint)

## Validation
- `npm test`
- `npm run build`

## Phase 1 goals
- Kanban board with lanes (`Backlog`, `In Progress`, `Blocked`, `Done`)
- Card CRUD with lightweight tags and owner
- Local persistence (SQLite)
- Basic activity log for agent actions

## Phase 2 delivered
- Inline card editing for title, description, owner, tags, and lane
- Optimistic UI updates for edit/move/delete actions with rollback on failure
- SQLite startup migration guardrails for legacy card schemas
- OpenClaw workflow webhooks on card create/update/move/delete via `OPENCLAW_WORKFLOW_HOOK_URL`

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
