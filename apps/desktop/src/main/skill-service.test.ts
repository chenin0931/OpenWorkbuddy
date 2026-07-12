import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppDatabase } from './database'
import { SkillService } from './skill-service'

describe('SkillService', () => {
  let temporaryRoot: string
  let database: AppDatabase
  let service: SkillService

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'workbuddy-skill-'))
    database = new AppDatabase(join(temporaryRoot, 'app.sqlite3'))
    service = new SkillService(database, join(temporaryRoot, 'installed-skills'))
  })

  afterEach(async () => {
    database.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('imports a skill, parses metadata and safely enumerates references and scripts', async () => {
    const source = join(temporaryRoot, 'source')
    await mkdir(join(source, 'references'), { recursive: true })
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), `---
name: research-helper
description: Research with primary sources
version: 2.1.0
permissions:
  - capability: filesystem_read
    detail: Read workspace documents
  - network
---
Follow the documented research workflow.
`)
    await writeFile(join(source, 'references', 'guide.md'), '# Guide')
    await writeFile(join(source, 'scripts', 'collect.sh'), '#!/bin/sh\necho ok\n')

    const imported = await service.import({ directory: source })
    expect(imported).toMatchObject({
      name: 'research-helper',
      description: 'Research with primary sources',
      version: '2.1.0',
      enabled: true,
      entrypoint: 'SKILL.md',
    })
    expect(imported.directory).toBe(await realpath(join(temporaryRoot, 'installed-skills', 'research-helper')))
    expect(imported.permissions).toEqual([
      { capability: 'filesystem_read', detail: 'Read workspace documents' },
      { capability: 'network' },
    ])

    const detail = await service.get(imported.id)
    expect(detail.instructions).toBe('Follow the documented research workflow.')
    expect(detail.referenceFiles).toEqual([join('references', 'guide.md')])
    expect(detail.scriptFiles).toEqual([join('scripts', 'collect.sh')])

    expect((await service.setEnabled({ id: imported.id, enabled: false })).enabled).toBe(false)
    await service.remove(imported.id)
    await expect(access(imported.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers manually installed skills and refuses packages containing symlinks', async () => {
    const installed = join(temporaryRoot, 'installed-skills', 'manual-skill')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'SKILL.md'), `---
name: manual-skill
description: Loaded during a scan
---
Do the manual workflow.
`)
    expect(await service.scan()).toEqual([
      expect.objectContaining({ name: 'manual-skill', directory: await realpath(installed) }),
    ])

    const unsafe = join(temporaryRoot, 'unsafe-source')
    const outside = join(temporaryRoot, 'outside.txt')
    await mkdir(unsafe)
    await writeFile(join(unsafe, 'SKILL.md'), `---
name: unsafe-skill
description: Must not escape its package
---
Never loaded.
`)
    await writeFile(outside, 'secret')
    await symlink(outside, join(unsafe, 'leak.txt'))
    await expect(service.import(unsafe)).rejects.toThrow('符号链接')
  })
})
