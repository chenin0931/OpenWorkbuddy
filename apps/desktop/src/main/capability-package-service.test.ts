import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CapabilityPackageService } from './capability-package-service'

describe('CapabilityPackageService', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-capability-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const writeManifest = async (manifest: Record<string, unknown>): Promise<void> => {
    await writeFile(join(root, 'workbuddy-package.json'), JSON.stringify(manifest))
  }

  it('validates a complete package without executing or installing its contents', async () => {
    await mkdir(join(root, 'skills', 'research'), { recursive: true })
    await mkdir(join(root, 'mcp'), { recursive: true })
    await mkdir(join(root, 'rules'), { recursive: true })
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(join(root, 'skills', 'research', 'SKILL.md'), '# Research\nUse primary sources.')
    await writeFile(join(root, 'skills', 'research', 'reference.md'), '# Reference')
    await writeFile(join(root, 'mcp', 'docs.json'), JSON.stringify({ transport: 'stdio', command: '/usr/bin/true' }))
    await writeFile(join(root, 'rules', 'workspace.md'), '# Rules')
    await writeFile(join(root, 'templates', 'report.bin'), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(root, 'README.md'), 'Unreferenced documentation remains an inert asset.')
    await writeManifest({
      name: 'Team workflow',
      version: '1.2.3',
      skills: ['skills/research'],
      mcp: ['mcp/docs.json'],
      rules: ['rules/workspace.md'],
      templates: ['templates/report.bin'],
    })

    const result = await new CapabilityPackageService().inspect({ directory: root })

    expect(result.manifest).toEqual({
      name: 'Team workflow',
      version: '1.2.3',
      skills: ['skills/research'],
      mcp: ['mcp/docs.json'],
      rules: ['rules/workspace.md'],
      templates: ['templates/report.bin'],
    })
    expect(result.skills).toEqual([
      expect.objectContaining({ relativePath: 'skills/research' }),
    ])
    expect(result.mcpConfigs).toEqual([
      { relativePath: 'mcp/docs.json', config: { transport: 'stdio', command: '/usr/bin/true' } },
    ])
    expect(result.rules).toEqual([{ relativePath: 'rules/workspace.md', content: '# Rules' }])
    expect(result.templates).toEqual([
      expect.objectContaining({ relativePath: 'templates/report.bin', size: 4 }),
    ])
    expect(result.files.map(({ relativePath, kind }) => [relativePath, kind])).toEqual([
      ['mcp/docs.json', 'mcp'],
      ['README.md', 'asset'],
      ['rules/workspace.md', 'rule'],
      ['skills/research/reference.md', 'skill'],
      ['skills/research/SKILL.md', 'skill'],
      ['templates/report.bin', 'template'],
      ['workbuddy-package.json', 'manifest'],
    ])
    expect(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
  })

  it('rejects manifest traversal, absolute paths, duplicate declarations and unknown executable hooks', async () => {
    await writeManifest({ name: 'escape', version: '1', rules: ['../outside.md'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('路径穿越')

    await writeManifest({ name: 'absolute', version: '1', rules: ['/tmp/rule.md'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('相对路径')

    await writeManifest({ name: 'duplicate', version: '1', rules: ['same.md'], templates: ['same.md'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('同时声明')

    await writeManifest({ name: 'hook', version: '1', templates: ['template.txt'], main: 'payload.js' })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('manifest 无效')
  })

  it('rejects symlinks anywhere in the package, including undeclared assets', async () => {
    const outside = join(root, '..', `outside-${Date.now()}.txt`)
    await writeFile(outside, 'secret')
    await writeFile(join(root, 'rule.md'), '# Rule')
    await symlink(outside, join(root, 'undeclared-link'))
    await writeManifest({ name: 'linked', version: '1', rules: ['rule.md'] })

    try {
      await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('符号链接')
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('rejects JavaScript payloads anywhere in the package', async () => {
    await writeFile(join(root, 'rule.md'), '# Rule')
    await writeFile(join(root, 'bootstrap.mjs'), 'import "electron"')
    await writeManifest({ name: 'injection', version: '1', rules: ['rule.md'] })

    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('JavaScript')
  })

  it('requires each declared Skill to be a non-nested directory with SKILL.md', async () => {
    await mkdir(join(root, 'skills', 'empty'), { recursive: true })
    await writeManifest({ name: 'missing-entrypoint', version: '1', skills: ['skills/empty'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('缺少 SKILL.md')

    await mkdir(join(root, 'skills', 'parent', 'child'), { recursive: true })
    await writeFile(join(root, 'skills', 'parent', 'SKILL.md'), '# Parent')
    await writeFile(join(root, 'skills', 'parent', 'child', 'SKILL.md'), '# Child')
    await writeManifest({
      name: 'nested',
      version: '1',
      skills: ['skills/parent', 'skills/parent/child'],
    })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('互相嵌套')
  })

  it('enforces file count, per-file and package-wide byte limits', async () => {
    await writeFile(join(root, 'one.md'), '12345')
    await writeFile(join(root, 'two.md'), '67890')
    await writeManifest({ name: 'limits', version: '1', rules: ['one.md'] })

    await expect(new CapabilityPackageService({ maxFileBytes: 4 }).inspect(root)).rejects.toThrow('单文件')
    await expect(new CapabilityPackageService({ maxTotalBytes: 20 }).inspect(root)).rejects.toThrow('总大小')
    await expect(new CapabilityPackageService({ maxFiles: 2 }).inspect(root)).rejects.toThrow('文件数')
  })

  it('requires valid UTF-8 rules and safe object-shaped MCP JSON', async () => {
    await writeFile(join(root, 'bad-rule.txt'), Buffer.from([0xff, 0xfe]))
    await writeManifest({ name: 'bad-text', version: '1', rules: ['bad-rule.txt'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('UTF-8')

    await writeFile(join(root, 'mcp.json'), '["not-an-object"]')
    await writeManifest({ name: 'bad-mcp', version: '1', mcp: ['mcp.json'] })
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('根节点必须是 JSON 对象')

    await writeFile(join(root, 'mcp.json'), '{"__proto__":{"polluted":true}}')
    await expect(new CapabilityPackageService().inspect(root)).rejects.toThrow('不安全的 JSON 键')
  })
})
