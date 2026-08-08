import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import './App.css'

type Lane = 'TRIAGE' | 'TODO' | 'READY' | 'RUNNING' | 'BLOCKED' | 'DONE'
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
type ItemType = 'PROJECT' | 'MILESTONE' | 'TASK'
type ReminderStatus = 'NONE' | 'PENDING' | 'DELIVERED' | 'ACKNOWLEDGED' | 'CANCELLED'
type AgendaView = 'inbox' | 'overdue' | 'today' | 'upcoming' | 'waiting' | 'done'
type EnergyDemand = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH'
type RecurrenceFrequency = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
type ReviewEnergy = 'ANY' | Exclude<EnergyDemand, 'UNKNOWN'>

type Progress = {
  completed: number
  total: number
  percent: number | null
}

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
  itemType: ItemType
  parentId: number | null
  goal: string
  estimateMinutes: number | null
  position: number
  progress: Progress
  capturedText: string
  remindAt: string | null
  reminderTimezone: string
  reminderStatus: ReminderStatus
  reminderAcknowledgedAt: string | null
  reviewedAt: string | null
  energyDemand: EnergyDemand
  recurrenceFrequency: RecurrenceFrequency
  recurrenceInterval: number
  recurrenceEndAt: string | null
  recurrenceOccurrences: number
  createdAt: string
  updatedAt: string
}

type ChecklistItem = {
  id: number
  cardId: number
  text: string
  isDone: boolean
  position: number
  revision: number
}

type StructureNode = Card & {
  checklist: ChecklistItem[]
  children: StructureNode[]
}

type RestartPacket = {
  goal: string
  progress: Progress
  currentMilestone: Card | null
  nextTask: Card | null
  nextAction: string | null
  definitionOfDone: string | null
  estimatedMinutes: number | null
  continuation: string | null
  evidence: string | null
  blockers: Card[]
  recentlyCompleted: Card[]
}

type Agenda = {
  timezone: string
  generatedAt: string
  counts: Record<AgendaView, number>
  sections: Record<AgendaView, Card[]>
}

type ReminderDeliveryStatus = {
  configured: boolean
  pollMs: number
  counts: { pending: number; due: number }
  latestReceipts: Array<{
    deliveryId: string
    status: 'ATTEMPTING' | 'FAILED' | 'DELIVERED'
    attemptCount: number
    updatedAt: string
    error: string | null
  }>
}

type DailyReview = {
  message: string
  preferences: { availableMinutes: number; energy: ReviewEnergy }
  counts: { inbox: number; overdue: number; today: number; waiting: number; needsClarity: number }
  focus: { card: Card; action: string; reasons: string[] } | null
  quickWins: Card[]
  needsClarity: Card[]
}

type WeeklyReviewSection = 'wins' | 'inbox' | 'waiting' | 'projects' | 'stale' | 'unplanned'

type WeeklyReview = {
  message: string
  counts: Record<WeeklyReviewSection, number>
  sections: Record<WeeklyReviewSection, Card[]>
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
  goal: string
  estimateMinutes: string
  energyDemand: EnergyDemand
  recurrenceFrequency: RecurrenceFrequency
  recurrenceInterval: string
  recurrenceEndAt: string
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
const recurrenceLabels: Record<RecurrenceFrequency, string> = {
  NONE: 'Once',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
}

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
  const [itemType, setItemType] = useState<'PROJECT' | 'TASK'>('TASK')
  const [remindAt, setRemindAt] = useState('')
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>('NONE')
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
  const [structureByCard, setStructureByCard] = useState<Record<number, StructureNode>>({})
  const [restartByCard, setRestartByCard] = useState<Record<number, RestartPacket>>({})
  const [newItemText, setNewItemText] = useState<Record<number, string>>({})
  const [agenda, setAgenda] = useState<Agenda | null>(null)
  const [agendaView, setAgendaView] = useState<AgendaView | null>(null)
  const [reminderDelivery, setReminderDelivery] = useState<ReminderDeliveryStatus | null>(null)
  const [showReminderDelivery, setShowReminderDelivery] = useState(false)
  const [reviewMode, setReviewMode] = useState<'daily' | 'weekly' | null>(null)
  const [dailyReview, setDailyReview] = useState<DailyReview | null>(null)
  const [weeklyReview, setWeeklyReview] = useState<WeeklyReview | null>(null)
  const [availableMinutes, setAvailableMinutes] = useState('30')
  const [reviewEnergy, setReviewEnergy] = useState<ReviewEnergy>('ANY')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

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
      const res = await fetch('/api/cards?scope=roots')
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

  const loadAgenda = async (view: AgendaView) => {
    setError('')
    try {
      const res = await fetch(`/api/agenda?timezone=${encodeURIComponent(timezone)}`)
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load notebook view'))
      const data = (await res.json()) as Agenda
      setAgenda(data)
      setAgendaView(view)
      setReviewMode(null)
      setShowReminderDelivery(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load notebook view')
    }
  }

  const toggleReminderDelivery = async () => {
    if (showReminderDelivery) {
      setShowReminderDelivery(false)
      return
    }
    setError('')
    try {
      const res = await fetch('/api/reminders/status')
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load reminder delivery status'))
      setReminderDelivery((await res.json()) as ReminderDeliveryStatus)
      setShowReminderDelivery(true)
      setReviewMode(null)
      setAgendaView(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load reminder delivery status')
    }
  }

  const loadDailyReview = async () => {
    setError('')
    try {
      const params = new URLSearchParams({
        timezone,
        availableMinutes,
        energy: reviewEnergy,
      })
      const res = await fetch(`/api/review/daily?${params.toString()}`)
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load daily focus'))
      setDailyReview((await res.json()) as DailyReview)
      setReviewMode('daily')
      setAgendaView(null)
      setShowReminderDelivery(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load daily focus')
    }
  }

  const loadWeeklyReview = async () => {
    setError('')
    try {
      const res = await fetch(`/api/review/weekly?timezone=${encodeURIComponent(timezone)}`)
      if (!res.ok) throw new Error(await responseError(res, 'Failed to load weekly reset'))
      setWeeklyReview((await res.json()) as WeeklyReview)
      setReviewMode('weekly')
      setAgendaView(null)
      setShowReminderDelivery(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load weekly reset')
    }
  }

  const snoozeCard = async (card: Card, days: number) => {
    setError('')
    try {
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      const res = await fetch(`/api/cards/${card.id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          until,
          timezone,
          expectedRevision: card.revision,
          eventId: newEventId(),
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to snooze task'))
      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
      if (reviewMode === 'daily') await loadDailyReview()
      if (reviewMode === 'weekly') await loadWeeklyReview()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to snooze task')
    }
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
      const endpoint = itemType === 'TASK' ? '/api/capture' : '/api/cards'
      const reminder = remindAt
        ? {
            remindAt: new Date(remindAt).toISOString(),
            reminderTimezone: timezone,
            recurrenceFrequency,
          }
        : {}
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: newEventId(),
          title: title.trim(),
          ...(itemType === 'TASK' ? { text: title.trim() } : {}),
          itemType,
          owner: owner.trim(),
          priority,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          ...reminder,
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to create card'))

      setTitle('')
      setOwner('')
      setTags('')
      setPriority('P2')
      setItemType('TASK')
      setRemindAt('')
      setRecurrenceFrequency('NONE')
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
      goal: card.goal ?? '',
      estimateMinutes: card.estimateMinutes?.toString() ?? '',
      energyDemand: card.energyDemand ?? 'UNKNOWN',
      recurrenceFrequency: card.recurrenceFrequency ?? 'NONE',
      recurrenceInterval: String(card.recurrenceInterval ?? 1),
      recurrenceEndAt: toDateTimeInput(card.recurrenceEndAt),
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
      goal: draft.goal.trim(),
      estimateMinutes: draft.estimateMinutes ? Number(draft.estimateMinutes) : null,
      energyDemand: draft.energyDemand,
      recurrenceFrequency: draft.recurrenceFrequency,
      recurrenceInterval: Number(draft.recurrenceInterval) || 1,
      recurrenceEndAt:
        draft.recurrenceFrequency !== 'NONE' && draft.recurrenceEndAt
          ? new Date(draft.recurrenceEndAt).toISOString()
          : null,
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
          goal: nextCard.goal,
          estimateMinutes: nextCard.estimateMinutes,
          energyDemand: nextCard.energyDemand,
          recurrenceFrequency: nextCard.recurrenceFrequency,
          recurrenceInterval: nextCard.recurrenceInterval,
          recurrenceEndAt: nextCard.recurrenceEndAt,
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

  const acknowledgeReminder = async (card: Card) => {
    setError('')
    try {
      const res = await fetch(`/api/cards/${card.id}/reminders/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: card.revision,
          eventId: newEventId(),
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to acknowledge reminder'))
      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
      if (agendaView) await loadAgenda(agendaView)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to acknowledge reminder')
    }
  }

  const promoteCard = async (card: Card) => {
    setError('')
    try {
      const res = await fetch(`/api/cards/${card.id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: card.revision,
          eventId: newEventId(),
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to make project'))
      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to make project')
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
      const structureRes = await fetch(`/api/cards/${card.id}/structure`)
      if (!structureRes.ok) throw new Error(await responseError(structureRes, 'Failed to load work breakdown'))
      const structureData = (await structureRes.json()) as { structure: StructureNode }
      setStructureByCard((current) => ({ ...current, [card.id]: structureData.structure }))

      const eventsRes = await fetch(`/api/cards/${card.id}/events`)
      if (!eventsRes.ok) throw new Error(await responseError(eventsRes, 'Failed to load task history'))
      const eventData = (await eventsRes.json()) as { events: TaskEvent[] }
      setEventsByCard((current) => ({ ...current, [card.id]: eventData.events }))
    } catch (cause) {
      setEventErrors((current) => ({
        ...current,
        [card.id]: cause instanceof Error ? cause.message : 'Failed to load task history',
      }))
    }
  }

  const refreshStructure = async (rootId: number) => {
    const res = await fetch(`/api/cards/${rootId}/structure`)
    if (!res.ok) throw new Error(await responseError(res, 'Failed to refresh work breakdown'))
    const data = (await res.json()) as { structure: StructureNode }
    setStructureByCard((current) => ({ ...current, [rootId]: data.structure }))
    await loadCards()
  }

  const addNestedItem = async (rootId: number, parent: StructureNode) => {
    const text = newItemText[parent.id]?.trim()
    if (!text) return
    setError('')
    try {
      const endpoint = parent.itemType === 'TASK' ? `/api/cards/${parent.id}/checklist` : '/api/cards'
      const body = parent.itemType === 'TASK'
        ? { text, expectedRevision: parent.revision, eventId: newEventId() }
        : {
            title: text,
            itemType: parent.itemType === 'PROJECT' ? 'MILESTONE' : 'TASK',
            parentId: parent.id,
            eventId: newEventId(),
          }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to add the next step'))
      setNewItemText((current) => ({ ...current, [parent.id]: '' }))
      await refreshStructure(rootId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to add the next step')
    }
  }

  const toggleChecklist = async (rootId: number, item: ChecklistItem) => {
    setError('')
    try {
      const res = await fetch(`/api/checklist-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isDone: !item.isDone,
          expectedRevision: item.revision,
          eventId: newEventId(),
        }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to update the checklist'))
      await refreshStructure(rootId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update the checklist')
    }
  }

  const moveNestedCard = async (rootId: number, card: StructureNode, lane: Lane) => {
    setError('')
    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lane, expectedRevision: card.revision, eventId: newEventId() }),
      })
      if (!res.ok) throw new Error(await responseError(res, 'Failed to move the step'))
      await refreshStructure(rootId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to move the step')
    }
  }

  const loadRestartPacket = async (cardId: number) => {
    setError('')
    try {
      const res = await fetch(`/api/cards/${cardId}/restart-packet`)
      if (!res.ok) throw new Error(await responseError(res, 'Failed to find the next step'))
      const data = (await res.json()) as { restartPacket: RestartPacket }
      setRestartByCard((current) => ({ ...current, [cardId]: data.restartPacket }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to find the next step')
    }
  }

  const renderStructure = (rootId: number, node: StructureNode, depth = 0) => (
    <div className="work-node" key={node.id} style={{ '--depth': depth } as CSSProperties}>
      <div className="work-node-heading">
        <span className="type-badge">{node.itemType}</span>
        <strong>{node.title}</strong>
        <span className={`lane-chip lane-${node.lane.toLowerCase()}`}>{node.lane}</span>
        {node.progress.total > 0 && <span>{node.progress.completed}/{node.progress.total}</span>}
      </div>
      {node.itemType === 'TASK' && (
        <div className="nested-actions">
          {allowedTransitions[node.lane].map((lane) => (
            <button type="button" key={lane} onClick={() => moveNestedCard(rootId, node, lane)}>
              Move to {lane}
            </button>
          ))}
        </div>
      )}
      {node.checklist.length > 0 && (
        <ul className="checklist">
          {node.checklist.map((item) => (
            <li key={item.id}>
              <label>
                <input type="checkbox" checked={item.isDone} onChange={() => toggleChecklist(rootId, item)} />
                <span>{item.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <form
        className="add-step"
        onSubmit={(event) => {
          event.preventDefault()
          void addNestedItem(rootId, node)
        }}
      >
        <input
          value={newItemText[node.id] ?? ''}
          onChange={(event) => setNewItemText((current) => ({ ...current, [node.id]: event.target.value }))}
          placeholder={node.itemType === 'TASK' ? 'Add a tiny checklist step' : node.itemType === 'PROJECT' ? 'Add a milestone' : 'Add a task'}
          aria-label={`Add to ${node.title}`}
        />
        <button type="submit">Add</button>
      </form>
      {node.children.map((child) => renderStructure(rootId, child, depth + 1))}
    </div>
  )

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Nova KanbanX</h1>
          <p>Nova's notebook for remembering, breaking work down, and finding the next small step.</p>
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
        <label className="reminder-field">
          <span>Remind me</span>
          <input
            type="datetime-local"
            value={remindAt}
            onChange={(e) => {
              setRemindAt(e.target.value)
              if (!e.target.value) setRecurrenceFrequency('NONE')
            }}
            aria-label="Reminder time"
          />
        </label>
        <label className="reminder-field">
          <span>Repeat</span>
          <select
            value={recurrenceFrequency}
            onChange={(e) => setRecurrenceFrequency(e.target.value as RecurrenceFrequency)}
            disabled={!remindAt}
            aria-label="Repeat reminder"
          >
            {(Object.keys(recurrenceLabels) as RecurrenceFrequency[]).map((value) => (
              <option key={value} value={value}>{recurrenceLabels[value]}</option>
            ))}
          </select>
        </label>
        <select
          value={itemType}
          onChange={(e) => setItemType(e.target.value as 'PROJECT' | 'TASK')}
          aria-label="Item type"
        >
          <option value="TASK">Task</option>
          <option value="PROJECT">Project</option>
        </select>
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

      <section className="notebook-views" aria-label="Notebook views">
        <div className="view-buttons">
          {(
            [
              ['inbox', 'Inbox'],
              ['overdue', 'Overdue'],
              ['today', 'Today'],
              ['upcoming', 'Upcoming'],
              ['waiting', 'Waiting'],
              ['done', 'Done'],
            ] as Array<[AgendaView, string]>
          ).map(([view, label]) => (
            <button
              type="button"
              key={view}
              className={agendaView === view ? 'active' : ''}
              onClick={() => loadAgenda(view)}
            >
              {label}
              {agenda && <span>{agenda.counts[view]}</span>}
            </button>
          ))}
          <button
            type="button"
            className={reviewMode === 'daily' ? 'active' : ''}
            onClick={loadDailyReview}
          >
            Daily focus
          </button>
          <button
            type="button"
            className={reviewMode === 'weekly' ? 'active' : ''}
            onClick={loadWeeklyReview}
          >
            Weekly reset
          </button>
          <button
            type="button"
            className={showReminderDelivery ? 'active' : ''}
            onClick={toggleReminderDelivery}
          >
            Delivery status
          </button>
        </div>
        {showReminderDelivery && reminderDelivery && (
          <div className="delivery-panel" aria-live="polite">
            <div>
              <strong>Reminder delivery {reminderDelivery.configured ? 'active' : 'inactive'}</strong>
              <span>
                {reminderDelivery.counts.due} due · {reminderDelivery.counts.pending} pending
              </span>
            </div>
            <p>
              {reminderDelivery.configured
                ? `Checks about every ${Math.round(reminderDelivery.pollMs / 1000)} seconds.`
                : 'Captured reminders are safe on the board. Configure a delivery hook when Nova is ready to send them.'}
            </p>
            {reminderDelivery.latestReceipts[0] && (
              <small>
                Latest: {reminderDelivery.latestReceipts[0].status.toLowerCase()} after{' '}
                {reminderDelivery.latestReceipts[0].attemptCount} attempt(s)
              </small>
            )}
          </div>
        )}
        {reviewMode === 'daily' && dailyReview && (
          <div className="review-panel daily-review" aria-live="polite">
            <div className="review-heading">
              <div>
                <span className="eyebrow">Today, gently</span>
                <strong>{dailyReview.message}</strong>
              </div>
              <div className="review-preferences">
                <label>
                  <span>Time</span>
                  <select value={availableMinutes} onChange={(e) => setAvailableMinutes(e.target.value)}>
                    <option value="10">10 min</option>
                    <option value="20">20 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                  </select>
                </label>
                <label>
                  <span>Energy</span>
                  <select
                    value={reviewEnergy}
                    onChange={(e) => setReviewEnergy(e.target.value as ReviewEnergy)}
                  >
                    <option value="ANY">Any</option>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </label>
                <button type="button" onClick={loadDailyReview}>Refresh</button>
              </div>
            </div>
            <div className="review-counts">
              <span>{dailyReview.counts.today} today</span>
              <span>{dailyReview.counts.overdue} overdue</span>
              <span>{dailyReview.counts.waiting} waiting</span>
              <span>{dailyReview.counts.needsClarity} need clarity</span>
            </div>
            {dailyReview.focus ? (
              <article className="focus-card">
                <span className="eyebrow">One next action</span>
                <h3>{dailyReview.focus.action}</h3>
                <p>{dailyReview.focus.card.title}</p>
                <div className="focus-meta">
                  <span>{dailyReview.focus.card.priority}</span>
                  {dailyReview.focus.card.estimateMinutes !== null && (
                    <span>{dailyReview.focus.card.estimateMinutes} min</span>
                  )}
                  {dailyReview.focus.card.energyDemand !== 'UNKNOWN' && (
                    <span>{dailyReview.focus.card.energyDemand.toLowerCase()} energy</span>
                  )}
                </div>
                <ul>
                  {dailyReview.focus.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
                <div className="focus-actions">
                  <button type="button" onClick={() => snoozeCard(dailyReview.focus!.card, 1)}>
                    Snooze 1 day
                  </button>
                  <button type="button" onClick={() => snoozeCard(dailyReview.focus!.card, 7)}>
                    Snooze 1 week
                  </button>
                </div>
              </article>
            ) : (
              <p className="review-empty">Nothing is asking for attention right now.</p>
            )}
            {dailyReview.quickWins.length > 0 && (
              <div className="quick-wins">
                <strong>Small wins if you want one</strong>
                <ul>{dailyReview.quickWins.map((card) => <li key={card.id}>{card.title} · {card.estimateMinutes} min</li>)}</ul>
              </div>
            )}
          </div>
        )}
        {reviewMode === 'weekly' && weeklyReview && (
          <div className="review-panel weekly-review" aria-live="polite">
            <div className="review-heading">
              <div>
                <span className="eyebrow">Weekly reset</span>
                <strong>{weeklyReview.message}</strong>
              </div>
              <button type="button" onClick={loadWeeklyReview}>Refresh</button>
            </div>
            <div className="weekly-grid">
              {(
                [
                  ['wins', 'Wins'],
                  ['inbox', 'Inbox'],
                  ['waiting', 'Waiting'],
                  ['projects', 'Open projects'],
                  ['stale', 'Worth revisiting'],
                  ['unplanned', 'Need a next step'],
                ] as Array<[WeeklyReviewSection, string]>
              ).map(([section, label]) => (
                <section key={section}>
                  <strong>{weeklyReview.counts[section]}</strong>
                  <span>{label}</span>
                  {weeklyReview.sections[section].slice(0, 3).map((card) => (
                    <small key={card.id}>{card.title}</small>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}
        {agendaView && agenda && (
          <div className="agenda-panel">
            <div className="agenda-heading">
              <strong>{agendaView}</strong>
              <span>{agenda.sections[agendaView].length} item(s)</span>
            </div>
            {agenda.sections[agendaView].length === 0 ? (
              <p>Nothing here right now.</p>
            ) : (
              <ul>
                {agenda.sections[agendaView].map((agendaCard) => (
                  <li key={agendaCard.id}>
                    <div>
                      <strong>{agendaCard.title}</strong>
                      <span>{agendaCard.lane}</span>
                      {(agendaCard.remindAt || agendaCard.dueAt) && (
                        <time>
                          {new Date(agendaCard.remindAt || agendaCard.dueAt!).toLocaleString()}
                        </time>
                      )}
                    </div>
                    {(agendaCard.reminderStatus === 'PENDING' ||
                      agendaCard.reminderStatus === 'DELIVERED') && (
                      <button type="button" onClick={() => acknowledgeReminder(agendaCard)}>
                        Acknowledge
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

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
                          <textarea
                            value={draft.goal}
                            onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                            placeholder="Goal / why this matters"
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
                            <label>
                              <span>Minutes</span>
                              <input
                                type="number"
                                min="0"
                                value={draft.estimateMinutes}
                                onChange={(e) => setDraft({ ...draft, estimateMinutes: e.target.value })}
                                placeholder="15"
                              />
                            </label>
                            <label>
                              <span>Energy</span>
                              <select
                                value={draft.energyDemand}
                                onChange={(e) =>
                                  setDraft({ ...draft, energyDemand: e.target.value as EnergyDemand })
                                }
                              >
                                <option value="UNKNOWN">Not set</option>
                                <option value="LOW">Low</option>
                                <option value="MEDIUM">Medium</option>
                                <option value="HIGH">High</option>
                              </select>
                            </label>
                            {card.remindAt && (
                              <>
                                <label>
                                  <span>Repeat</span>
                                  <select
                                    value={draft.recurrenceFrequency}
                                    onChange={(e) =>
                                      setDraft({
                                        ...draft,
                                        recurrenceFrequency: e.target.value as RecurrenceFrequency,
                                        recurrenceEndAt:
                                          e.target.value === 'NONE' ? '' : draft.recurrenceEndAt,
                                      })
                                    }
                                  >
                                    {(Object.keys(recurrenceLabels) as RecurrenceFrequency[]).map((value) => (
                                      <option key={value} value={value}>{recurrenceLabels[value]}</option>
                                    ))}
                                  </select>
                                </label>
                                {draft.recurrenceFrequency !== 'NONE' && (
                                  <>
                                    <label>
                                      <span>Every</span>
                                      <input
                                        type="number"
                                        min="1"
                                        max="365"
                                        value={draft.recurrenceInterval}
                                        onChange={(e) => setDraft({ ...draft, recurrenceInterval: e.target.value })}
                                      />
                                    </label>
                                    <label>
                                      <span>Repeat until</span>
                                      <input
                                        type="datetime-local"
                                        value={draft.recurrenceEndAt}
                                        onChange={(e) => setDraft({ ...draft, recurrenceEndAt: e.target.value })}
                                      />
                                    </label>
                                  </>
                                )}
                              </>
                            )}
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
                          <div className="card-heading">
                            <h3>{card.title}</h3>
                            <span className="type-badge">{card.itemType ?? 'TASK'}</span>
                          </div>
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
                          {(card.reminderStatus === 'PENDING' || card.reminderStatus === 'DELIVERED') &&
                            card.remindAt && (
                            <div className="reminder-chip">
                              <span>
                                {card.recurrenceFrequency && card.recurrenceFrequency !== 'NONE'
                                  ? `${recurrenceLabels[card.recurrenceFrequency]} · Next `
                                  : 'Remind '}
                                {new Date(card.remindAt).toLocaleString()}
                              </span>
                              <button type="button" onClick={() => acknowledgeReminder(card)}>
                                Acknowledge
                              </button>
                            </div>
                          )}
                          {card.progress?.total > 0 && (
                            <div className="progress-wrap" aria-label={`${card.progress.percent}% complete`}>
                              <div className="progress-label">
                                <span>{card.progress.completed} of {card.progress.total} complete</span>
                                <strong>{card.progress.percent}%</strong>
                              </div>
                              <div className="progress-track">
                                <span style={{ width: `${card.progress.percent}%` }} />
                              </div>
                            </div>
                          )}
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
                            <button type="button" className="continue-button" onClick={() => loadRestartPacket(card.id)}>
                              What next?
                            </button>
                            <button type="button" onClick={() => startEdit(card)}>
                              Edit
                            </button>
                            {card.itemType === 'TASK' && card.parentId === null && card.source !== 'loopx' && (
                              <button type="button" onClick={() => promoteCard(card)}>
                                Make project
                              </button>
                            )}
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
                          {restartByCard[card.id] && (
                            <aside className="restart-card" aria-label={`${card.title} next step`}>
                              <span className="eyebrow">Continue from here</span>
                              <strong>{restartByCard[card.id].nextAction || 'Everything here is complete.'}</strong>
                              {restartByCard[card.id].currentMilestone && (
                                <span>Milestone: {restartByCard[card.id].currentMilestone?.title}</span>
                              )}
                              {restartByCard[card.id].estimatedMinutes !== null && (
                                <span>About {restartByCard[card.id].estimatedMinutes} minutes</span>
                              )}
                              {restartByCard[card.id].definitionOfDone && (
                                <small>Done when: {restartByCard[card.id].definitionOfDone}</small>
                              )}
                              {restartByCard[card.id].blockers.length > 0 && (
                                <small>{restartByCard[card.id].blockers.length} blocker(s) need attention</small>
                              )}
                            </aside>
                          )}
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
                                {card.estimateMinutes != null && <span>{card.estimateMinutes} min</span>}
                                {card.energyDemand && card.energyDemand !== 'UNKNOWN' && (
                                  <span>{card.energyDemand.toLowerCase()} energy</span>
                                )}
                                {card.remindAt && (
                                  <span>Reminder {new Date(card.remindAt).toLocaleString()}</span>
                                )}
                                {card.recurrenceFrequency && card.recurrenceFrequency !== 'NONE' && (
                                  <span>
                                    {recurrenceLabels[card.recurrenceFrequency]} · {card.recurrenceOccurrences} acknowledged
                                  </span>
                                )}
                              </div>
                              <dl>
                                <div>
                                  <dt>Goal</dt>
                                  <dd>{card.goal || 'Not set'}</dd>
                                </div>
                                <div>
                                  <dt>Captured thought</dt>
                                  <dd>{card.capturedText || 'Not set'}</dd>
                                </div>
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
                              <div className="work-breakdown">
                                <h4>Small steps</h4>
                                {structureByCard[card.id] ? (
                                  renderStructure(card.id, structureByCard[card.id])
                                ) : (
                                  <p>Loading work breakdown…</p>
                                )}
                              </div>
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
