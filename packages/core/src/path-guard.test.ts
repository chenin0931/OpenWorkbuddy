import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertFileUnchanged, captureFileVersion, StaleFileError } from './file-version'
import { createPathGuard, PathAuthorizationError } from './path-guard'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ base: string; workspace: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'workbuddy-path-test-'))
  cleanup.push(base)
  const workspace = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  return { base, workspace, outside }
}

describe('realpath workspace guard', () => {
  it('allows existing files and safe creates under an authorized root', async () => {
    const { workspace } = await fixture()
    const existing = path.join(workspace, 'a.txt')
    await writeFile(existing, 'a')
    const guard = await createPathGuard([workspace])
    expect((await guard.authorize(existing)).exists).toBe(true)
    const created = await guard.authorize(path.join(workspace, 'nested', 'new.txt'), 'create')
    expect(created.exists).toBe(false)
    expect(created.authorizedRoot).toBe(guard.roots[0])
  })

  it('blocks traversal and a symlink that resolves outside the workspace', async () => {
    const { workspace, outside } = await fixture()
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await symlink(outside, path.join(workspace, 'escape'))
    const guard = await createPathGuard([workspace])
    await expect(guard.authorize(path.join(workspace, '..', 'outside', 'secret.txt'))).rejects.toBeInstanceOf(PathAuthorizationError)
    await expect(guard.authorize(path.join(workspace, 'escape', 'secret.txt'))).rejects.toMatchObject({ code: 'OUTSIDE_AUTHORIZED_ROOTS' })
    await expect(guard.authorize(path.join(workspace, 'escape', 'new.txt'), 'create')).rejects.toMatchObject({ code: 'OUTSIDE_AUTHORIZED_ROOTS' })
  })

  it('detects a file modified since it was read', async () => {
    const { workspace } = await fixture()
    const filename = path.join(workspace, 'a.txt')
    await writeFile(filename, 'before')
    const guard = await createPathGuard([workspace])
    const guarded = await guard.authorize(filename, 'write')
    const version = await captureFileVersion(guard, guarded)
    await writeFile(filename, 'after, with a new size')
    await expect(assertFileUnchanged(guard, guarded, version)).rejects.toBeInstanceOf(StaleFileError)
  })
})
