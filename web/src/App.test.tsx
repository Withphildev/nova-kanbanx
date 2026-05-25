import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type MockCard = {
  id: number
  title: string
  description: string
  lane: 'Triage' | 'Backlog' | 'In Progress' | 'Blocked' | 'Done'
  owner: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

const sampleCard: MockCard = {
  id: 1,
  title: 'Card A',
  description: '',
  lane: 'Triage',
  owner: '',
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App optimistic behavior', () => {
  it('rolls back lane change when API move fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'In Progress' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', expect.any(Object))
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards')
    })

    expect(await screen.findByText('Card A')).toBeInTheDocument()
  })

  it('deletes a card and reloads from API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', { method: 'DELETE' })
    })

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
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('refresh failed'))

    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Card A')

    const card = screen.getByText('Card A').closest('.card')
    expect(card).not.toBeNull()

    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', { method: 'DELETE' })
    })

    await waitFor(() => {
      expect(screen.queryByText('Card A')).not.toBeInTheDocument()
    })
  })
})
