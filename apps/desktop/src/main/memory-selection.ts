import type { MemoryEntry } from '@onmyworkbuddy/contracts'

/**
 * Memory scope is an authority boundary, not merely a ranking hint.
 * Organization memories remain dormant until the product has an explicit
 * organization identity/association model.
 */
export function selectMemoriesForRun(
  memories: readonly MemoryEntry[],
  input: { runId: string; workspaceId: string; messageBelongsToRun?: (messageId: string, runId: string) => boolean },
): MemoryEntry[] {
  return memories.filter((memory) => {
    if (memory.state !== 'confirmed') return false
    if (memory.scope === 'user') return true
    if (memory.scope === 'workspace') return Boolean(memory.workspaceId && memory.workspaceId === input.workspaceId)
    if (memory.scope === 'thread') {
      return memory.sources.some((source) =>
        (source.kind === 'run' && source.reference === input.runId) ||
        (source.kind === 'message' && Boolean(input.messageBelongsToRun?.(source.reference, input.runId))),
      )
    }
    // No organization association exists in the local single-user product.
    return false
  })
}
