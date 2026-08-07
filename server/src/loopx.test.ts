import { describe, expect, it } from 'vitest'
import { projectLoopxTodo } from './loopx.js'

describe('LoopX task projection', () => {
  it('uses the stable goal_id:todo_id identity and maps runnable work', () => {
    const card = projectLoopxTodo('goal-7', {
      todo_id: 'todo_abc123',
      text: '[P1] Ship the adapter',
      title: 'Ship the adapter',
      status: 'open',
      role: 'agent',
      task_class: 'advancement_task',
      action_kind: 'implementation',
      priority: 'P1',
    })

    expect(card).toMatchObject({
      externalId: 'goal-7:todo_abc123',
      lane: 'READY',
      title: 'Ship the adapter',
      priority: 'P1',
      tags: ['loopx', 'agent', 'advancement_task', 'implementation'],
    })
  })

  it('projects claims, gates, deferrals, and completion deterministically', () => {
    expect(projectLoopxTodo('g', { todo_id: '1', status: 'open', claimed_by: 'agent-a' }).lane).toBe('RUNNING')
    expect(projectLoopxTodo('g', { todo_id: '2', status: 'open', task_class: 'user_gate' }).lane).toBe('BLOCKED')
    expect(projectLoopxTodo('g', { todo_id: '3', status: 'deferred' }).lane).toBe('BLOCKED')
    expect(projectLoopxTodo('g', { todo_id: '4', status: 'done' }).lane).toBe('DONE')
  })
})
