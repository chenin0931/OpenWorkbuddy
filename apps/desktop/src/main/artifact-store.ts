import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AppDatabase } from './database'

const mimeFor = (name: string): string => {
  const ext = extname(name).toLowerCase()
  return ({
    '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml', '.html': 'text/html',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
  } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

export class ArtifactStore {
  constructor(private root: string, private database: AppDatabase) {}

  async putBuffer(input: { runId?: string; name: string; kind: string; data: Buffer; mime?: string; metadata?: Record<string, unknown> }): Promise<any> {
    const sha256 = createHash('sha256').update(input.data).digest('hex')
    const directory = join(this.root, sha256.slice(0, 2))
    const path = join(directory, sha256)
    await mkdir(directory, { recursive: true })
    try { await readFile(path) } catch { await writeFile(path, input.data, { mode: 0o600 }) }
    const id = randomUUID()
    this.database.addArtifact({ id, runId: input.runId, kind: input.kind, name: basename(input.name), path, sha256, mime: input.mime ?? mimeFor(input.name), size: input.data.byteLength, metadata: input.metadata ?? {} })
    const persisted = this.database.getArtifact(id)
    if (!persisted) throw new Error(`Artifact persistence failed: ${id}`)
    return {
      ...persisted,
      ...(persisted.run_id ? { runId: persisted.run_id } : {}),
      metadata: input.metadata ?? {},
      createdAt: persisted.created_at,
    }
  }

  async putText(input: { runId?: string; name: string; kind: string; content: string; mime?: string; metadata?: Record<string, unknown> }): Promise<any> {
    return this.putBuffer({ ...input, data: Buffer.from(input.content, 'utf8') })
  }

  async read(path: string): Promise<Buffer> { return readFile(path) }
}
