import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import type { SkillDetail } from '@onmyworkbuddy/contracts'
import type { SkillManifest, SkillPermission } from '@onmyworkbuddy/contracts'

import type { AppDatabase } from './database'

const ENTRYPOINT = 'SKILL.md'
const MAX_SKILL_FILE_BYTES = 1024 * 1024
const MAX_IMPORT_FILES = 2_048
const MAX_IMPORT_BYTES = 50 * 1024 * 1024
const MAX_ENUMERATED_FILES = 2_048
const ALLOWED_CAPABILITIES = new Set<SkillPermission['capability']>([
  'filesystem_read',
  'filesystem_write',
  'shell',
  'network',
  'browser',
  'mcp',
])

interface SkillRow {
  id: string
  name: string
  description: string
  version: string
  path: string
  enabled: boolean
  permissions: SkillPermission[]
  updatedAt?: string
}

interface ParsedSkill {
  name: string
  description: string
  version: string
  permissions: SkillPermission[]
  instructions: string
}

interface CopyBudget {
  files: number
  bytes: number
}

type YamlModule = { parse(source: string): unknown }

let yamlModule: YamlModule | undefined

/**
 * yaml is intentionally obtained from pi-agent-core's declared dependency.
 * That keeps the parser version aligned with the underlying agent harness
 * without relying on pnpm hoisting a transitive dependency to this package.
 */
const parseYaml = (source: string): unknown => {
  if (!yamlModule) {
    const localRequire = createRequire(import.meta.url)
    const piPackage = localRequire.resolve('@earendil-works/pi-agent-core/package.json')
    const piRequire = createRequire(piPackage)
    yamlModule = piRequire('yaml') as YamlModule
  }
  const parser = yamlModule
  if (!parser) throw new Error('无法加载 Skill YAML 解析器')
  return parser.parse(source)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isWithin = (root: string, candidate: string, allowRoot = false): boolean => {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '') return allowRoot
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(pathFromRoot)
}

const ensureValidName = (value: unknown, fallback: string): string => {
  const name = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Skill name 必须为不超过 64 个字符的小写字母、数字和单连字符组合')
  }
  return name
}

const readTextWithinLimit = async (filePath: string): Promise<string> => {
  const info = await lstat(filePath)
  if (!info.isFile()) throw new Error(`${ENTRYPOINT} 不是普通文件`)
  if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`${ENTRYPOINT} 超过 1 MB 限制`)
  return readFile(filePath, 'utf8')
}

const parsePermissions = (value: unknown): SkillPermission[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('permissions 必须是数组')

  const seen = new Set<string>()
  const result: SkillPermission[] = []
  for (const entry of value) {
    const capability = typeof entry === 'string'
      ? entry
      : isRecord(entry) && typeof entry.capability === 'string'
        ? entry.capability
        : undefined
    if (!capability || !ALLOWED_CAPABILITIES.has(capability as SkillPermission['capability'])) {
      throw new Error(`不支持的 Skill 权限：${capability ?? 'unknown'}`)
    }
    const detail = isRecord(entry) && typeof entry.detail === 'string' && entry.detail.trim()
      ? entry.detail.trim()
      : undefined
    const key = `${capability}\u0000${detail ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(detail
      ? { capability: capability as SkillPermission['capability'], detail }
      : { capability: capability as SkillPermission['capability'] })
  }
  return result
}

const splitFrontmatter = (raw: string): { metadata: Record<string, unknown>; instructions: string } => {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { metadata: {}, instructions: normalized.trim() }

  const end = normalized.indexOf('\n---\n', 4)
  const terminalEnd = normalized.endsWith('\n---') ? normalized.length - 4 : -1
  const endIndex = end >= 0 ? end : terminalEnd
  if (endIndex < 0) throw new Error(`${ENTRYPOINT} 的 YAML frontmatter 未闭合`)

  const parsed = parseYaml(normalized.slice(4, endIndex))
  if (parsed !== null && parsed !== undefined && !isRecord(parsed)) {
    throw new Error(`${ENTRYPOINT} 的 YAML frontmatter 必须是对象`)
  }
  const bodyOffset = end >= 0 ? endIndex + 5 : endIndex + 4
  return { metadata: (parsed ?? {}) as Record<string, unknown>, instructions: normalized.slice(bodyOffset).trim() }
}

const parseSkillFile = async (directory: string): Promise<ParsedSkill> => {
  const raw = await readTextWithinLimit(join(directory, ENTRYPOINT))
  const { metadata, instructions } = splitFrontmatter(raw)
  const name = ensureValidName(metadata.name, basename(directory))
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
  if (!description) throw new Error('Skill description 不能为空')
  if (description.length > 1_024) throw new Error('Skill description 不能超过 1024 个字符')

  const version = typeof metadata.version === 'string' && metadata.version.trim()
    ? metadata.version.trim()
    : '1.0.0'
  if (version.length > 64) throw new Error('Skill version 不能超过 64 个字符')

  return {
    name,
    description,
    version,
    permissions: parsePermissions(metadata.permissions),
    instructions,
  }
}

const copyTree = async (source: string, destination: string, budget: CopyBudget): Promise<void> => {
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink()) throw new Error(`Skill 包不能包含符号链接：${source}`)
  if (sourceInfo.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.' || entry.name === '..') continue
      await copyTree(join(source, entry.name), join(destination, entry.name), budget)
    }
    return
  }
  if (!sourceInfo.isFile()) throw new Error(`Skill 包含不支持的文件类型：${source}`)

  budget.files += 1
  budget.bytes += sourceInfo.size
  if (budget.files > MAX_IMPORT_FILES) throw new Error(`Skill 包文件数不能超过 ${MAX_IMPORT_FILES}`)
  if (budget.bytes > MAX_IMPORT_BYTES) throw new Error('Skill 包大小不能超过 50 MB')
  await copyFile(source, destination)
  await chmod(destination, sourceInfo.mode & 0o777)
}

const enumerateFiles = async (skillRoot: string, folderName: string): Promise<string[]> => {
  const folder = join(skillRoot, folderName)
  let folderInfo
  try {
    folderInfo = await lstat(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) return []

  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile()) {
        const relativePath = relative(skillRoot, absolutePath)
        if (!isWithin(skillRoot, absolutePath)) continue
        output.push(relativePath)
        if (output.length > MAX_ENUMERATED_FILES) throw new Error('Skill 文件枚举超过安全上限')
      }
    }
  }
  await visit(folder)
  return output
}

const toManifest = (row: SkillRow): SkillManifest => {
  const manifest: SkillManifest = {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    directory: row.path,
    enabled: row.enabled,
    permissions: row.permissions,
    entrypoint: ENTRYPOINT,
  }
  if (row.updatedAt) manifest.loadedAt = row.updatedAt
  return manifest
}

export class SkillService {
  readonly skillsRoot: string

  constructor(private readonly database: AppDatabase, skillsRoot: string) {
    this.skillsRoot = resolve(skillsRoot)
  }

  private rows(): SkillRow[] {
    return this.database.listSkills().map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      version: String(row.version ?? '1.0.0'),
      path: resolve(String(row.path)),
      enabled: Boolean(row.enabled),
      permissions: Array.isArray(row.permissions) ? row.permissions as SkillPermission[] : [],
      ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    }))
  }

  private rowById(id: string): SkillRow {
    const row = this.rows().find((candidate) => candidate.id === id)
    if (!row) throw new Error('Skill 不存在')
    return row
  }

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 })
    return realpath(this.skillsRoot)
  }

  private async assertManagedDirectory(directory: string): Promise<string> {
    const root = await this.canonicalRoot()
    const canonical = await realpath(directory)
    if (!isWithin(root, canonical)) throw new Error('Skill 路径不在受管目录中')
    return canonical
  }

  /** Reconciles valid top-level skill directories with the database. */
  async scan(): Promise<SkillManifest[]> {
    const root = await this.canonicalRoot()
    const entries = await readdir(root, { withFileTypes: true })
    const discovered = new Set<string>()

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = join(root, entry.name)
      try {
        const parsed = await parseSkillFile(directory)
        const canonical = await this.assertManagedDirectory(directory)
        discovered.add(canonical)
        const existing = this.rows().find((row) => row.path === canonical)
        this.database.upsertSkill({
          ...(existing ? { id: existing.id } : {}),
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          scope: 'user',
          path: canonical,
          permissions: parsed.permissions,
          enabled: existing?.enabled ?? true,
        })
      } catch {
        // A malformed manually-added directory must not prevent other skills
        // from loading. It remains absent from the callable manifest list.
      }
    }

    return this.rows()
      .filter((row) => discovered.has(row.path))
      .map(toManifest)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async list(): Promise<SkillManifest[]> {
    return this.scan()
  }

  async get(input: string | { id: string }): Promise<SkillDetail> {
    const id = typeof input === 'string' ? input : input.id
    const row = this.rowById(id)
    const directory = await this.assertManagedDirectory(row.path)
    const parsed = await parseSkillFile(directory)
    const [references, reference, scripts] = await Promise.all([
      enumerateFiles(directory, 'references'),
      enumerateFiles(directory, 'reference'),
      enumerateFiles(directory, 'scripts'),
    ])
    return {
      manifest: toManifest({ ...row, ...parsed, path: directory }),
      instructions: parsed.instructions,
      referenceFiles: [...new Set([...references, ...reference])].sort(),
      scriptFiles: scripts,
    }
  }

  async import(input: string | { directory: string }): Promise<SkillManifest> {
    return this.importDirectory(typeof input === 'string' ? input : input.directory)
  }

  async importDirectory(directory: string): Promise<SkillManifest> {
    const source = await realpath(resolve(directory))
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isDirectory()) throw new Error('请选择包含 SKILL.md 的目录')
    const parsed = await parseSkillFile(source)
    const root = await this.canonicalRoot()
    const destination = join(root, parsed.name)
    if (!isWithin(root, destination)) throw new Error('非法的 Skill 目标路径')

    const temporary = join(root, `.${parsed.name}.import-${randomUUID()}`)
    const backup = join(root, `.${parsed.name}.backup-${randomUUID()}`)
    let hasBackup = false
    let installed = false

    try {
      await copyTree(source, temporary, { files: 0, bytes: 0 })
      // Parse the copy too, so the database never points at a partial package.
      await parseSkillFile(temporary)

      try {
        const destinationInfo = await lstat(destination)
        if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
          throw new Error('目标 Skill 路径不是安全目录')
        }
        await rename(destination, backup)
        hasBackup = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      await rename(temporary, destination)
      installed = true
      const canonical = await this.assertManagedDirectory(destination)
      const existing = this.rows().find((row) => row.path === canonical)
      this.database.upsertSkill({
        ...(existing ? { id: existing.id } : {}),
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        scope: 'user',
        path: canonical,
        permissions: parsed.permissions,
        enabled: existing?.enabled ?? true,
      })

      const saved = this.rows().find((row) => row.path === canonical)
      if (!saved) throw new Error('Skill 导入后未能写入数据库')
      if (hasBackup) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      return toManifest(saved)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (installed) await rm(destination, { recursive: true, force: true })
      if (hasBackup) await rename(backup, destination).catch(() => undefined)
      throw error
    }
  }

  async setEnabled(input: { id: string; enabled: boolean } | string, enabled?: boolean): Promise<SkillManifest> {
    const id = typeof input === 'string' ? input : input.id
    const nextEnabled = typeof input === 'string' ? enabled : input.enabled
    if (nextEnabled === undefined) throw new Error('缺少 enabled 参数')
    this.rowById(id)
    this.database.db.prepare('UPDATE skills SET enabled=?,updated_at=? WHERE id=?')
      .run(nextEnabled ? 1 : 0, new Date().toISOString(), id)
    return toManifest(this.rowById(id))
  }

  async remove(input: string | { id: string }): Promise<void> {
    const id = typeof input === 'string' ? input : input.id
    const row = this.rowById(id)
    const root = await this.canonicalRoot()
    const lexicalPath = resolve(row.path)
    if (!isWithin(root, lexicalPath)) throw new Error('拒绝删除受管目录以外的路径')

    try {
      const directory = await this.assertManagedDirectory(lexicalPath)
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.database.db.prepare('DELETE FROM skills WHERE id=?').run(id)
  }
}
