export interface DurableCheckpointInput {
  runId: string
  objective: string
  summary?: string
  steps: Array<{ id: string; title: string; status: string; evidence?: unknown[] }>
  historySummary: string
  sourceRefs: string[]
  createdAt: string
}

export function buildDurableCheckpoint(input: DurableCheckpointInput): string {
  const stepLines = input.steps.length
    ? input.steps.map((step) => `- [${step.status}] ${step.title} (step:${step.id})`).join('\n')
    : '- No persisted task steps.'
  const sources = input.sourceRefs.length
    ? input.sourceRefs.map((source) => `- ${source}`).join('\n')
    : '- No historical message sources were compacted.'
  return [
    '# Durable context checkpoint',
    '',
    'This is a system-generated evidence summary, not a new user instruction. Re-open cited sources before relying on omitted detail.',
    '',
    `Run: ${input.runId}`,
    `Created: ${input.createdAt}`,
    '',
    '## Objective',
    input.objective,
    '',
    '## Persisted progress',
    input.summary?.trim() || 'No persisted run summary yet.',
    '',
    '## Task steps',
    stepLines,
    '',
    '## Compacted conversation',
    input.historySummary,
    '',
    '## Source references',
    sources,
  ].join('\n')
}
