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

type EditDraft = {
  title: string
  description: string
  owner: string
  tags: string
  lane: Lane
}

const laneOrder: Lane[] = ['Backlog', 'In Progress', 'Blocked', 'Done']

function App() {
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [tags, setTags] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)

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
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const saveEdit = async (card: Card) => {
    if (!draft) return

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
        }),
      })

      if (!res.ok) throw new Error('Failed to save card')

      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
    } catch {
      applyCardUpdate(prevCard)
      await loadCards()
    }
  }

  const moveCard = async (card: Card, lane: Lane) => {
    if (lane === card.lane) return

    const prevCard = card
    const optimistic = { ...card, lane, updatedAt: new Date().toISOString() }
    applyCardUpdate(optimistic)

    try {
      const res = await fetch(`/api/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lane }),
      })
      if (!res.ok) throw new Error('Failed to move card')
      const data = (await res.json()) as { card: Card }
      applyCardUpdate(data.card)
    } catch {
      applyCardUpdate(prevCard)
      await loadCards()
    }
  }

  const deleteCard = async (id: number) => {
    const prevCards = cards
    setCards((current) => current.filter((card) => card.id !== id))

    try {
      const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete card')
    } catch {
      setCards(prevCards)
      await loadCards()
    }
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
                          <select
                            value={draft.lane}
                            onChange={(e) => setDraft({ ...draft, lane: e.target.value as Lane })}
                          >
                            {laneOrder.map((lane) => (
                              <option key={lane} value={lane}>
                                {lane}
                              </option>
                            ))}
                          </select>
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
                          {card.owner && <p className="owner">Owner: {card.owner}</p>}
                          {card.description && <p>{card.description}</p>}
                          <p className="tags">{card.tags.join(' · ')}</p>
                          <div className="actions">
                            <button type="button" onClick={() => startEdit(card)}>
                              Edit
                            </button>
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
