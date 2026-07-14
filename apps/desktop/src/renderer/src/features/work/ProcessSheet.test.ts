import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProcessStepKind, ProcessTimelineViewModel } from '../../work-turn.types'
import { ProcessIcon } from './ProcessIcon'
import { ProcessTimeline, ProcessTrigger } from './ProcessSheet'

const kinds: ProcessStepKind[] = ['understand', 'plan', 'search', 'read_web', 'browser', 'file', 'command', 'connector', 'write', 'output', 'verify', 'approval', 'recovery', 'complete']

const timeline: ProcessTimelineViewModel = {
  turnId: 'turn-1',
  state: 'succeeded',
  headline: '4 个步骤',
  steps: [{
    id: 'step-1', kind: 'search', state: 'succeeded', title: '搜索了“今日新闻”', count: 1,
    sourceUrls: ['https://example.com/news'], artifactIds: [], toolCallIds: ['private-call-id'], traceSpanIds: ['private-span-id'],
  }],
}

describe('process UI primitives', () => {
  it('draws every process kind as a native 20 by 20 SVG', () => {
    const markup = kinds.map((kind) => renderToStaticMarkup(createElement(ProcessIcon, { kind })))
    expect(markup).toHaveLength(14)
    for (const icon of markup) {
      expect(icon).toContain('viewBox="0 0 20 20"')
      expect(icon).toContain('stroke-width="1.6"')
      expect(icon).not.toContain('<img')
    }
    expect(new Set(markup).size).toBe(14)
  })

  it('renders a compact accessible trigger and semantic timeline without diagnostic ids', () => {
    const trigger = renderToStaticMarkup(createElement(ProcessTrigger, { timeline, onOpen: () => undefined }))
    const list = renderToStaticMarkup(createElement(ProcessTimeline, { timeline }))
    expect(trigger).toContain('查看执行过程：4 个步骤')
    expect(list).toContain('<ol')
    expect(list).toContain('搜索了“今日新闻”')
    expect(list).toContain('example.com')
    expect(list).not.toContain('private-call-id')
    expect(list).not.toContain('private-span-id')
  })
})
