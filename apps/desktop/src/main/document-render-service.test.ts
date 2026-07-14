import { describe, expect, it } from 'vitest'
import { defaultDocumentOutputPath, renderMarkdownBody } from './document-render-service'

describe('document renderer', () => {
  it('derives a stable PDF path', () => {
    expect(defaultDocumentOutputPath('/tmp/report.md')).toBe('/tmp/report.pdf')
    expect(defaultDocumentOutputPath('/tmp/report.markdown')).toBe('/tmp/report.markdown.pdf')
  })

  it('renders GFM while ignoring raw HTML and scripts', () => {
    const html = renderMarkdownBody('# Report\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>globalThis.pwned=true</script>')
    expect(html).toContain('<h1>Report</h1>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;globalThis.pwned=true&lt;/script&gt;')
  })
})
