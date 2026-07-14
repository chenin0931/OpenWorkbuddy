import { describe, expect, it } from 'vitest'
import type { ToolActivityItem, TraceSpanItem } from './types'
import { buildProcessTimeline, sanitizeProcessText } from './process-view'

const at = (second: number) => `2026-07-15T02:00:${String(second).padStart(2, '0')}.000Z`

function tool(id: string, toolName: string, second: number, extra: Partial<ToolActivityItem> = {}): ToolActivityItem {
  return { id, toolName, status: 'succeeded', sources: [], createdAt: at(second), updatedAt: at(second), ...extra }
}

function trace(id: string, name: string, second: number): TraceSpanItem {
  return {
    id,
    traceId: 'trace-1',
    kind: 'tool_call',
    name,
    status: 'succeeded',
    startedAt: at(second),
    endedAt: at(second + 1),
    durationMs: 1_000,
    attributes: {},
    artifactIds: [],
  }
}

function timeline(overrides: Partial<Parameters<typeof buildProcessTimeline>[0]> = {}) {
  return buildProcessTimeline({
    turnId: 'turn-1',
    prompt: '调研今天的新闻',
    tools: [],
    steps: [],
    traceSpans: [],
    approvals: [],
    artifacts: [],
    runStatus: 'completed',
    isLatest: true,
    startedAt: at(0),
    endedAt: at(20),
    ...overrides,
  })
}

describe('process view model', () => {
  it('does not expose a process for ordinary answers without operational work', () => {
    expect(timeline()).toBeUndefined()
  })

  it('shows one live preparation step while an ordinary turn is still running', () => {
    const process = timeline({ runStatus: 'running' })
    expect(process).toMatchObject({ state: 'running', headline: '正在分析任务 · 0/1 步' })
    expect(process?.steps).toMatchObject([{ kind: 'understand', state: 'running', title: '正在分析任务要求' }])
  })

  it('keeps distinct searches and aggregates consecutive source reads', () => {
    const process = timeline({
      tools: [
        tool('search-1', 'web_search', 2, { argumentsSummary: { query: '今日新闻 2026年7月15日' } }),
        tool('search-2', 'web_search', 4, { argumentsSummary: { query: 'July 15 2026 news' } }),
        tool('fetch-1', 'web_fetch', 6, { sources: [{ id: 's1', title: '官方新闻', url: 'https://example.com/a' }] }),
        tool('fetch-2', 'web_fetch', 8, { sources: [{ id: 's2', title: '第二来源', url: 'https://news.example.org/b' }] }),
      ],
      traceSpans: [trace('span-1', 'web_search', 2), trace('span-2', 'web_fetch', 6)],
    })

    expect(process?.steps.map((step) => step.title)).toEqual([
      '已分析任务要求',
      '搜索了“今日新闻 2026年7月15日”',
      '搜索了“July 15 2026 news”',
      '读取了 2 个网页来源',
      '已整理并交付结果',
    ])
    expect(process?.steps[3]).toMatchObject({ count: 2, sourceUrls: ['https://example.com/a', 'https://news.example.org/b'] })
  })

  it('falls back to receipts when traces are unavailable and merges file reads', () => {
    const process = timeline({
      tools: [
        tool('read-1', 'file_read', 2, { argumentsSummary: { path: '/Users/chen/Desktop/work/src/a.ts' } }),
        tool('read-2', 'file_read', 3, { argumentsSummary: { path: '/Users/chen/Desktop/work/src/b.ts' } }),
      ],
    })
    expect(process?.steps.some((step) => step.title === '检查了工作区中的 2 个文件')).toBe(true)
    expect(JSON.stringify(process)).not.toContain('/Users/chen')
  })

  it('uses a natural workspace label for legacy filesystem list receipts', () => {
    const process = timeline({ tools: [tool('list-1', 'filesystem_list', 2, { argumentsSummary: { path: '.' } })] })
    expect(process?.steps.some((step) => step.kind === 'file' && step.title === '浏览了工作区')).toBe(true)
  })

  it('marks a recovered failure as warning without failing the process', () => {
    const process = timeline({
      tools: [
        tool('read-failed', 'file_read', 2, { status: 'failed', error: '文件格式不可读' }),
        tool('read-ok', 'file_read', 4, { status: 'succeeded' }),
      ],
    })
    expect(process?.state).toBe('warning')
    expect(process?.steps.some((step) => step.kind === 'recovery' && step.state === 'warning')).toBe(true)
    expect(process?.headline).toContain('有提示')
  })

  it('redacts credentials and absolute home paths from process copy', () => {
    const sanitized = sanitizeProcessText('Authorization: Bearer secret-token-123 /Users/chen/private/file.txt sk-1234567890abcdef')
    expect(sanitized).not.toContain('secret-token')
    expect(sanitized).not.toContain('/Users/chen')
    expect(sanitized).not.toContain('sk-123')
  })
})
