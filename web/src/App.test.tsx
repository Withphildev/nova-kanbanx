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
      expect(fetchMock).toHaveBeenCalledWith('/api/cards', expect.objectContaining({ method: 'POST' }))
    })

    const createRequest = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/cards' && init?.method === 'POST',
    )?.[1] as RequestInit | undefined
    const createBody = JSON.parse(String(createRequest?.body)) as { title: string; eventId: string }
    expect(createBody.title).toBe('New durable card')
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
      expect(fetchMock).toHaveBeenCalledWith('/api/cards')
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
      expect(fetchMock).toHaveBeenCalledWith('/api/cards')
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
})
