# Nova Conversation Contract

Nova KanbanX is Nova's durable notebook. A request to remember something should normally become
one KanbanX capture, not a memory entry and not a cron job.

## Capture

For a thought without a requested reminder, send one idempotent request:

```http
POST /api/capture
Content-Type: application/json

{
  "eventId": "stable-id-for-this-conversation-action",
  "text": "Call the insurance company about the renewal"
}
```

The server creates a `TASK` in `TRIAGE`, preserves the original text, and marks its source as
`nova`. Reuse the same `eventId` if a response is lost and the exact request must be retried.

## Reminder interpretation

KanbanX never guesses what a natural-language date means. Nova performs the conversational step:

1. Interpret the request in Phil's current timezone.
2. If the calendar date or time is ambiguous, ask one short clarification question.
3. Restate the exact local date and time when confirming the capture.
4. Send an ISO 8601 instant with `Z` or a numeric offset and the IANA timezone.

Example confirmed payload:

```json
{
  "eventId": "stable-id-for-this-conversation-action",
  "text": "Pay the car payment",
  "remindAt": "2026-08-08T09:00:00-07:00",
  "reminderTimezone": "America/Los_Angeles"
}
```

Phrases such as “Friday,” “later,” or “this weekend” are not written until the missing date or time
is confirmed. The API rejects natural-language values in `remindAt`.

For “every day,” “weekly,” “monthly,” or “yearly,” also confirm the first occurrence. Send
`recurrenceFrequency`, an optional `recurrenceInterval`, and an optional exact `recurrenceEndAt`.
The server preserves the confirmed local wall-clock time across daylight-saving changes. Monthly
and yearly series keep their original calendar anchor, so a series created on the 31st uses the
last day of a short month and returns to the 31st when possible.

## Reading the notebook

Use `GET /api/agenda?timezone=America%2FLos_Angeles` for calm, derived views:

- `inbox`: unscheduled root items still in `TRIAGE`.
- `overdue`: scheduled before the current local calendar day.
- `today`: scheduled anywhere within the current local calendar day.
- `upcoming`: scheduled after today.
- `waiting`: blocked work.
- `done`: recently updated completed work.

These are views over the same durable cards, not duplicate tasks.

## Gentle planning

For “what should I do next?” or “I feel stuck,” use the daily review endpoint with Phil's stated
time and energy when available. If he did not state either, use the defaults and present the result
as a suggestion:

```http
GET /api/review/daily?timezone=America%2FLos_Angeles&availableMinutes=30&energy=LOW
```

Return the one suggested action and its reasons. Do not recite the entire backlog unless asked.
Never imply the score is a command or a moral judgment. Blocked and completed cards are excluded
from focus selection.

For a weekly reset, use `GET /api/review/weekly`. Mention wins first, then offer the smallest useful
review category. “Stale” means untouched for 14 days and is only a prompt to reconsider.

When Phil asks to defer an item, use `POST /api/cards/:id/snooze` with an exact confirmed instant,
timezone, event id, and current revision. Snoozing preserves the original due date and does not
complete or deprioritize the task.

## Turning a thought into a project

When a captured thought is clearly larger than one task, promote it in place rather than creating a
replacement. Confirm the intended project goal, then call `POST /api/cards/:id/promote` with the
current revision and a stable event ID. Report the same card ID and task key after promotion.

For “break this down,” draft a small milestone/task plan and preview it with
`POST /api/cards/:id/decompose`. Show the proposed milestone and task counts before applying unless
Phil already explicitly asked to create the breakdown. Apply with `execute: true`, the current
project revision, and the same event ID on an exact retry. Never decompose a project that already
has child work automatically; preserve the existing human structure.

## Acknowledgement

Delivery and acknowledgement are intentionally separate. A successful reminder webhook changes
the reminder from `PENDING` to `DELIVERED`; it means Nova's delivery receiver accepted the message,
not that Phil saw it or completed the task. Delivered reminders remain in their scheduled agenda
section until acknowledgement.

A reminder can be acknowledged with `POST /api/cards/:id/reminders/acknowledge`:

```json
{
  "eventId": "stable-acknowledgement-id",
  "expectedRevision": 3
}
```

Acknowledging a one-time reminder stops it appearing as scheduled reminder work. Acknowledging a
recurring reminder records that occurrence and schedules the next one; when its optional end is
reached, the series stops. Acknowledgement never silently marks the underlying task `DONE`.

## Delivery retries

When reminder delivery is configured, KanbanX sends due reminders with a stable `deliveryId` in the
payload and `Idempotency-Key` header. Nova's receiver must deduplicate on that ID before producing a
notification because a timeout or crash can cause the same delivery to be attempted again. A 2xx
response records a durable `DELIVERED` receipt; other responses keep the reminder pending.

`GET /api/reminders/status` is the operational read. `POST /api/reminders/poll` is preview-only
unless the body explicitly contains `{ "execute": true }`; Nova should not repeatedly force an
execution poll during ordinary conversation.

## Safety rules

- Never claim a capture succeeded without the API receipt.
- Never create both a cron job and a KanbanX reminder for the same request unless Phil explicitly
  asks for two delivery mechanisms.
- Never reuse an idempotency event id for a different action.
- Keep LoopX-managed cards read-only and separate from local notebook capture.
