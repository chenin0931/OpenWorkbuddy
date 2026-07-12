import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import type { GuardedPath, PathGuard } from './path-guard'
import { revalidateGuardedPath } from './path-guard'

export interface FileVersion {
  canonicalPath: string
  size: number
  mtimeMs: number
  sha256: string
}

export class StaleFileError extends Error {
  readonly code = 'STALE_FILE'

  constructor(message: string) {
    super(message)
    this.name = 'StaleFileError'
  }
}

export async function captureFileVersion(guard: PathGuard, target: GuardedPath): Promise<FileVersion> {
  const current = await revalidateGuardedPath(guard, target)
  if (!current.exists) throw new StaleFileError(`Cannot capture a version for a missing file: ${current.canonicalPath}`)
  const [metadata, bytes] = await Promise.all([stat(current.canonicalPath), readFile(current.canonicalPath)])
  return {
    canonicalPath: current.canonicalPath,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/** Must run immediately before writing; callers should still use atomic replace. */
export async function assertFileUnchanged(
  guard: PathGuard,
  target: GuardedPath,
  expected: FileVersion | null,
): Promise<void> {
  const currentTarget = await revalidateGuardedPath(guard, target)
  if (expected === null) {
    if (currentTarget.exists) throw new StaleFileError('A file appeared after the create operation was planned; refusing to overwrite it.')
    return
  }
  if (!currentTarget.exists) throw new StaleFileError('The file was removed after it was read.')
  const current = await captureFileVersion(guard, currentTarget)
  if (
    current.canonicalPath !== expected.canonicalPath ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.sha256 !== expected.sha256
  ) {
    throw new StaleFileError('The file changed after it was read; re-read it before writing.')
  }
}
