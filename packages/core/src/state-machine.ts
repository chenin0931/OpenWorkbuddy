import type { CompletionStatus, PublicError, Run, RunStatus, TaskStepStatus } from '@onmyworkbuddy/contracts'

const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  // Small/direct tasks may start execution without manufacturing a planning
  // phase. Planning remains available for tasks that need it.
  understanding: new Set(['planning', 'running', 'waiting_user', 'paused', 'failed', 'cancelled']),
  planning: new Set(['running', 'waiting_user', 'waiting_approval', 'paused', 'failed', 'cancelled']),
  running: new Set(['verifying', 'waiting_approval', 'waiting_user', 'paused', 'failed', 'cancelled']),
  verifying: new Set(['running', 'completed', 'waiting_approval', 'waiting_user', 'paused', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'verifying', 'waiting_user', 'paused', 'failed', 'cancelled']),
  waiting_user: new Set(['understanding', 'planning', 'running', 'verifying', 'paused', 'failed', 'cancelled']),
  paused: new Set(['understanding', 'planning', 'running', 'verifying', 'waiting_approval', 'waiting_user', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

const STEP_TRANSITIONS: Readonly<Record<TaskStepStatus, ReadonlySet<TaskStepStatus>>> = {
  pending: new Set(['in_progress', 'blocked', 'skipped', 'failed']),
  in_progress: new Set(['blocked', 'completed', 'failed', 'skipped']),
  blocked: new Set(['pending', 'in_progress', 'failed', 'skipped']),
  completed: new Set(),
  failed: new Set(['pending', 'in_progress']),
  skipped: new Set(['pending']),
}

export class InvalidStateTransitionError extends Error {
  readonly from: string
  readonly to: string

  constructor(kind: 'run' | 'step', from: string, to: string) {
    super(`Invalid ${kind} state transition: ${from} -> ${to}`)
    this.name = 'InvalidStateTransitionError'
    this.from = from
    this.to = to
  }
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].has(to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new InvalidStateTransitionError('run', from, to)
}

export function canTransitionStep(from: TaskStepStatus, to: TaskStepStatus): boolean {
  return from === to || STEP_TRANSITIONS[from].has(to)
}

export function assertStepTransition(from: TaskStepStatus, to: TaskStepStatus): void {
  if (!canTransitionStep(from, to)) throw new InvalidStateTransitionError('step', from, to)
}

export interface RunTransitionOptions {
  now?: Date
  completionStatus?: CompletionStatus
  error?: PublicError
}

export function transitionRun(run: Run, status: RunStatus, options: RunTransitionOptions = {}): Run {
  assertRunTransition(run.status, status)
  if (status !== 'completed' && options.completionStatus !== undefined) {
    throw new Error('completionStatus can only be assigned when transitioning to completed.')
  }
  if (status === 'failed' && options.error === undefined && run.lastError === undefined) {
    throw new Error('A failed run must include a public error.')
  }

  const now = (options.now ?? new Date()).toISOString()
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  const next: Run = {
    ...run,
    status,
    updatedAt: now,
    ...(status === 'running' && run.startedAt === undefined ? { startedAt: now } : {}),
    ...(terminal ? { completedAt: now } : {}),
    ...(options.completionStatus ? { completionStatus: options.completionStatus } : {}),
    ...(options.error ? { lastError: options.error } : {}),
  }

  // A terminal field must never leak back to an active run in recovery code.
  if (!terminal && next.completedAt !== undefined) delete next.completedAt
  if (status !== 'completed' && next.completionStatus !== undefined) delete next.completionStatus
  return next
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
