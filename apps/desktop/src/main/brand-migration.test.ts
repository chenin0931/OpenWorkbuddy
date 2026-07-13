import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyBrandDirectory } from './brand-migration'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('brand data migration', () => {
  it('moves preview data and leaves a compatibility link for an installed native host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openworkbuddy-brand-'))
    temporaryDirectories.push(root)
    const legacy = join(root, ['On', 'My', 'WorkBuddy'].join(' '))
    const current = join(root, 'OpenWorkbuddy')
    await mkdir(legacy)
    await writeFile(join(legacy, 'workbuddy.sqlite3'), 'preview-state')

    await expect(migrateLegacyBrandDirectory(root, current)).resolves.toEqual({
      migrated: true,
      compatibilityLinkCreated: true,
    })
    await expect(readFile(join(current, 'workbuddy.sqlite3'), 'utf8')).resolves.toBe('preview-state')
    await expect(realpath(legacy)).resolves.toBe(await realpath(current))
  })

  it('does not merge two existing data directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openworkbuddy-brand-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, ['On', 'My', 'WorkBuddy'].join(' ')))
    const current = join(root, 'OpenWorkbuddy')
    await mkdir(current)

    await expect(migrateLegacyBrandDirectory(root, current)).resolves.toEqual({
      migrated: false,
      compatibilityLinkCreated: false,
    })
  })
})
