const baseUrl = (process.env.KANBAN_API_URL || 'http://localhost:3001').replace(/\/$/, '')

const expectStatus = async (res, expected, step) => {
  if (res.status !== expected) {
    const body = await res.text()
    throw new Error(`${step} failed: expected ${expected}, got ${res.status}. body=${body}`)
  }
}

const requestJson = async (path, init, expected, step) => {
  const res = await fetch(`${baseUrl}${path}`, init)
  await expectStatus(res, expected, step)
  if (expected === 204) return null
  return res.json()
}

const title = `Agent smoke ${new Date().toISOString()}`

const run = async () => {
  const created = await requestJson(
    '/api/cards',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: 'agent e2e', tags: ['agent', 'smoke'] }),
    },
    201,
    'create',
  )

  const cardId = created?.card?.id
  if (!Number.isInteger(cardId)) {
    throw new Error('create failed: missing card id')
  }

  await requestJson(
    `/api/cards/${cardId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: 'In Progress' }),
    },
    200,
    'move to In Progress',
  )

  await requestJson(
    `/api/cards/${cardId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: 'Done' }),
    },
    200,
    'move to Done',
  )

  await requestJson(`/api/cards/${cardId}`, { method: 'DELETE' }, 204, 'delete')

  const allCards = await requestJson('/api/cards', { method: 'GET' }, 200, 'list cards')
  const stillExists = (allCards?.cards || []).some((card) => card.id === cardId)
  if (stillExists) {
    throw new Error(`delete verification failed: card ${cardId} still present`)
  }

  console.log(`agent smoke passed against ${baseUrl} (card ${cardId})`)
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
