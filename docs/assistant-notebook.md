# Nova KanbanX Assistant Notebook

## Product North Star

Nova KanbanX is an ADHD-friendly shared notebook and operational memory. It captures what Phil
does not want to forget, turns larger intentions into achievable work, and always makes the next
reachable action visible to either a person or an agent.

The governing principle is:

> Decompose work until the next action is small enough that a person or an LLM can confidently
> pick it up and continue.

KanbanX answers: **What are we trying to do, where did we stop, what changed, and what is the next
achievable step?** It does not replace Nova's long-term memory or a calendar.

## ADHD-Friendly Principles

1. Capture first; clarify later. New thoughts can land in `TRIAGE` with only a title.
2. Show one concrete next action instead of an undifferentiated project.
3. Make partial progress visible at multiple levels.
4. Treat overdue work as information, not failure; support easy replanning later.
5. Preserve restart context so an interruption does not erase momentum.
6. Keep the default surface calm. Reveal detailed structure on demand.
7. Never claim progress that is not backed by task state or evidence.

## Progressive Decomposition

```text
Project
  └─ Milestone
       └─ Task
            └─ Checklist step
```

- A **project** holds the durable goal and rolls up descendant task progress.
- A **milestone** is a meaningful checkpoint and rolls up its descendant tasks.
- A **task** is independently actionable and moves through the validated Kanban lifecycle.
- A **checklist step** is a small completion unit inside a task; it is not a full Kanban card.

Progress is derived, not manually entered:

- Project/milestone progress = completed descendant tasks / total descendant tasks.
- Task micro-progress = completed checklist steps / total checklist steps.
- Empty structures report no percentage instead of implying zero progress.

Completing a checklist does not silently complete its task. The human or agent still confirms the
task's definition of done and moves it through the normal lifecycle.

## Restart Packet

A restart packet is generated from live project state and contains:

- Project goal and current lane.
- Overall progress.
- Current unfinished milestone.
- Best next unfinished task.
- That task's next action, definition of done, estimate, continuation notes, and evidence.
- Active blockers.
- Recently completed tasks.

The daily recommender uses deterministic ordering and considers lifecycle momentum, stored
priority, schedule, available time, energy demand, and whether a concrete next action exists. It
always explains why it selected an item and never mutates task state merely by recommending it.

## Authority and Safety

- Existing card identity, revisions, idempotency, lifecycle validation, and event history remain in
  force for every hierarchical task.
- Hierarchy mutations are transactional and audited.
- Parent deletion is rejected while children exist.
- LoopX cards remain read-only projections. The first hierarchy version does not attach local child
  work to LoopX projections because ownership and write-back semantics need a separate contract.
- Direct SQLite edits are not part of the operating workflow.

## Delivery Phases

### Phase A — Verifiable foundation

- CI runs tests and production builds.
- LoopX response/version contracts fail closed and are exercised against official fixtures.

### Phase B — Visible progress foundation

- Typed project/milestone/task hierarchy.
- Task checklist steps.
- Computed progress rollups.
- Generated restart packets and a “Continue from here” surface.

### Phase C — Assistant notebook

- Conversational capture into a calm Inbox/Triage view. **Delivered.**
- Promote an item into a project without losing identity or history. **Delivered.**
- Confirmed reminder instants and timezone-aware agenda views. **Delivered.**
- Natural-language interpretation remains Nova's responsibility; ambiguous dates must be confirmed
  before KanbanX accepts the ISO instant.

### Phase D — ADHD-friendly planning

- Inbox, Overdue, Today, Upcoming, Waiting, and Done views. **Delivered foundation.**
- Time estimate, energy demand, and gentle replanning/snooze controls. **Delivered.**
- One clearly identified and explained next action. **Delivered.**
- Wins-first weekly reset with stale/unplanned work surfaced as optional review information.
  **Delivered.**

### Phase E — Reminder delivery

- Durable `remindAt`, recurrence, timezone, and notification receipt fields. **Delivered.**
- One reliable watcher for due reminders instead of one cron job per reminder. **Delivered.**
- At-least-once polling with idempotent notification delivery. **Delivered.**
- Revision-guarded acknowledgement advances recurring series while preserving local time and
  calendar anchors. **Delivered.**

## Daily and Weekly Review Semantics

- Daily focus excludes blocked and completed work and returns at most one primary action.
- An overdue item gains relevance without receiving blame language or automatic priority changes.
- Available time and energy are request preferences, not permanent claims about the user.
- Quick wins are limited to tasks estimated at 15 minutes or less.
- Weekly reset begins with tasks completed in the preceding seven days.
- Stale means neither reviewed nor updated for 14 days; it does not mean abandoned or failed.
- Snoozing creates a new reminder instant, preserves `dueAt`, increments the task revision, and
  writes an auditable `reminder.snoozed` event.

## Promotion and Decomposition Semantics

- Only a standalone, unfinished, locally owned task can be promoted.
- Promotion changes the item type in place. It preserves card ID, task key, captured text, source,
  reminder data, lifecycle state, and prior events.
- Decomposition accepts 1–6 milestones, 1–8 tasks per milestone, and at most 24 tasks total.
- Preview is the default and performs no writes.
- Apply requires the project's current revision and one idempotency event ID.
- The project revision, all child cards, activity records, and event ledger entries commit in one
  transaction. A failed validation or write leaves the hierarchy unchanged.
- Automatic decomposition is allowed only while the project has no child work. Once work exists,
  Nova must add or edit it explicitly instead of replacing a person's structure.

## Phase B Acceptance Criteria

1. Existing databases migrate without losing cards.
2. Existing root cards remain valid tasks.
3. A project can contain milestones and tasks; a milestone can contain tasks.
4. Invalid relationships and hierarchy cycles are rejected.
5. Checklist completion is idempotent, revision-aware, and visible in the event ledger.
6. Project and milestone progress changes immediately when descendant state changes.
7. A restart packet identifies the current milestone and one bounded next task.
8. The web UI presents progress and nested work without turning every child into a top-level card.
9. Server/web tests and production builds pass.
