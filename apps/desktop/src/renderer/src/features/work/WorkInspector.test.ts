import { describe, expect, it } from 'vitest'

import { isUserVisibleArtifact, latestTraceSpans, traceDiagnosticHeadline } from './WorkInspector'

describe('WorkInspector artifact shelf', () => {
  it('shows user-facing outputs and screenshots', () => {
    expect(isUserVisibleArtifact({ kind: 'final_output', mime: 'text/markdown' })).toBe(true)
    expect(isUserVisibleArtifact({ kind: 'tool_result', mime: 'image/png' })).toBe(true)
  })

  it('keeps internal execution material out of the artifact shelf', () => {
    expect(isUserVisibleArtifact({ kind: 'attachment', mime: 'application/pdf' })).toBe(false)
    expect(isUserVisibleArtifact({ kind: 'file_snapshot', mime: 'text/plain' })).toBe(false)
    expect(isUserVisibleArtifact({ kind: 'checkpoint', mime: 'text/markdown' })).toBe(false)
    expect(isUserVisibleArtifact({ kind: 'tool_result', mime: 'application/json' })).toBe(false)
    expect(isUserVisibleArtifact({ kind: 'diff', mime: 'text/x-diff' })).toBe(false)
  })
})

describe('WorkInspector trace diagnostics', () => {
  it('shows only the latest turn in the secondary diagnostic disclosure', () => {
    const spans = latestTraceSpans({
      traces: [
        { id: 'old', rootSpanId: 'old-root', status: 'succeeded', startedAt: '2026-07-14T01:00:00.000Z', metadata: {} },
        { id: 'latest', rootSpanId: 'latest-root', status: 'running', startedAt: '2026-07-14T02:00:00.000Z', metadata: {} },
      ],
      traceSpans: [
        { id: 'old-span', traceId: 'old', kind: 'model_turn', name: '模型回合 1', status: 'succeeded', startedAt: '2026-07-14T01:00:01.000Z', attributes: {}, artifactIds: [] },
        { id: 'latest-span', traceId: 'latest', kind: 'managed_process', name: 'build report', status: 'running', startedAt: '2026-07-14T02:00:01.000Z', attributes: {}, artifactIds: [] },
      ],
    })
    expect(spans.map((span) => span.id)).toEqual(['latest-span'])
    expect(traceDiagnosticHeadline(spans)).toBe('后台进程 · build report')
  })

  it('pinpoints the latest failed stage when a turn is no longer active', () => {
    expect(traceDiagnosticHeadline([
      { id: 'context', traceId: 'trace', kind: 'context_stage', name: 'workspace_rules', status: 'succeeded', startedAt: '2026-07-14T02:00:00.000Z', attributes: {}, artifactIds: [] },
      { id: 'tool', traceId: 'trace', kind: 'tool_call', name: 'web_fetch', status: 'failed', startedAt: '2026-07-14T02:00:01.000Z', attributes: {}, artifactIds: [] },
    ])).toBe('执行工具失败 · web_fetch')
  })
})
