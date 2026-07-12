import type {
  TaskStep,
  ToolCall,
  VerificationSummary,
} from '@onmyworkbuddy/contracts'

export interface CompletionGateInput {
  steps: readonly TaskStep[]
  toolCalls?: readonly ToolCall[]
  checks: VerificationSummary['checks']
  /** Model/user labels are diagnostic only; a host-generated passed check is required. */
  evidence?: readonly string[]
  unverified?: readonly string[]
}

/**
 * A run is verified only from observable evidence. Missing, skipped or failed
 * work produces an honest partial result instead of a green completion state.
 */
export function evaluateCompletionGate(input: CompletionGateInput): VerificationSummary {
  const incompleteSteps = input.steps.filter((step) => step.status !== 'completed')
  const completedStepsWithoutEvidence = input.steps.filter(
    (step) => step.status === 'completed' && !step.verification?.trim(),
  )
  const unsettledTools = (input.toolCalls ?? []).filter(
    (call) => call.status !== 'succeeded' && call.status !== 'cancelled',
  )
  const failedChecks = input.checks.filter((check) => check.status === 'failed')
  const missingChecks = input.checks.filter((check) => check.status === 'not_run')
  const unverified = input.unverified ?? []
  const hasEvidence = input.checks.some((check) => check.status === 'passed')
  const verified =
    incompleteSteps.length === 0 &&
    completedStepsWithoutEvidence.length === 0 &&
    unsettledTools.length === 0 &&
    failedChecks.length === 0 &&
    missingChecks.length === 0 &&
    unverified.length === 0 &&
    hasEvidence

  const limitations = [
    incompleteSteps.length > 0 ? `${incompleteSteps.length} incomplete step(s)` : '',
    completedStepsWithoutEvidence.length > 0 ? `${completedStepsWithoutEvidence.length} completed step(s) missing verification evidence` : '',
    unsettledTools.length > 0 ? `${unsettledTools.length} unsettled tool call(s)` : '',
    failedChecks.length > 0 ? `${failedChecks.length} failed check(s)` : '',
    missingChecks.length > 0 ? `${missingChecks.length} check(s) not run` : '',
    ...unverified,
    !hasEvidence ? 'no observable verification evidence' : '',
  ].filter(Boolean)

  return {
    status: verified ? 'verified' : 'partial',
    checks: input.checks.map((check) => ({ ...check })),
    summary: verified ? 'All declared work completed with observable verification evidence.' : `Partial completion: ${limitations.join('; ')}.`,
  }
}
