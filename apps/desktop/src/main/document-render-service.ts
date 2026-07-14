import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrowserWindow, session, type Session } from 'electron'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { ArtifactStore } from './artifact-store'
import type { ToolRunnerBridge } from './worker-bridge'

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const MAX_PDF_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_COUNT = 10
const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024

const mimeForImage = (path: string): string => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}[extname(path).toLowerCase()] ?? 'application/octet-stream')

export function defaultDocumentOutputPath(inputPath: string): string {
  return extname(inputPath).toLowerCase() === '.md' ? `${inputPath.slice(0, -3)}.pdf` : `${inputPath}.pdf`
}

export function renderMarkdownBody(markdown: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown))
}

export interface DocumentRenderInput {
  runId: string
  inputPath: string
  outputPath?: string
  title?: string
  workspacePath: string
  authorizedRoot: string
}

export interface DocumentRenderResult {
  inputPath: string
  outputPath: string
  sha256: string
  size: number
  pages: number
  snapshotArtifactId?: string
}

export class DocumentRenderService {
  private readonly renderSession: Session

  constructor(private readonly runner: ToolRunnerBridge, private readonly artifacts: ArtifactStore) {
    this.renderSession = session.fromPartition('openworkbuddy-document-render')
    this.renderSession.setPermissionCheckHandler(() => false)
    this.renderSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    this.renderSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.url.startsWith('http://') || details.url.startsWith('https://') })
    })
  }

  async render(input: DocumentRenderInput): Promise<DocumentRenderResult> {
    const source = await this.runner.execute({
      runId: input.runId,
      toolId: 'file.read',
      args: { path: input.inputPath },
      workspacePath: input.workspacePath,
      authorizedRoot: input.authorizedRoot,
    })
    const markdown = String(source.content ?? '')
    if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) throw Object.assign(new Error('Markdown 文件超过 2 MB'), { code: 'DOCUMENT_INPUT_TOO_LARGE' })
    const outputPath = input.outputPath?.trim() || defaultDocumentOutputPath(String(source.path ?? input.inputPath))
    const embeddedMarkdown = await this.embedLocalImages(markdown, String(source.path ?? input.inputPath), input)
    let pdf: Buffer | undefined
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { pdf = await this.printPdf(embeddedMarkdown, input.title?.trim() || basename(input.inputPath, extname(input.inputPath))); break } catch (error) { lastError = error }
    }
    if (!pdf) throw lastError instanceof Error ? lastError : new Error('PDF 生成失败')
    if (pdf.byteLength > MAX_PDF_BYTES) throw Object.assign(new Error('生成的 PDF 超过 50 MB'), { code: 'DOCUMENT_OUTPUT_TOO_LARGE' })
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('PDF Header 校验失败'), { code: 'INVALID_PDF' })

    let existing: any
    try {
      existing = await this.runner.execute({ runId: input.runId, toolId: 'file.read_binary', args: { path: outputPath }, workspacePath: input.workspacePath, authorizedRoot: input.authorizedRoot })
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    let snapshotArtifactId: string | undefined
    if (existing?.data) {
      const snapshot = await this.artifacts.putBuffer({ runId: input.runId, name: `${basename(outputPath)}.before`, kind: 'file_snapshot', data: Buffer.from(existing.data, 'base64'), mime: 'application/pdf', metadata: { path: existing.path, sha256: existing.sha256, createdFile: false, capturedBeforeMutation: true } })
      snapshotArtifactId = snapshot.id
    }
    const written = await this.runner.execute({
      runId: input.runId,
      toolId: 'file.write_binary',
      args: { path: outputPath, data: pdf.toString('base64'), ...(existing?.sha256 ? { expectedSha256: existing.sha256 } : {}) },
      workspacePath: input.workspacePath,
      authorizedRoot: input.authorizedRoot,
    })
    const pages = Math.max(1, (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length)
    return {
      inputPath: String(source.path ?? input.inputPath),
      outputPath: String(written.path ?? outputPath),
      sha256: String(written.sha256),
      size: Number(written.size ?? pdf.byteLength),
      pages,
      ...(snapshotArtifactId ? { snapshotArtifactId } : {}),
    }
  }

  private async embedLocalImages(markdown: string, inputPath: string, input: DocumentRenderInput): Promise<string> {
    const matches = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    let rendered = markdown
    let totalBytes = 0
    let count = 0
    for (const match of matches) {
      const full = match[0]
      const alt = match[1] ?? ''
      const reference = match[2] ?? ''
      if (/^https?:\/\//i.test(reference)) { rendered = rendered.replace(full, `_${alt || '远程图片'}（未嵌入远程资源）_`); continue }
      if (reference.startsWith('data:')) continue
      if (count >= MAX_IMAGE_COUNT) { rendered = rendered.replace(full, `_${alt || '图片'}（超过嵌入数量上限）_`); continue }
      const path = isAbsolute(reference) ? reference : join(dirname(inputPath), decodeURIComponent(reference))
      const image = await this.runner.execute({ runId: input.runId, toolId: 'file.read_binary', args: { path }, workspacePath: input.workspacePath, authorizedRoot: input.authorizedRoot })
      const bytes = Number(image.size ?? 0)
      const mime = mimeForImage(path)
      if (!mime.startsWith('image/') || bytes > 10 * 1024 * 1024 || totalBytes + bytes > MAX_IMAGE_TOTAL_BYTES) {
        rendered = rendered.replace(full, `_${alt || '图片'}（无法安全嵌入）_`); continue
      }
      count += 1; totalBytes += bytes
      rendered = rendered.replace(full, `![${alt}](data:${mime};base64,${image.data})`)
    }
    return rendered
  }

  private async printPdf(markdown: string, title: string): Promise<Buffer> {
    const body = renderMarkdownBody(markdown)
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${this.escape(title)}</title><style>
      @page{size:A4;margin:18mm 17mm}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#242629;font-size:13px;line-height:1.65;margin:0}h1{font-size:26px;margin:0 0 18px}h2{font-size:20px;margin:24px 0 10px}h3{font-size:16px;margin:20px 0 8px}p{margin:8px 0}img{display:block;max-width:100%;max-height:220mm;margin:12px auto}pre,code{font-family:SFMono-Regular,Consolas,monospace}pre{white-space:pre-wrap;background:#f4f4f2;padding:12px;border-radius:6px}code{font-size:11px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #d6d7d8;padding:6px 8px;text-align:left;vertical-align:top}blockquote{border-left:3px solid #4964cf;margin:12px 0;padding-left:12px;color:#555}a{color:#2749b7;text-decoration:none}hr{border:0;border-top:1px solid #ddd;margin:24px 0}</style></head><body>${body}</body></html>`
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, session: this.renderSession } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    try {
      await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
      return await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
  }

  private escape(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  }
}
