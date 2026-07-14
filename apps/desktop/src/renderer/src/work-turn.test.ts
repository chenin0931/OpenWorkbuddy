import { describe, expect, it } from 'vitest'
import type { EventItem, RunDetailView, ToolActivityItem } from './types'
import { attentionForRun, buildWorkTurns, classifyToolActivity, isSourceWarning } from './work-turn'

const at = (minute: number) => `2026-07-12T10:${String(minute).padStart(2, '0')}:00.000Z`

function message(id: string, actor: 'user' | 'agent', content: string, minute: number): EventItem {
  return { id, type: 'message.completed', title: actor === 'user' ? '你' : 'WorkBuddy', actor, content, createdAt: at(minute) }
}

function tool(id: string, toolName: string, minute: number, status: ToolActivityItem['status'] = 'succeeded'): ToolActivityItem {
  return { id, toolName, status, sources: [], createdAt: at(minute), updatedAt: at(minute) }
}

function detail(overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    id: 'run-1',
    title: '整理工作区',
    prompt: '整理工作区',
    status: 'completed',
    createdAt: at(0),
    updatedAt: at(20),
    steps: [],
    events: [],
    toolCalls: [],
    sources: [],
    approvals: [],
    approvalHistory: [],
    artifacts: [],
    diffs: [],
    context: [],
    traces: [],
    traceSpans: [],
    ...overrides,
  }
}

describe('WorkTurn view model', () => {
  it('groups messages and activities by the preceding user turn', () => {
    const turns = buildWorkTurns(detail({
      events: [
        message('user-1', 'user', '先读取项目', 1),
        message('assistant-1', 'agent', '我先查看项目。', 2),
        message('assistant-2', 'agent', '已经找到入口。', 4),
        message('user-2', 'user', '再运行测试', 10),
        message('assistant-3', 'agent', '测试通过。', 13),
      ],
      toolCalls: [
        tool('read-1', 'file_read', 3),
        tool('shell-1', 'shell_run', 12),
      ],
    }))

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      prompt: { content: '先读取项目' },
      response: { content: '已经找到入口。', messageIds: ['assistant-1', 'assistant-2'] },
      activity: [{ kind: 'files', state: 'completed', count: 1, summary: '已完成 1 项文件操作', eventIds: ['read-1'] }],
      process: { state: 'succeeded', headline: '2 个步骤' },
    })
    expect(turns[1]).toMatchObject({
      prompt: { content: '再运行测试' },
      response: { content: '测试通过。' },
      activity: [{ kind: 'shell', state: 'completed', count: 1, summary: '已完成 1 条命令', eventIds: ['shell-1'] }],
    })
  })

  it('coalesces streaming prefixes and groups every activity kind with natural summaries', () => {
    const turns = buildWorkTurns(detail({
      status: 'running',
      events: [
        message('user-1', 'user', '执行完整流程', 1),
        message('stream-1', 'agent', '正在', 2),
        message('stream-2', 'agent', '正在处理', 3),
      ],
      toolCalls: [
        tool('file-1', 'file_read', 4),
        tool('file-2', 'file_write', 5),
        tool('shell-1', 'shell_run', 6, 'running'),
        tool('web-1', 'web_search', 7),
        tool('mcp-1', 'mcp_call_tool', 8),
        tool('other-1', 'memory_propose', 9, 'failed'),
      ],
      steps: [
        { id: 'step-1', title: '检查结果', status: 'completed', createdAt: at(3), updatedAt: at(9) },
      ],
    }))

    expect(turns[0]?.response.content).toBe('')
    expect(turns[0]?.attention).toBe('working')
    expect(turns[0]?.process?.headline).toContain('正在')
    expect(turns[0]?.activity.map(({ kind, state, summary }) => ({ kind, state, summary }))).toEqual([
      { kind: 'files', state: 'completed', summary: '已完成 2 项文件操作' },
      { kind: 'shell', state: 'running', summary: '正在处理 1 条命令' },
      { kind: 'web', state: 'completed', summary: '已完成 1 项网页操作' },
      { kind: 'mcp', state: 'completed', summary: '已完成 1 项连接操作' },
      { kind: 'other', state: 'failed', summary: '1 项操作未完成' },
      { kind: 'plan', state: 'completed', summary: '已完成 1 个计划步骤' },
    ])
  })

  it('attaches current verification and result evidence only to the latest turn', () => {
    const turns = buildWorkTurns(detail({
      events: [
        message('user-1', 'user', '先分析', 1),
        message('assistant-1', 'agent', '分析完成', 2),
        message('user-2', 'user', '现在修改', 10),
        message('assistant-2', 'agent', '修改完成', 11),
      ],
      verification: {
        status: 'partial',
        summary: '还有 1 项未检查',
        checks: [{ name: '构建', status: 'passed' }, { name: '浏览器', status: 'not_run' }],
      },
      diffs: [{ id: 'diff-1', path: 'src/App.tsx', additions: 8, deletions: 2 }],
      artifacts: [{ id: 'output-1', name: '报告.md', kind: 'final_output' }],
      sources: [{ id: 'source-1', url: 'https://example.com', status: 'verified' }],
    }))

    expect(turns[0]?.result).toBeUndefined()
    expect(turns[1]?.result).toMatchObject({
      status: 'partial',
      summary: '还有 1 项未检查',
      changes: [{ id: 'diff-1', path: 'src/App.tsx' }],
      checks: [{ name: '构建', status: 'passed' }, { name: '浏览器', status: 'not_run' }],
      outputs: [{ id: 'output-1', name: '报告.md' }],
      sources: [{ id: 'source-1', url: 'https://example.com' }],
    })
  })

  it('uses a synthetic prompt when persisted messages are unavailable', () => {
    const turns = buildWorkTurns(detail({
      prompt: '读取工作区',
      events: [message('assistant-1', 'agent', '已读取。', 2)],
      toolCalls: [tool('read-1', 'file_read', 1)],
    }))

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      prompt: { id: 'run-1-prompt', content: '读取工作区', messageIds: [] },
      response: { content: '已读取。' },
      activity: [{ kind: 'files', eventIds: ['read-1'] }],
    })
  })

  it('settles a stale running step as completed when the finished run is verified', () => {
    const turns = buildWorkTurns(detail({
      status: 'completed',
      result: 'verified',
      events: [
        message('user-1', 'user', '完成并检查这项工作', 1),
        message('assistant-1', 'agent', '检查已经完成。', 4),
      ],
      steps: [
        { id: 'step-stale', title: '运行检查', status: 'running', createdAt: at(2), updatedAt: at(3) },
      ],
      verification: {
        status: 'verified',
        summary: '检查通过',
        checks: [{ name: '运行检查', status: 'passed' }],
      },
    }))

    expect(turns[0]?.activity).toMatchObject([
      { kind: 'plan', state: 'completed', summary: '已完成 1 个计划步骤' },
    ])
    expect(turns[0]?.activity.some((group) => group.state === 'running')).toBe(false)
  })

  it('settles a stale running step as failed when the finished run is partial', () => {
    const turns = buildWorkTurns(detail({
      status: 'completed',
      result: 'partial',
      events: [
        message('user-1', 'user', '完成并检查这项工作', 1),
        message('assistant-1', 'agent', '仍有内容没有检查。', 4),
      ],
      steps: [
        { id: 'step-stale', title: '浏览器检查', status: 'running', createdAt: at(2), updatedAt: at(3) },
      ],
      verification: {
        status: 'partial',
        summary: '仍有内容没有检查',
        checks: [{ name: '浏览器检查', status: 'not_run' }],
      },
    }))

    expect(turns[0]?.activity).toMatchObject([
      { kind: 'plan', state: 'failed', summary: '1 个计划步骤未完成' },
    ])
    expect(turns[0]?.activity.some((group) => group.state === 'running')).toBe(false)
  })

  it('maps attention states without turning ordinary completion into a status', () => {
    expect(attentionForRun('running')).toBe('working')
    expect(attentionForRun('completed')).toBeUndefined()
    expect(attentionForRun('cancelled')).toBeUndefined()
    expect(attentionForRun('waiting_approval')).toBe('approval')
    expect(attentionForRun('running', true)).toBe('approval')
    expect(attentionForRun('waiting_user')).toBe('input')
    expect(attentionForRun('paused')).toBe('paused')
    expect(attentionForRun('failed')).toBe('failed')
  })

  it('classifies namespaced MCP calls before generic tool patterns', () => {
    expect(classifyToolActivity(tool('mcp', 'github/create_issue', 1))).toBe('mcp')
    expect(classifyToolActivity(tool('chrome', 'chrome_navigate', 1))).toBe('web')
    expect(classifyToolActivity(tool('plan', 'task_step_update', 1))).toBe('plan')
  })

  it('treats unavailable web sources as warnings without hiding real failures', () => {
    const sourceFailure = tool('web-failed', 'web_fetch', 1, 'failed')
    expect(isSourceWarning(sourceFailure)).toBe(true)
    expect(isSourceWarning(tool('write-failed', 'file_write', 2, 'failed'))).toBe(false)

    const turns = buildWorkTurns(detail({
      status: 'completed',
      events: [message('user-1', 'user', '调研', 1), message('assistant-1', 'agent', '已整理', 4)],
      toolCalls: [sourceFailure, tool('web-ok', 'web_fetch', 2, 'succeeded')],
    }))
    expect(turns[0]?.activity).toMatchObject([
      { kind: 'web', state: 'warning', summary: '已处理 2 项网页操作，部分来源不可用' },
    ])
  })
})
