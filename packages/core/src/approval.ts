import type {
  ApprovalGrant,
  ApprovalRequest,
  ApprovalResponse,
  JsonValue,
  RiskLevel,
} from '@onmyworkbuddy/contracts'

import { fingerprintArguments } from './policy'

export interface ApprovalResolution {
  request: ApprovalRequest
  executionArguments?: JsonValue
  grant?: ApprovalGrant
}

export function isApprovalExpired(request: ApprovalRequest, now = new Date()): boolean {
  return request.expiresAt !== undefined && Date.parse(request.expiresAt) <= now.getTime()
}

export function resolveApproval(
  request: ApprovalRequest,
  response: ApprovalResponse,
  options: { grantId: string; now?: Date },
): ApprovalResolution {
  if (request.id !== response.requestId) throw new Error('Approval response does not match the pending request.')
  if (request.status !== 'pending') throw new Error(`Approval request is already ${request.status}.`)
  const now = options.now ?? new Date()
  if (isApprovalExpired(request, now)) return { request: { ...request, status: 'expired' } }
  if (response.decision === 'reject') return { request: { ...request, status: 'rejected' } }

  const executionArguments = response.decision === 'edit' ? response.editedArguments : request.arguments
  if (executionArguments === undefined) throw new Error('Edited approval must include replacement arguments.')
  const requestedScope = response.decision === 'edit' ? 'once' : response.scope
  if (requestedScope === undefined) throw new Error('Approved request must include an approval scope.')

  // High-risk actions are always exact, one-shot grants regardless of UI bugs.
  const scope = forceOneShot(request.riskLevel) ? 'once' : requestedScope
  const grant: ApprovalGrant = {
    id: options.grantId,
    runId: request.runId,
    toolName: request.toolName,
    scope,
    argumentFingerprint: fingerprintArguments(executionArguments),
    approvedArguments: executionArguments,
    createdAt: now.toISOString(),
  }
  return {
    request: { ...request, status: response.decision === 'edit' ? 'edited' : 'approved' },
    executionArguments,
    grant,
  }
}

function forceOneShot(riskLevel: RiskLevel): boolean {
  // External calls can time out after committing remotely. Exact one-shot
  // approval prevents an Agent from replaying the same send/click/MCP call
  // under a task-scoped grant when the real outcome is uncertain.
  return riskLevel === 'external_side_effect' || riskLevel === 'high_risk_irreversible'
}

export function revokeGrant(grant: ApprovalGrant, now = new Date()): ApprovalGrant {
  return { ...grant, revokedAt: now.toISOString() }
}
