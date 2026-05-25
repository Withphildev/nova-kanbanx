import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type MockCard = {
  id: number
  title: string
  description: string
  lane: 'Backlog' | 'In Progress' | 'Blocked' | 'Done'
  owner: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

const sampleCard: MockCard = {
  id: 1,
  title: 'Card A',
  description: '',
  lane: 'Backlog',
  owner: '',
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

afterEach(() => {
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

    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards/1', expect.any(Object))
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/cards')
    })

    expect(await screen.findByText('Card A')).toBeInTheDocument()
  })
})
