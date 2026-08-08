import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type MockCard = {
  id: number
  title: string
  description: string
  lane: 'TRIAGE' | 'TODO' | 'READY' | 'RUNNING' | 'BLOCKED' | 'DONE'
  owner: string
  tags: string[]
  taskKey: string
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
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
  itemType: 'PROJECT' | 'MILESTONE' | 'TASK'
  parentId: number | null
  goal: string
  estimateMinutes: number | null
  position: number
  progress: { completed: number; total: number; percent: number | null }
  capturedText: string
  remindAt: string | null
  reminderTimezone: string
  reminderStatus: 'NONE' | 'PENDING' | 'DELIVERED' | 'ACKNOWLEDGED' | 'CANCELLED'
  reminderAcknowledgedAt: string | null
  reviewedAt: string | null
  energyDemand: 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH'
  recurrenceFrequency: 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  recurrenceInterval: number
  recurrenceEndAt: string | null
  recurrenceOccurrences: number
  createdAt: string
  updatedAt: string
}

const sampleCard: MockCard = {
  id: 1,
  title: 'Card A',
  description: '',
  lane: 'TRIAGE',
  owner: '',
  tags: [],
  taskKey: '11111111-1111-4111-8111-111111111111',
  priority: 'P1',
  source: 'openclaw',
  externalId: 'run-1',
  acceptanceCriteria: 'Ship when green',
  blockedReason: '',
  nextAction: 'Run the suite',
  continuation: 'Resume from verification',
  evidence: 'test://suite',
  dueAt: null,
  startedAt: null,
  completedAt: null,
  revision: 1,
  itemType: 'TASK',
  parentId: null,
  goal: '',
  estimateMinutes: null,
  position: 0,
  progress: { completed: 0, total: 0, percent: null },
  capturedText: '',
  remindAt: null,
  reminderTimezone: '',
  reminderStatus: 'NONE',
  reminderAcknowledgedAt: null,
  reviewedAt: null,
  energyDemand: 'UNKNOWN',
  recurrenceFrequency: 'NONE',
  recurrenceInterval: 1,
  recurrenceEndAt: null,
  recurrenceOccurrences: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App optimistic behavior', () => {
  it('shows durable task context and event history on demand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ structure: { ...sampleCard, checklist: [], children: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: [
            {
              eventId: 'evt-1',
              eventType: 'card.created',
              fromLane: null,
              toLane: 'TRIAGE',
              resultStatus: 201,
              createdAt: '2026-08-06T12:00:00.000Z',
            },
          ],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card') as HTMLElement
    expect(within(card).getByText('P1')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Details' }))

    expect(await within(card).findByText('Ship when green')).toBeInTheDocument()
    expect(within(card).getByText('Run the suite')).toBeInTheDocument()
    expect(within(card).getByText('Resume from verification')).toBeInTheDocument()
    expect(within(card).getByText('test://suite')).toBeInTheDocument()
    expect(await within(card).findByText('card.created')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/cards/1/events')
  })

  it('edits durable fields with a revision guard', async () => {
    const updatedCard = {
      ...sampleCard,
      priority: 'P0' as const,
      nextAction: 'Deploy the verified build',
      revision: 2,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: updatedCard }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(card).getByPlaceholderText('Next action'), {
      target: { value: 'Deploy the verified build' },
    })
    fireEvent.change(within(card).getByLabelText('Priority'), { target: { value: 'P0' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', expect.any(Object))
    })
    const updateRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/cards/1' && init?.method === 'PATCH',
    )?.[1] as RequestInit | undefined
    const updateBody = JSON.parse(String(updateRequest?.body)) as {
      priority: string
      nextAction: string
      expectedRevision: number
      eventId: string
    }
    expect(updateBody).toMatchObject({
      priority: 'P0',
      nextAction: 'Deploy the verified build',
      expectedRevision: 1,
    })
    expect(updateBody.eventId).toBeTruthy()
    await waitFor(() => {
      expect(within(card).getByText('P0')).toBeInTheDocument()
    })
  })

  it('adds an event id when creating a card', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    const titleInput = screen.getByPlaceholderText('Card title')
    fireEvent.change(titleInput, { target: { value: 'New durable card' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/capture', expect.objectContaining({ method: 'POST' }))
    })

    const createRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/capture' && init?.method === 'POST',
    )?.[1] as RequestInit | undefined
    const createBody = JSON.parse(String(createRequest?.body)) as {
      title: string
      text: string
      eventId: string
    }
    expect(createBody).toMatchObject({ title: 'New durable card', text: 'New durable card' })
    expect(createBody.eventId).toBeTruthy()
  })

  it('offers valid transitions, sends guarded events, and shows move errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          allowedTransitions: {
            TRIAGE: ['TODO'],
            TODO: ['TRIAGE', 'READY'],
            READY: ['TODO', 'RUNNING'],
            RUNNING: ['READY', 'BLOCKED', 'DONE'],
            BLOCKED: ['TODO', 'READY', 'RUNNING'],
            DONE: ['TRIAGE'],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'revision conflict' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).queryByRole('button', { name: 'RUNNING' })).toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'TODO' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', expect.any(Object))
    })

    const moveRequest = fetchMock.mock.calls.find(([url]) => url === '/api/cards/1')?.[1] as
      | RequestInit
      | undefined
    const moveBody = JSON.parse(String(moveRequest?.body)) as {
      lane: string
      expectedRevision: number
      eventId: string
    }
    expect(moveBody).toMatchObject({ lane: 'TODO', expectedRevision: 1 })
    expect(moveBody.eventId).toBeTruthy()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards?scope=roots')
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('revision conflict')
    expect(screen.getByText('Card A')).toBeInTheDocument()
  })

  it('deletes a card and reloads from API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/cards/1',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    const deleteRequest = fetchMock.mock.calls.find(([url]) => url === '/api/cards/1')?.[1] as
      | RequestInit
      | undefined
    expect((deleteRequest?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards?scope=roots')
    })

    await waitFor(() => {
      expect(screen.queryByText('Card A')).not.toBeInTheDocument()
    })
  })

  it('keeps card deleted when refresh fails after successful delete', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('refresh failed'))

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/cards/1',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    await waitFor(() => {
      expect(screen.queryByText('Card A')).not.toBeInTheDocument()
    })
  })

  it('creates a project from quick capture', async () => {
    const project = {
      ...sampleCard,
      id: 10,
      title: 'Assistant notebook',
      itemType: 'PROJECT' as const,
      goal: 'Remember what matters',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: project }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [project] }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.change(screen.getByPlaceholderText('Card title'), {
      target: { value: 'Assistant notebook' },
    })
    fireEvent.change(screen.getByLabelText('Item type'), { target: { value: 'PROJECT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards', expect.objectContaining({ method: 'POST' }))
    })
    const requestBody = JSON.parse(
      String(fetchMock.mock.calls.find(([url, init]) => url === '/api/cards' && init?.method === 'POST')?.[1]?.body),
    ) as { title: string; itemType: string }
    expect(requestBody).toMatchObject({ title: 'Assistant notebook', itemType: 'PROJECT' })
  })

  it('shows the restart action and adds a milestone in the small-step view', async () => {
    const project = {
      ...sampleCard,
      id: 20,
      title: 'Assistant notebook',
      itemType: 'PROJECT' as const,
      goal: 'Remember what matters',
      progress: { completed: 1, total: 4, percent: 25 },
    }
    const structure = { ...project, checklist: [], children: [] }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [project] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          restartPacket: {
            goal: project.goal,
            progress: project.progress,
            currentMilestone: { ...sampleCard, title: 'Capture and review' },
            nextTask: { ...sampleCard, title: 'Add quick capture' },
            nextAction: 'Write down one thought',
            definitionOfDone: 'The thought is visible on the board',
            estimatedMinutes: 5,
            continuation: null,
            evidence: null,
            blockers: [],
            recentlyCompleted: [],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ structure }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ structure }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [project] }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Assistant notebook')

    const card = screen.getByText('Assistant notebook').closest('.card') as HTMLElement
    expect(within(card).getByText('25%')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'What next?' }))
    expect(await within(card).findByText('Write down one thought')).toBeInTheDocument()
    expect(within(card).getByText('About 5 minutes')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Details' }))
    const addInput = await within(card).findByLabelText('Add to Assistant notebook')
    fireEvent.change(addInput, { target: { value: 'Capture and review' } })
    fireEvent.submit(addInput.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards', expect.objectContaining({ method: 'POST' }))
    })
    const createBody = JSON.parse(
      String(
        fetchMock.mock.calls.find(
          ([url, init]) => url === '/api/cards' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    ) as { title: string; itemType: string; parentId: number }
    expect(createBody).toMatchObject({
      title: 'Capture and review',
      itemType: 'MILESTONE',
      parentId: 20,
    })
  })

  it('quick-captures a confirmed reminder with timezone context', async () => {
    const reminderCard = {
      ...sampleCard,
      id: 30,
      title: 'Pay the car payment',
      capturedText: 'Pay the car payment',
      remindAt: '2026-08-08T16:00:00.000Z',
      reminderTimezone: 'UTC',
      reminderStatus: 'PENDING' as const,
      recurrenceFrequency: 'MONTHLY' as const,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: reminderCard }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [reminderCard] }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.change(screen.getByPlaceholderText('Card title'), {
      target: { value: 'Pay the car payment' },
    })
    fireEvent.change(screen.getByLabelText('Reminder time'), {
      target: { value: '2026-08-08T09:00' },
    })
    fireEvent.change(screen.getByLabelText('Repeat reminder'), { target: { value: 'MONTHLY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/capture', expect.objectContaining({ method: 'POST' }))
    })
    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(
          ([url, init]) => url === '/api/capture' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    ) as { text: string; remindAt: string; reminderTimezone: string; recurrenceFrequency: string }
    expect(body.text).toBe('Pay the car payment')
    expect(Number.isNaN(Date.parse(body.remindAt))).toBe(false)
    expect(body.reminderTimezone).toBeTruthy()
    expect(body.recurrenceFrequency).toBe('MONTHLY')
    const card = (await screen.findByText('Pay the car payment')).closest('.card') as HTMLElement
    expect(within(card).getByText(/Monthly · Next/)).toBeInTheDocument()
  })

  it('opens agenda views and acknowledges a reminder', async () => {
    const pending = {
      ...sampleCard,
      id: 31,
      title: 'Pay the car payment',
      capturedText: 'Pay the car payment',
      remindAt: '2026-08-08T16:00:00.000Z',
      reminderTimezone: 'UTC',
      reminderStatus: 'PENDING' as const,
    }
    const acknowledged = {
      ...pending,
      reminderStatus: 'ACKNOWLEDGED' as const,
      reminderAcknowledgedAt: '2026-08-08T16:05:00.000Z',
      revision: 2,
    }
    const agenda = {
      timezone: 'UTC',
      generatedAt: '2026-08-08T12:00:00.000Z',
      counts: { inbox: 0, overdue: 0, today: 1, upcoming: 0, waiting: 0, done: 0 },
      sections: {
        inbox: [],
        overdue: [],
        today: [pending],
        upcoming: [],
        waiting: [],
        done: [],
      },
    }
    const refreshedAgenda = {
      ...agenda,
      counts: { ...agenda.counts, inbox: 1, today: 0 },
      sections: { ...agenda.sections, inbox: [acknowledged], today: [] },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [pending] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => agenda })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: acknowledged }) })
      .mockResolvedValueOnce({ ok: true, json: async () => refreshedAgenda })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Pay the car payment')
    const views = screen.getByLabelText('Notebook views')
    fireEvent.click(within(views).getByRole('button', { name: 'Today' }))
    expect(await within(views).findByText('1 item(s)')).toBeInTheDocument()
    fireEvent.click(within(views).getByRole('button', { name: 'Acknowledge' }))

    await waitFor(() => {
      expect(within(views).getByText('Nothing here right now.')).toBeInTheDocument()
    })
    const acknowledgeBody = JSON.parse(
      String(
        fetchMock.mock.calls.find(
          ([url, init]) => url === '/api/cards/31/reminders/acknowledge' && init?.method === 'POST',
        )?.[1]?.body,
      ),
    ) as { expectedRevision: number }
    expect(acknowledgeBody).toMatchObject({ expectedRevision: 1 })
  })

  it('shows reminder delivery status without changing the board', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          configured: false,
          pollMs: 60000,
          counts: { pending: 2, due: 1 },
          latestReceipts: [],
        }),
      })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Card A')
    fireEvent.click(screen.getByRole('button', { name: 'Delivery status' }))

    expect(await screen.findByText('Reminder delivery inactive')).toBeInTheDocument()
    expect(screen.getByText('1 due · 2 pending')).toBeInTheDocument()
    expect(screen.getByText(/Captured reminders are safe on the board/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/reminders/status')
  })

  it('shows one daily focus, supports snoozing, and celebrates weekly wins', async () => {
    const focusCard = {
      ...sampleCard,
      id: 40,
      title: 'File the urgent form',
      nextAction: 'Fill the first section',
      estimateMinutes: 10,
      energyDemand: 'LOW' as const,
    }
    const daily = {
      message: 'One reachable next action is enough.',
      preferences: { availableMinutes: 30, energy: 'ANY' },
      counts: { inbox: 1, overdue: 1, today: 0, waiting: 1, needsClarity: 1 },
      focus: {
        card: focusCard,
        action: 'Fill the first section',
        reasons: ['Its 10-minute estimate fits the time available.'],
      },
      quickWins: [focusCard],
      needsClarity: [],
    }
    const snoozed = {
      ...focusCard,
      revision: 2,
      reminderStatus: 'PENDING' as const,
      remindAt: '2030-01-02T12:00:00.000Z',
    }
    const quietDaily = { ...daily, focus: null, quickWins: [] }
    const weekly = {
      message: '1 win this week. Progress counts.',
      counts: { wins: 1, inbox: 1, waiting: 0, projects: 0, stale: 0, unplanned: 1 },
      sections: {
        wins: [{ ...sampleCard, id: 41, title: 'Finished small thing', lane: 'DONE' as const }],
        inbox: [focusCard],
        waiting: [],
        projects: [],
        stale: [],
        unplanned: [focusCard],
      },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [focusCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => daily })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: snoozed }) })
      .mockResolvedValueOnce({ ok: true, json: async () => quietDaily })
      .mockResolvedValueOnce({ ok: true, json: async () => weekly })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('File the urgent form')
    fireEvent.click(screen.getByRole('button', { name: 'Daily focus' }))

    expect(await screen.findByText('One reachable next action is enough.')).toBeInTheDocument()
    expect(screen.getByText('Fill the first section')).toBeInTheDocument()
    expect(screen.getByText('Its 10-minute estimate fits the time available.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/review/daily?'))

    fireEvent.click(screen.getByRole('button', { name: 'Snooze 1 day' }))
    await waitFor(() => {
      expect(screen.getByText('Nothing is asking for attention right now.')).toBeInTheDocument()
    })
    const snoozeRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/cards/40/snooze' && init?.method === 'POST',
    )?.[1] as RequestInit | undefined
    const snoozeBody = JSON.parse(String(snoozeRequest?.body)) as {
      expectedRevision: number
      timezone: string
      until: string
    }
    expect(snoozeBody.expectedRevision).toBe(1)
    expect(snoozeBody.timezone).toBeTruthy()
    expect(Date.parse(snoozeBody.until)).toBeGreaterThan(Date.now())

    fireEvent.click(screen.getByRole('button', { name: 'Weekly reset' }))
    expect(await screen.findByText('1 win this week. Progress counts.')).toBeInTheDocument()
    expect(screen.getByText('Finished small thing')).toBeInTheDocument()
  })

  it('promotes a captured root task in place', async () => {
    const promoted = {
      ...sampleCard,
      itemType: 'PROJECT' as const,
      goal: 'Card A',
      revision: 2,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: promoted }) })

    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Card A')
    const card = screen.getByText('Card A').closest('.card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Make project' }))

    await waitFor(() => {
      expect(within(card).getByText('PROJECT')).toBeInTheDocument()
    })
    const request = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/cards/1/promote' && init?.method === 'POST',
    )?.[1] as RequestInit | undefined
    const body = JSON.parse(String(request?.body)) as { expectedRevision: number; eventId: string }
    expect(body.expectedRevision).toBe(1)
    expect(body.eventId).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Make project' })).toBeNull()
  })
})
