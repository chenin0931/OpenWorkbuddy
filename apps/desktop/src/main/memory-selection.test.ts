import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@onmyworkbuddy/contracts'
import { selectMemoriesForRun } from './memory-selection'

const timestamp = '2026-07-11T00:00:00.000Z'

function memory(id: string, scope: MemoryEntry['scope'], options: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    type: 'stable_fact',
    scope,
    state: 'confirmed',
    content: id,
    confidence: 1,
    sources: [{ kind: 'user', reference: 'settings' }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...options,
  }
}

describe('scope-aware memory selection', () => {
  it('injects global user, matching workspace and the current run thread only', () => {
    const selected = selectMemoriesForRun([
      memory('user', 'user'),
      memory('workspace-match', 'workspace', { workspaceId: 'workspace-1' }),
      memory('workspace-other', 'workspace', { workspaceId: 'workspace-2' }),
      memory('thread-match', 'thread', { sources: [{ kind: 'run', reference: 'run-1' }] }),
      memory('thread-other', 'thread', { sources: [{ kind: 'run', reference: 'run-2' }] }),
      memory('thread-message-match', 'thread', { sources: [{ kind: 'message', reference: 'message-1' }] }),
      memory('thread-unbound', 'thread'),
      memory('organization-unbound', 'organization'),
      memory('unconfirmed', 'user', { state: 'proposed' }),
    ], { runId: 'run-1', workspaceId: 'workspace-1', messageBelongsToRun: (messageId, runId) => messageId === 'message-1' && runId === 'run-1' })

    expect(selected.map((entry) => entry.id)).toEqual(['user', 'workspace-match', 'thread-match', 'thread-message-match'])
  })
})
