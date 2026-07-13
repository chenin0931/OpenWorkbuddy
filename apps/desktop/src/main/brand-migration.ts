import { lstat, rename, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const LEGACY_DIRECTORY_SEGMENTS = ['On', 'My', 'WorkBuddy'] as const

export interface BrandMigrationResult {
  migrated: boolean
  compatibilityLinkCreated: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Moves preview data to the current branded directory before the database is
 * opened. The compatibility symlink keeps an already-installed Native
 * Messaging host working until the user reinstalls the current host build.
 */
export async function migrateLegacyBrandDirectory(
  appDataDirectory: string,
  currentUserDataDirectory: string,
): Promise<BrandMigrationResult> {
  const legacyDirectory = join(appDataDirectory, LEGACY_DIRECTORY_SEGMENTS.join(' '))
  if (resolve(legacyDirectory) === resolve(currentUserDataDirectory)) {
    return { migrated: false, compatibilityLinkCreated: false }
  }
  if (!(await exists(legacyDirectory)) || await exists(currentUserDataDirectory)) {
    return { migrated: false, compatibilityLinkCreated: false }
  }

  await rename(legacyDirectory, currentUserDataDirectory)
  try {
    await symlink(currentUserDataDirectory, legacyDirectory, 'dir')
    return { migrated: true, compatibilityLinkCreated: true }
  } catch {
    // The data move is complete even when the optional compatibility link is
    // unavailable. Reinstalling the Native Host will use the current path.
    return { migrated: true, compatibilityLinkCreated: false }
  }
}
