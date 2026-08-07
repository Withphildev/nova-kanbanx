import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Lane = 'TRIAGE' | 'TODO' | 'READY' | 'RUNNING' | 'BLOCKED' | 'DONE'
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

type Card = {
  id: number
  title: string
  description: string
  lane: Lane
  owner: string
  tags: string[]
  taskKey: string
  priority: Priority
  source: string
  externalId: string | null
  acceptanceCriteria: string
  blockedReason: string
  nextAction: string
  continuation: string
  evidence: string
  dueAt: string | null
  startedAt: string | null
  completedAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

type EditDraft = {
  title: string
  description: string
  owner: string
  tags: string
  lane: Lane
  priority: Priority
  source: string
  externalId: string
  acceptanceCriteria: string
  blockedReason: string
  nextAction: string
  continuation: string
  evidence: string
  dueAt: string
}

type TaskEvent = {
  eventId: string
  eventType: string
  fromLane: Lane | null
  toLane: Lane | null
  resultStatus: number
  createdAt: string
}

const laneOrder: Lane[] = ['TRIAGE', 'TODO', 'READY', 'RUNNING', 'BLOCKED', 'DONE']
const priorityOrder: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4']

type AllowedTransitions = Record<Lane, Lane[]>

const fallbackTransitions: AllowedTransitions = {
  TRIAGE: ['TODO'],
  TODO: ['TRIAGE', 'READY'],
  READY: ['TODO', 'RUNNING'],
  RUNNING: ['READY', 'BLOCKED', 'DONE'],
  BLOCKED: ['TODO', 'READY', 'RUNNING'],
  DONE: ['TRIAGE'],
}

const newEventId = () =>
  globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`

const responseError = async (res: Response, fallback: string) => {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error || fallback
  } catch {
    return fallback
  }
}

const toDateTimeInput = (value: string | null | undefined) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function App() {
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [tags, setTags] = useState('')
  const [priority, setPriority] = useState<Priority>('P2')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [query, setQuery] = useState('')
  const [laneFilter, setLaneFilter] = useState<'All' | Lane>('All')
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([])
  const [allowedTransitions, setAllowedTransitions] = useState(fallbackTransitions)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [eventsByCard, setEventsByCard] = useState<Record<number, TaskEvent[]>>({})
  const [eventErrors, setEventErrors] = useState<Record<number, string>>({})

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cards.filter((card) => {
      if (laneFilter !== 'All' && card.lane !== laneFilter) return false
      if (!q) return true

      const text = [
        card.title,
        card.description,
        card.owner,
        card.tags.join(' '),
        card.priority,
        card.acceptanceCriteria,
        card.blockedReason,
        card.nextAction,
        card.continuation,
        card.evidence,
        card.externalId ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return text.includes(q)
    })
  }, [cards, laneFilter, query])

  const grouped = useMemo(() => {
    return laneOrder.map((lane) => ({ lane, cards: filteredCards.filter((c) => c.lane === lane) }))
  }, [filteredCards])

  const loadCards = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/cards')
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load cards'))
      const data = (await res.json()) as { cards: Card[] }
      setCards(data.cards)
    } finally {
      setLoading(false)
    }
  }

  const loadTransitions = async () => {
    const res = await fetch('/api/lanes')
    if (!res.ok) throw new Error(await responseError(res, 'Failed to load lifecycle rules'))
    const data = (await res.json()) as { allowedTransitions?: AllowedTransitions }
    if (data.allowedTransitions) setAllowedTransitions(data.allowedTransitions)
  }

  useEffect(() => {
    loadCards().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Failed to load cards')
      setLoading(false)
    })
    loadTransitions().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Failed to load lifecycle rules')
    })
  }, [])

  const createCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) return
    setError('')

    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: newEventId(),
          title: title.trim(),
          owner: owner.trim(),
          priority,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to create card'))

      setTitle('')
      setOwner('')
      setTags('')
      setPriority('P2')
      await loadCards()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create card')
    }
  }

  const applyCardUpdate = (nextCard: Card) => {
    setCards((prev) => prev.map((c) => (c.id === nextCard.id ? nextCard : c)))
  }

  const startEdit = (card: Card) => {
    setEditingId(card.id)
    setDraft({
      title: card.title,
      description: card.description,
      owner: card.owner,
      tags: card.tags.join(', '),
      lane: card.lane,
      priority: card.priority ?? 'P2',
      source: card.source ?? 'manual',
      externalId: card.externalId ?? '',
      acceptanceCriteria: card.acceptanceCriteria ?? '',
      blockedReason: card.blockedReason ?? '',
      nextAction: card.nextAction ?? '',
      continuation: card.continuation ?? '',
      evidence: card.evidence ?? '',
      dueAt: toDateTimeInput(card.dueAt),
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const saveEdit = async (card: Card) => {
    if (!draft) return
    setError('')

    const prevCard = card
    const nextCard: Card = {
      ...card,
      title: draft.title.trim() || card.title,
      description: draft.description.trim(),
      owner: draft.owner.trim(),
      tags: draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      lane: draft.lane,
      priority: draft.priority,
      source: draft.source.trim() || 'manual',
      externalId: draft.externalId.trim() || null,
      acceptanceCriteria: draft.acceptanceCriteria.trim(),
      blockedReason: draft.blockedReason.trim(),
      nextAction: draft.nextAction.trim(),
      continuation: draft.continuation.trim(),
      evidence: draft.evidence.trim(),
      dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
    }

    applyCardUpdate(nextCard)
    cancelEdit()

    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: nextCard.title,
          description: nextCard.description,
          owner: nextCard.owner,
          tags: nextCard.tags,
          lane: nextCard.lane,
          priority: nextCard.priority,
          source: nextCard.source,
          externalId: nextCard.externalId,
          acceptanceCriteria: nextCard.acceptanceCriteria,
          blockedReason: nextCard.blockedReason,
          nextAction: nextCard.nextAction,
          continuation: nextCard.continuation,
          evidence: nextCard.evidence,
          dueAt: nextCard.dueAt,
          expectedRevision: card.revision,
          eventId: newEventId(),
        }),
      })

      if (!res.ok) throw new Error(await responseError(res, 'Failed to save card'))

      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
    } catch (cause) {
      applyCardUpdate(prevCard)
      setError(cause instanceof Error ? cause.message : 'Failed to save card')
      try {
        await loadCards()
      } catch {
        // Preserve the actionable mutation error when the recovery refresh also fails.
      }
    }
  }

  const moveCard = async (card: Card, lane: Lane) => {
    if (lane === card.lane) return
    setError('')

    const prevCard = card
    const optimistic = { ...card, lane, updatedAt: new Date().toISOString() }
    applyCardUpdate(optimistic)

    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lane, expectedRevision: card.revision, eventId: newEventId() }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to move card'))
      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
    } catch (cause) {
      applyCardUpdate(prevCard)
      setError(cause instanceof Error ? cause.message : 'Failed to move card')
      try {
        await loadCards()
      } catch {
        // Preserve the actionable mutation error when the recovery refresh also fails.
      }
    }
  }

  const deleteCard = async (card: Card) => {
    setError('')
    setPendingDeleteIds((current) => [...current, card.id])
    setCards((current) => current.filter((c) => c.id !== card.id))

    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': newEventId() },
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to delete card'))
    } catch (cause) {
      setCards((current) => [card, ...current.filter((c) => c.id !== card.id)])
      setError(cause instanceof Error ? cause.message : 'Failed to delete card')
      return
    } finally {
      setPendingDeleteIds((current) => current.filter((id) => id !== card.id))
    }

    try {
      await loadCards()
    } catch {
      // Delete already succeeded; keep optimistic removal even if refresh fails.
    }
  }

  const toggleDetails = async (card: Card) => {
    if (expandedId === card.id) {
      setExpandedId(null)
      return
    }

    setExpandedId(card.id)
    setEventErrors((current) => ({ ...current, [card.id]: '' }))
    try {
      const res = await fetch(`/api/cards/${card.id}/events`)
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load task history'))
      const data = (await res.json()) as { events: TaskEvent[] }
      setEventsByCard((current) => ({ ...current, [card.id]: data.events }))
    } catch (cause) {
      setEventErrors((current) => ({
        ...current,
        [card.id]: cause instanceof Error ? cause.message : 'Failed to load task history',
      }))
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Nova KanbanX</h1>
          <p>Durable workboard for agents, handoffs, and human checkpoints.</p>
        </div>
        <div className="board-stats">
          <span>{cards.length} total</span>
          <span>{filteredCards.length} visible</span>
        </div>
      </header>

      <section className="controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks and durable context"
        />
        <div className="lane-pills">
          <button
            type="button"
            className={laneFilter === 'All' ? 'active' : ''}
            onClick={() => setLaneFilter('All')}
          >
            All
          </button>
          {laneOrder.map((lane) => (
            <button
              key={lane}
              type="button"
              className={laneFilter === lane ? 'active' : ''}
              onClick={() => setLaneFilter(lane)}
            >
              {lane}
            </button>
          ))}
        </div>
      </section>

      <form className="new-card" onSubmit={createCard}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
          required
        />
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tags,comma,separated"
        />
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          aria-label="Priority"
        >
          {priorityOrder.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit">Create card</button>
      </form>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <p className="loading">Loading board...</p>
      ) : (
        <section className="board">
          {grouped.map((column) => (
            <article key={column.lane} className="lane">
              <div className="lane-header">
                <h2>{column.lane}</h2>
                <span>{column.cards.length}</span>
              </div>
              <div className="stack">
                {column.cards.map((card) => {
                  const isEditing = editingId === card.id && draft
                  return (
                    <div key={card.id} className="card">
                      {isEditing ? (
                        <>
                          <input
                            value={draft.title}
                            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                            placeholder="Title"
                          />
                          <textarea
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                            placeholder="Description"
                          />
                          <input
                            value={draft.owner}
                            onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
                            placeholder="Owner"
                          />
                          <input
                            value={draft.tags}
                            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                            placeholder="tags,comma,separated"
                          />
                          <div className="field-grid">
                            <label>
                              <span>Lane</span>
                              <select
                                value={draft.lane}
                                onChange={(e) => setDraft({ ...draft, lane: e.target.value as Lane })}
                              >
                                {[card.lane, ...allowedTransitions[card.lane]].map((lane) => (
                                  <option key={lane} value={lane}>
                                    {lane}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>Priority</span>
                              <select
                                value={draft.priority}
                                onChange={(e) =>
                                  setDraft({ ...draft, priority: e.target.value as Priority })
                                }
                              >
                                {priorityOrder.map((value) => (
                                  <option key={value} value={value}>
                                    {value}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>Source</span>
                              <input
                                value={draft.source}
                                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                                placeholder="Source"
                              />
                            </label>
                            <label>
                              <span>External ID</span>
                              <input
                                value={draft.externalId}
                                onChange={(e) => setDraft({ ...draft, externalId: e.target.value })}
                                placeholder="External ID"
                              />
                            </label>
                            <label>
                              <span>Due</span>
                              <input
                                type="datetime-local"
                                value={draft.dueAt}
                                onChange={(e) => setDraft({ ...draft, dueAt: e.target.value })}
                              />
                            </label>
                          </div>
                          <textarea
                            value={draft.acceptanceCriteria}
                            onChange={(e) =>
                              setDraft({ ...draft, acceptanceCriteria: e.target.value })
                            }
                            placeholder="Acceptance criteria"
                          />
                          <textarea
                            value={draft.blockedReason}
                            onChange={(e) => setDraft({ ...draft, blockedReason: e.target.value })}
                            placeholder="Blocked reason"
                          />
                          <textarea
                            value={draft.nextAction}
                            onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })}
                            placeholder="Next action"
                          />
                          <textarea
                            value={draft.continuation}
                            onChange={(e) => setDraft({ ...draft, continuation: e.target.value })}
                            placeholder="Continuation / handoff"
                          />
                          <textarea
                            value={draft.evidence}
                            onChange={(e) => setDraft({ ...draft, evidence: e.target.value })}
                            placeholder="Evidence"
                          />
                          <div className="actions">
                            <button type="button" onClick={() => saveEdit(card)}>
                              Save
                            </button>
                            <button type="button" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <h3>{card.title}</h3>
                          <div className="meta">
                            <span>
                              {card.owner ? <span className="owner">{card.owner}</span> : 'Unassigned'}
                              <span className={`priority priority-${(card.priority ?? 'P2').toLowerCase()}`}>
                                {card.priority ?? 'P2'}
                              </span>
                            </span>
                            <span>{new Date(card.updatedAt).toLocaleDateString()}</span>
                          </div>
                          {card.description && <p>{card.description}</p>}
                          {card.tags.length > 0 && (
                            <div className="tags">
                              {card.tags.map((tag) => (
                                <span key={tag}>{tag}</span>
                              ))}
                            </div>
                          )}
                          <div className="actions">
                            <button type="button" onClick={() => toggleDetails(card)}>
                              {expandedId === card.id ? 'Hide details' : 'Details'}
                            </button>
                            <button type="button" onClick={() => startEdit(card)}>
                              Edit
                            </button>
                            {allowedTransitions[card.lane].map((lane) => (
                              <button
                                key={lane}
                                type="button"
                                onClick={() => moveCard(card, lane)}
                              >
                                {lane}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="danger"
                              onClick={() => deleteCard(card)}
                              disabled={pendingDeleteIds.includes(card.id)}
                            >
                              Delete
                            </button>
                          </div>
                          {expandedId === card.id && (
                            <section className="task-details" aria-label={`${card.title} details`}>
                              <div className="detail-summary">
                                <span>Task {card.taskKey ? card.taskKey.slice(0, 8) : `#${card.id}`}</span>
                                <span>Revision {card.revision}</span>
                                <span>{card.source || 'manual'}</span>
                                {card.externalId && <span>{card.externalId}</span>}
                                {card.dueAt && (
                                  <span>Due {new Date(card.dueAt).toLocaleString()}</span>
                                )}
                              </div>
                              <dl>
                                <div>
                                  <dt>Acceptance criteria</dt>
                                  <dd>{card.acceptanceCriteria || 'Not set'}</dd>
                                </div>
                                <div>
                                  <dt>Blocker</dt>
                                  <dd>{card.blockedReason || 'None'}</dd>
                                </div>
                                <div>
                                  <dt>Next action</dt>
                                  <dd>{card.nextAction || 'Not set'}</dd>
                                </div>
                                <div>
                                  <dt>Continuation</dt>
                                  <dd>{card.continuation || 'Not set'}</dd>
                                </div>
                                <div>
                                  <dt>Evidence</dt>
                                  <dd>{card.evidence || 'Not set'}</dd>
                                </div>
                              </dl>
                              <div className="event-history">
                                <h4>Event history</h4>
                                {eventErrors[card.id] ? (
                                  <p className="inline-error">{eventErrors[card.id]}</p>
                                ) : eventsByCard[card.id] ? (
                                  <ol>
                                    {eventsByCard[card.id].map((taskEvent) => (
                                      <li key={taskEvent.eventId}>
                                        <span>{taskEvent.eventType}</span>
                                        {taskEvent.fromLane && taskEvent.toLane && (
                                          <span>
                                            {taskEvent.fromLane} → {taskEvent.toLane}
                                          </span>
                                        )}
                                        <time>{new Date(taskEvent.createdAt).toLocaleString()}</time>
                                      </li>
                                    ))}
                                  </ol>
                                ) : (
                                  <p>Loading history…</p>
                                )}
                              </div>
                            </section>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}

export default App
