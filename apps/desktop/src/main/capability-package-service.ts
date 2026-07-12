import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

import { z } from 'zod'

const MANIFEST_FILE = 'workbuddy-package.json'
const FORBIDDEN_CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const DEFAULT_LIMITS = {
  maxFiles: 2_048,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxMcpConfigBytes: 1024 * 1024,
  maxRuleBytes: 1024 * 1024,
} as const

const relativePathSchema = z.string().min(1).max(1_024)
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const manifestSchema = z.object({
  name: z.string().trim().min(1).max(128).refine(
    (value) => !hasControlCharacter(value),
    'name 不能包含控制字符',
  ),
  version: z.string().trim().min(1).max(64).refine(
    (value) => !hasControlCharacter(value),
    'version 不能包含控制字符',
  ),
  skills: z.array(relativePathSchema).max(128).default([]),
  mcp: z.array(relativePathSchema).max(128).default([]),
  rules: z.array(relativePathSchema).max(256).default([]),
  templates: z.array(relativePathSchema).max(512).default([]),
}).strict()

export type CapabilityPackageFileKind = 'manifest' | 'skill' | 'mcp' | 'rule' | 'template' | 'asset'

export interface CapabilityPackageManifest {
  name: string
  version: string
  skills: string[]
  mcp: string[]
  rules: string[]
  templates: string[]
}

export interface CapabilityPackageSkill {
  /** Canonical directory that can subsequently be passed to SkillService.import. */
  directory: string
  relativePath: string
}

export interface CapabilityPackageMcpConfig {
  relativePath: string
  config: Record<string, unknown>
}

export interface CapabilityPackageRule {
  relativePath: string
  content: string
}

export interface CapabilityPackageTemplate {
  relativePath: string
  size: number
  sha256: string
}

export interface CapabilityPackageFile {
  relativePath: string
  kind: CapabilityPackageFileKind
  size: number
  sha256: string
}

export interface ParsedCapabilityPackage {
  rootDirectory: string
  manifestPath: string
  manifest: CapabilityPackageManifest
  skills: CapabilityPackageSkill[]
  mcpConfigs: CapabilityPackageMcpConfig[]
  rules: CapabilityPackageRule[]
  templates: CapabilityPackageTemplate[]
  files: CapabilityPackageFile[]
  totalBytes: number
}

export interface CapabilityPackageLimits {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxManifestBytes: number
  maxMcpConfigBytes: number
  maxRuleBytes: number
}

interface ScannedFile {
  absolutePath: string
  relativePath: string
  size: number
  sha256: string
}

interface ScannedTree {
  directories: Map<string, string>
  files: Map<string, ScannedFile>
  totalBytes: number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const isWithin = (root: string, candidate: string, allowRoot = false): boolean => {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '') return allowRoot
  return pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(pathFromRoot)
}

const normalizeRelativePath = (input: string, label: string): string => {
  if (input.includes('\u0000')) throw new Error(`${label} 包含 NUL 字符`)
  // Manifests use forward slashes so the same package cannot acquire different
  // path semantics when moved between macOS and Windows.
  if (input.includes('\\')) throw new Error(`${label} 必须使用正斜杠作为路径分隔符`)
  if (isAbsolute(input) || win32.isAbsolute(input)) throw new Error(`${label} 必须是包内相对路径`)

  const segments = input.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} 包含空段、点段或路径穿越`)
  }
  return segments.join('/')
}

const normalizeUniquePaths = (paths: string[], label: string): string[] => {
  const seen = new Set<string>()
  return paths.map((path, index) => {
    const normalized = normalizeRelativePath(path, `${label}[${index}]`)
    if (seen.has(normalized)) throw new Error(`${label} 包含重复路径：${normalized}`)
    seen.add(normalized)
    return normalized
  })
}

const decodeUtf8 = (content: Buffer, label: string): string => {
  try {
    return utf8Decoder.decode(content)
  } catch {
    throw new Error(`${label} 必须是有效 UTF-8 文本`)
  }
}

const parseJson = (content: Buffer, label: string): unknown => {
  try {
    return JSON.parse(decodeUtf8(content, label)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} 不是有效 JSON`)
    throw error
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function assertSafeJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 的根节点必须是 JSON 对象`)

  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    visited += 1
    if (visited > 50_000) throw new Error(`${label} 的 JSON 结构过于复杂`)
    if (current.depth > 128) throw new Error(`${label} 的 JSON 嵌套过深`)

    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (!isRecord(current.value)) continue
    for (const [key, child] of Object.entries(current.value)) {
      if (DANGEROUS_JSON_KEYS.has(key)) throw new Error(`${label} 包含不安全的 JSON 键：${key}`)
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

const isPathInsideDirectory = (directory: string, candidate: string): boolean =>
  candidate.startsWith(`${directory}/`)

export class CapabilityPackageService {
  private readonly limits: CapabilityPackageLimits

  constructor(limits: Partial<CapabilityPackageLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数`)
    }
  }

  async inspect(input: string | { directory: string }): Promise<ParsedCapabilityPackage> {
    return this.inspectDirectory(typeof input === 'string' ? input : input.directory)
  }

  async inspectDirectory(directory: string): Promise<ParsedCapabilityPackage> {
    const requestedRoot = resolve(directory)
    const requestedInfo = await lstat(requestedRoot)
    if (requestedInfo.isSymbolicLink()) throw new Error('能力包根目录不能是符号链接')
    if (!requestedInfo.isDirectory()) throw new Error('请选择包含 workbuddy-package.json 的目录')
    const root = await realpath(requestedRoot)

    const initialManifestPath = join(root, MANIFEST_FILE)
    const initialManifest = await this.readRegularFile(root, initialManifestPath, this.limits.maxManifestBytes, '能力包 manifest')
    const rawManifest = parseJson(initialManifest.content, '能力包 manifest')
    const parsedManifest = manifestSchema.safeParse(rawManifest)
    if (!parsedManifest.success) {
      const issue = parsedManifest.error.issues[0]
      throw new Error(`能力包 manifest 无效：${issue?.message ?? 'schema 校验失败'}`)
    }

    const manifest: CapabilityPackageManifest = {
      name: parsedManifest.data.name,
      version: parsedManifest.data.version,
      skills: normalizeUniquePaths(parsedManifest.data.skills, 'skills'),
      mcp: normalizeUniquePaths(parsedManifest.data.mcp, 'mcp'),
      rules: normalizeUniquePaths(parsedManifest.data.rules, 'rules'),
      templates: normalizeUniquePaths(parsedManifest.data.templates, 'templates'),
    }
    if (manifest.skills.length + manifest.mcp.length + manifest.rules.length + manifest.templates.length === 0) {
      throw new Error('能力包必须至少声明一个 Skill、MCP 配置、规则或模板')
    }

    const tree = await this.scanTree(root)
    const scannedManifest = tree.files.get(MANIFEST_FILE)
    if (!scannedManifest || scannedManifest.sha256 !== initialManifest.sha256) {
      throw new Error('能力包 manifest 在校验期间发生变化，请重试')
    }

    this.assertNoComponentOverlap(manifest)
    const skills = await this.resolveSkills(root, tree, manifest.skills)
    const mcpConfigs = await Promise.all(manifest.mcp.map(async (path) => {
      if (extname(path).toLowerCase() !== '.json') throw new Error(`MCP 配置必须是 .json 文件：${path}`)
      const file = this.requiredFile(tree, path, 'MCP 配置')
      if (file.size > this.limits.maxMcpConfigBytes) throw new Error(`MCP 配置超过大小限制：${path}`)
      const read = await this.readRegularFile(root, file.absolutePath, this.limits.maxMcpConfigBytes, `MCP 配置 ${path}`)
      if (read.sha256 !== file.sha256) throw new Error(`MCP 配置在校验期间发生变化：${path}`)
      const config = parseJson(read.content, `MCP 配置 ${path}`)
      assertSafeJsonObject(config, `MCP 配置 ${path}`)
      return { relativePath: path, config }
    }))

    const rules = await Promise.all(manifest.rules.map(async (path) => {
      const file = this.requiredFile(tree, path, '规则')
      if (file.size > this.limits.maxRuleBytes) throw new Error(`规则文件超过大小限制：${path}`)
      const read = await this.readRegularFile(root, file.absolutePath, this.limits.maxRuleBytes, `规则 ${path}`)
      if (read.sha256 !== file.sha256) throw new Error(`规则文件在校验期间发生变化：${path}`)
      return { relativePath: path, content: decodeUtf8(read.content, `规则 ${path}`) }
    }))

    const templates = manifest.templates.map((path) => {
      const file = this.requiredFile(tree, path, '模板')
      return { relativePath: path, size: file.size, sha256: file.sha256 }
    })

    const files = [...tree.files.values()]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file): CapabilityPackageFile => ({
        relativePath: file.relativePath,
        kind: this.classifyFile(file.relativePath, manifest),
        size: file.size,
        sha256: file.sha256,
      }))

    return {
      rootDirectory: root,
      manifestPath: initialManifestPath,
      manifest,
      skills,
      mcpConfigs,
      rules,
      templates,
      files,
      totalBytes: tree.totalBytes,
    }
  }

  private async scanTree(root: string): Promise<ScannedTree> {
    const directories = new Map<string, string>([['', root]])
    const files = new Map<string, ScannedFile>()
    let totalBytes = 0

    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolutePath = join(directory, entry.name)
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        const info = await lstat(absolutePath)
        if (info.isSymbolicLink() || entry.isSymbolicLink()) {
          throw new Error(`能力包不能包含符号链接：${relativePath}`)
        }

        const canonical = await realpath(absolutePath)
        if (!isWithin(root, canonical)) throw new Error(`能力包路径逃逸：${relativePath}`)
        if (info.isDirectory()) {
          directories.set(relativePath, canonical)
          await visit(canonical, relativePath)
          continue
        }
        if (!info.isFile()) throw new Error(`能力包包含不支持的文件类型：${relativePath}`)
        if (FORBIDDEN_CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          throw new Error(`能力包不能包含可注入 Electron/Agent Host 的 JavaScript 文件：${relativePath}`)
        }

        if (info.size > this.limits.maxFileBytes) throw new Error(`能力包单文件超过大小限制：${relativePath}`)
        totalBytes += info.size
        if (totalBytes > this.limits.maxTotalBytes) throw new Error('能力包总大小超过限制')
        if (files.size + 1 > this.limits.maxFiles) throw new Error('能力包文件数超过限制')

        const read = await this.readRegularFile(root, canonical, this.limits.maxFileBytes, relativePath)
        files.set(relativePath, {
          absolutePath: canonical,
          relativePath,
          size: read.content.byteLength,
          sha256: read.sha256,
        })
      }
    }

    await visit(root, '')
    return { directories, files, totalBytes }
  }

  private async readRegularFile(
    root: string,
    filePath: string,
    maxBytes: number,
    label: string,
  ): Promise<{ content: Buffer; sha256: string }> {
    const before = await lstat(filePath)
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} 必须是普通文件且不能是符号链接`)
    if (before.size > maxBytes) throw new Error(`${label} 超过大小限制`)
    const canonical = await realpath(filePath)
    if (!isWithin(root, canonical)) throw new Error(`${label} 不在能力包目录内`)

    const content = await readFile(canonical)
    const after = await lstat(canonical)
    if (!after.isFile() || after.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || content.byteLength !== after.size) {
      throw new Error(`${label} 在读取期间发生变化，请重试`)
    }
    return { content, sha256: createHash('sha256').update(content).digest('hex') }
  }

  private requiredFile(tree: ScannedTree, path: string, label: string): ScannedFile {
    const file = tree.files.get(path)
    if (!file) throw new Error(`${label} 不是能力包内的普通文件：${path}`)
    return file
  }

  private async resolveSkills(root: string, tree: ScannedTree, paths: string[]): Promise<CapabilityPackageSkill[]> {
    return Promise.all(paths.map(async (path) => {
      const directory = tree.directories.get(path)
      if (!directory) throw new Error(`Skill 不是能力包内的普通目录：${path}`)
      if (!tree.files.has(`${path}/SKILL.md`)) throw new Error(`Skill 缺少 SKILL.md：${path}`)
      const canonical = await realpath(directory)
      if (!isWithin(root, canonical)) throw new Error(`Skill 路径逃逸：${path}`)
      return { directory: canonical, relativePath: path }
    }))
  }

  private assertNoComponentOverlap(manifest: CapabilityPackageManifest): void {
    for (let index = 0; index < manifest.skills.length; index += 1) {
      const skill = manifest.skills[index]
      if (!skill) continue
      for (const other of manifest.skills.slice(index + 1)) {
        if (isPathInsideDirectory(skill, other) || isPathInsideDirectory(other, skill)) {
          throw new Error(`Skill 目录不能互相嵌套：${skill} / ${other}`)
        }
      }
    }

    const declarations = [
      ...manifest.mcp.map((path) => ({ path, kind: 'MCP 配置' })),
      ...manifest.rules.map((path) => ({ path, kind: '规则' })),
      ...manifest.templates.map((path) => ({ path, kind: '模板' })),
    ]
    const seen = new Map<string, string>()
    for (const declaration of declarations) {
      const previous = seen.get(declaration.path)
      if (previous) throw new Error(`同一文件不能同时声明为 ${previous} 和 ${declaration.kind}：${declaration.path}`)
      seen.set(declaration.path, declaration.kind)
      const containingSkill = manifest.skills.find((skill) => isPathInsideDirectory(skill, declaration.path))
      if (containingSkill) throw new Error(`${declaration.kind} 不能复用 Skill 目录内文件：${declaration.path}`)
    }
  }

  private classifyFile(path: string, manifest: CapabilityPackageManifest): CapabilityPackageFileKind {
    if (path === MANIFEST_FILE) return 'manifest'
    if (manifest.skills.some((skill) => isPathInsideDirectory(skill, path))) return 'skill'
    if (manifest.mcp.includes(path)) return 'mcp'
    if (manifest.rules.includes(path)) return 'rule'
    if (manifest.templates.includes(path)) return 'template'
    return 'asset'
  }
}
