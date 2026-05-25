import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Lane = 'Backlog' | 'In Progress' | 'Blocked' | 'Done'

type Card = {
  id: number
  title: string
  description: string
  lane: Lane
  owner: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

const laneOrder: Lane[] = ['Backlog', 'In Progress', 'Blocked', 'Done']

function App() {
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [tags, setTags] = useState('')

  const grouped = useMemo(() => {
    return laneOrder.map((lane) => ({ lane, cards: cards.filter((c) => c.lane === lane) }))
  }, [cards])

  const loadCards = async () => {
    setLoading(true)
    const res = await fetch('/api/cards')
    const data = (await res.json()) as { cards: Card[] }
    setCards(data.cards)
    setLoading(false)
  }

  useEffect(() => {
    loadCards().catch(() => setLoading(false))
  }, [])

  const createCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) return

    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        owner: owner.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    })

    setTitle('')
    setOwner('')
    setTags('')
    await loadCards()
  }

  const moveCard = async (card: Card, lane: Lane) => {
    if (lane === card.lane) return
    await fetch(`/api/cards/${card.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane }),
    })
    await loadCards()
  }

  const deleteCard = async (id: number) => {
    await fetch(`/api/cards/${id}`, { method: 'DELETE' })
    await loadCards()
  }

  return (
    <main className="app-shell">
      <header>
        <h1>OpenClaw Kanban</h1>
        <p>MIT clean-room board for agent and project flow.</p>
      </header>

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
          placeholder="Owner (optional)"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tags,comma,separated"
        />
        <button type="submit">Add card</button>
      </form>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <section className="board">
          {grouped.map((column) => (
            <article key={column.lane} className="lane">
              <h2>{column.lane}</h2>
              <div className="stack">
                {column.cards.map((card) => (
                  <div key={card.id} className="card">
                    <h3>{card.title}</h3>
                    {card.owner && <p className="owner">Owner: {card.owner}</p>}
                    {card.description && <p>{card.description}</p>}
                    <p className="tags">{card.tags.join(' · ')}</p>
                    <div className="actions">
                      {laneOrder.map((lane) => (
                        <button
                          key={lane}
                          type="button"
                          onClick={() => moveCard(card, lane)}
                          disabled={lane === card.lane}
                        >
                          {lane}
                        </button>
                      ))}
                      <button type="button" className="danger" onClick={() => deleteCard(card.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}

export default App
