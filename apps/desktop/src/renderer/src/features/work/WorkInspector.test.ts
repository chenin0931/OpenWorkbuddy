import { describe, expect, it } from 'vitest'

import { isUserVisibleArtifact } from './WorkInspector'

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
