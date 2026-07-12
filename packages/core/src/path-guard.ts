import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export type PathIntent = 'read' | 'write' | 'create'

export interface PathFileSystem {
  realpath(pathname: string): Promise<string>
  exists(pathname: string): Promise<boolean>
}

const nodeFileSystem: PathFileSystem = {
  realpath,
  async exists(pathname) {
    try {
      await lstat(pathname)
      return true
    } catch (error) {
      if (isMissingError(error)) return false
      throw error
    }
  },
}

export interface GuardedPath {
  requestedPath: string
  absolutePath: string
  canonicalPath: string
  authorizedRoot: string
  exists: boolean
  intent: PathIntent
}

export class PathAuthorizationError extends Error {
  readonly code: 'INVALID_PATH' | 'OUTSIDE_AUTHORIZED_ROOTS' | 'PATH_NOT_FOUND' | 'NO_AUTHORIZED_ROOTS'

  constructor(code: PathAuthorizationError['code'], message: string) {
    super(message)
    this.name = 'PathAuthorizationError'
    this.code = code
  }
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonicalizeTarget(
  absolutePath: string,
  intent: PathIntent,
  fileSystem: PathFileSystem,
): Promise<{ canonicalPath: string; exists: boolean }> {
  if (await fileSystem.exists(absolutePath)) {
    return { canonicalPath: await fileSystem.realpath(absolutePath), exists: true }
  }
  if (intent === 'read') {
    throw new PathAuthorizationError('PATH_NOT_FOUND', `Path does not exist: ${absolutePath}`)
  }

  const missingSegments: string[] = []
  let cursor = absolutePath
  while (!(await fileSystem.exists(cursor))) {
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new PathAuthorizationError('PATH_NOT_FOUND', `No existing ancestor for path: ${absolutePath}`)
    }
    missingSegments.unshift(path.basename(cursor))
    cursor = parent
  }

  const canonicalAncestor = await fileSystem.realpath(cursor)
  return { canonicalPath: path.join(canonicalAncestor, ...missingSegments), exists: false }
}

export interface PathGuard {
  readonly roots: readonly string[]
  authorize(candidatePath: string, intent?: PathIntent): Promise<GuardedPath>
}

/**
 * Resolves authorized roots once, then resolves every candidate (or its nearest
 * existing ancestor for creates) to prevent `..` and symlink escapes.
 */
export async function createPathGuard(
  authorizedRoots: readonly string[],
  options: { cwd?: string; fileSystem?: PathFileSystem } = {},
): Promise<PathGuard> {
  if (authorizedRoots.length === 0) {
    throw new PathAuthorizationError('NO_AUTHORIZED_ROOTS', 'At least one authorized workspace root is required.')
  }
  const cwd = options.cwd ?? process.cwd()
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const canonicalRoots = Array.from(
    new Set(await Promise.all(authorizedRoots.map((root) => fileSystem.realpath(path.resolve(cwd, root))))),
  )

  return {
    roots: canonicalRoots,
    async authorize(candidatePath, intent = 'read') {
      if (!candidatePath || candidatePath.includes('\0')) {
        throw new PathAuthorizationError('INVALID_PATH', 'Path must be non-empty and cannot contain null bytes.')
      }
      const absolutePath = path.resolve(cwd, candidatePath)
      const target = await canonicalizeTarget(absolutePath, intent, fileSystem)
      const authorizedRoot = canonicalRoots.find((root) => isInside(root, target.canonicalPath))
      if (!authorizedRoot) {
        throw new PathAuthorizationError(
          'OUTSIDE_AUTHORIZED_ROOTS',
          `Resolved path is outside authorized workspace roots: ${target.canonicalPath}`,
        )
      }
      return {
        requestedPath: candidatePath,
        absolutePath,
        canonicalPath: target.canonicalPath,
        authorizedRoot,
        exists: target.exists,
        intent,
      }
    },
  }
}

/** Re-resolve immediately before mutation to detect a swapped symlink/target. */
export async function revalidateGuardedPath(
  guard: PathGuard,
  guarded: GuardedPath,
): Promise<GuardedPath> {
  const current = await guard.authorize(guarded.absolutePath, guarded.intent)
  if (current.canonicalPath !== guarded.canonicalPath || current.authorizedRoot !== guarded.authorizedRoot) {
    throw new PathAuthorizationError('OUTSIDE_AUTHORIZED_ROOTS', 'Path resolution changed since authorization; re-read before writing.')
  }
  return current
}
