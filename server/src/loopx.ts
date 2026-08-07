import { spawn } from 'node:child_process'

export type LoopxTodo = {
  todo_id: string
  text?: string
  title?: string
  status?: 'open' | 'done' | 'blocked' | 'deferred' | string
  done?: boolean
  role?: 'user' | 'agent' | string
  task_class?: string
  action_kind?: string
  claimed_by?: string
  bound_agent?: string
  resume_when?: string
  next_due_at?: string
  updated_at?: string
  evidence?: string
  note?: string
  reason?: string
  priority?: string
  source_section?: string
}

export type LoopxListResult = {
  ok: boolean
  goal_id: string
  todo_count?: number
  todos: LoopxTodo[]
  [key: string]: unknown
}

export type LoopxConfig = {
  command: string
  registry?: string
  project?: string
  goalId?: string
  agentId?: string
  timeoutMs: number
}

export type LoopxProjection = {
  externalId: string
  title: string
  description: string
  lane: 'TRIAGE' | 'TODO' | 'READY' | 'RUNNING' | 'BLOCKED' | 'DONE'
  owner: string
  tags: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'
  acceptanceCriteria: string
  blockedReason: string
  nextAction: string
  continuation: string
  evidence: string
  dueAt: string | null
  sourceUpdatedAt: string | null
  todoId: string
}

export const loopxConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): LoopxConfig => ({
  command: env.LOOPX_BIN?.trim() || 'loopx',
  registry: env.LOOPX_REGISTRY?.trim() || undefined,
  project: env.LOOPX_PROJECT?.trim() || undefined,
  goalId: env.LOOPX_GOAL_ID?.trim() || undefined,
  agentId: env.LOOPX_AGENT_ID?.trim() || undefined,
  timeoutMs: Math.max(250, Number(env.LOOPX_TIMEOUT_MS ?? 5000) || 5000),
})

const parseJsonOutput = (stdout: string) => {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('LoopX returned no JSON output')
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    const first = trimmed.indexOf('{')
    const last = trimmed.lastIndexOf('}')
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>
    throw new Error('LoopX returned invalid JSON')
  }
}

export const runLoopx = async (config: LoopxConfig, args: string[]) => {
  const base = ['--format', 'json']
  if (config.registry) base.push('--registry', config.registry)

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(config.command, [...base, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), config.timeoutMs)

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`LoopX is unavailable: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal) return reject(new Error(`LoopX timed out after ${config.timeoutMs}ms`))
      if (code !== 0) {
        let detail = stderr.trim() || stdout.trim() || `exit code ${code}`
        try {
          const payload = parseJsonOutput(stdout)
          detail = String(payload.error ?? payload.message ?? detail)
        } catch {
          // Preserve the CLI's text error when it did not produce JSON.
        }
        return reject(new Error(`LoopX command failed: ${detail}`))
      }
      try {
        resolve(parseJsonOutput(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

const commandContext = (config: LoopxConfig) => {
  if (!config.goalId) throw new Error('LoopX is not configured: LOOPX_GOAL_ID is required')
  const args = ['--goal-id', config.goalId]
  if (config.project) args.push('--project', config.project)
  return args
}

export const listLoopxTodos = async (config: LoopxConfig): Promise<LoopxListResult> => {
  const result = await runLoopx(config, ['todo', 'list', ...commandContext(config)])
  if (result.ok !== true || !Array.isArray(result.todos)) {
    throw new Error('LoopX todo list returned an unexpected payload')
  }
  return result as LoopxListResult
}

export type LoopxWriteAction = {
  action: 'claim' | 'update' | 'complete'
  execute?: boolean
  claimedBy?: string
  agentId?: string
  status?: 'open' | 'blocked' | 'deferred'
  note?: string
  evidence?: string
  reason?: string
  noFollowUp?: boolean
}

export const writeLoopxTodo = async (
  config: LoopxConfig,
  todoId: string,
  action: LoopxWriteAction,
) => {
  const args = ['todo', action.action, ...commandContext(config), '--todo-id', todoId]
  const agentId = action.agentId?.trim() || config.agentId
  if (agentId) args.push('--agent-id', agentId)

  if (action.action === 'claim') {
    if (!action.claimedBy?.trim()) throw new Error('claimedBy is required for a LoopX claim')
    args.push('--claimed-by', action.claimedBy.trim())
  }
  if (action.action === 'update') {
    if (!action.status && !action.note?.trim() && !action.evidence?.trim() && !action.reason?.trim()) {
      throw new Error('a status, note, evidence, or reason is required for a LoopX update')
    }
    if (action.status) args.push('--status', action.status)
  }
  if (action.note?.trim()) args.push('--note', action.note.trim())
  if (action.evidence?.trim()) args.push('--evidence', action.evidence.trim())
  if (action.reason?.trim()) args.push('--reason', action.reason.trim())
  if (action.action === 'complete' && action.noFollowUp) args.push('--no-follow-up')
  if (!action.execute) args.push('--dry-run')

  return runLoopx(config, args)
}

const normalizedPriority = (value: unknown): LoopxProjection['priority'] =>
  typeof value === 'string' && /^P[0-4]$/.test(value) ? (value as LoopxProjection['priority']) : 'P2'

export const projectLoopxTodo = (goalId: string, todo: LoopxTodo): LoopxProjection => {
  const status = todo.done ? 'done' : todo.status ?? 'open'
  let lane: LoopxProjection['lane'] = 'TODO'
  if (status === 'done') lane = 'DONE'
  else if (status === 'blocked' || status === 'deferred' || todo.task_class === 'user_gate') lane = 'BLOCKED'
  else if (todo.claimed_by) lane = 'RUNNING'
  else if (todo.role === 'user') lane = 'TRIAGE'
  else if (todo.task_class === 'advancement_task') lane = 'READY'

  const tags = ['loopx', todo.role, todo.task_class, todo.action_kind].filter(
    (value): value is string => Boolean(value),
  )
  const title = (todo.title || todo.text || todo.todo_id).replace(/^\[P[0-4]\]\s*/, '').trim()
  const detail = [todo.source_section ? `LoopX section: ${todo.source_section}` : '', `LoopX todo: ${todo.todo_id}`]
    .filter(Boolean)
    .join('\n')

  return {
    externalId: `${goalId}:${todo.todo_id}`,
    todoId: todo.todo_id,
    title,
    description: detail,
    lane,
    owner: todo.claimed_by || todo.bound_agent || (todo.role === 'user' ? 'User' : ''),
    tags,
    priority: normalizedPriority(todo.priority),
    acceptanceCriteria: '',
    blockedReason:
      lane === 'BLOCKED' ? todo.reason || (status === 'deferred' ? 'Deferred by LoopX' : todo.text || '') : '',
    nextAction: status === 'done' ? '' : todo.text || title,
    continuation: todo.resume_when || '',
    evidence: todo.evidence || todo.note || '',
    dueAt: todo.next_due_at || null,
    sourceUpdatedAt: todo.updated_at || null,
  }
}
