import { useEffect, useState } from 'react'
import { bridge, errorMessage } from '../../bridge'
import { BrandMark, Icon } from '../../icons'
import type { ModelProfileItem, RunAccessMode, WorkspaceItem } from '../../types'
import { SubmitForm } from '../../ui'

export interface WelcomeComposerProps {
  workspace: WorkspaceItem | undefined
  models: ModelProfileItem[]
  defaultMode: 'plan' | 'execute'
  onSubmit: (prompt: string, mode: 'plan' | 'execute', accessMode: RunAccessMode, modelId?: string, attachmentIds?: string[]) => void
  onOpenSettings: () => void
}

const SUGGESTIONS = [
  { icon: 'folder' as const, text: '整理当前工作区并告诉我项目状态' },
  { icon: 'terminal' as const, text: '检查项目并运行最相关的验证' },
  { icon: 'globe' as const, text: '通过 Chrome 调研资料并整理来源' },
]

export function WelcomeComposer({
  workspace,
  models,
  defaultMode,
  onSubmit,
  onOpenSettings,
}: WelcomeComposerProps) {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'plan' | 'execute'>(defaultMode)
  const [accessMode, setAccessMode] = useState<RunAccessMode>('approval')
  const [modelId, setModelId] = useState(models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? '')
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [attachmentError, setAttachmentError] = useState<string>()

  useEffect(() => {
    if (!models.some((model) => model.id === modelId)) {
      setModelId(models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? '')
    }
  }, [modelId, models])

  return (
    <div className="welcome-view">
      <div className="welcome-hero">
        <div className="hero-orb"><BrandMark size={31} /></div>
        <span className="welcome-kicker">安静的本地工作台</span>
        <h1>从这里开始一项工作</h1>
        <p>交代目标，WorkBuddy 会在本机读取资料、执行操作，并把结果和依据整理好。</p>
      </div>
      {!workspace && (
        <div className="inline-notice warning"><Icon name="warning" /><span>开始前需要选择一个工作区。</span><button type="button" onClick={onOpenSettings}>选择工作区</button></div>
      )}
      {models.length === 0 && (
        <div className="inline-notice warning"><Icon name="key" /><span>还没有可用的模型配置。</span><button type="button" onClick={onOpenSettings}>添加模型</button></div>
      )}
      <SubmitForm className="hero-composer" onSubmit={() => {
        if (prompt.trim()) onSubmit(prompt.trim(), mode, accessMode, modelId || undefined, attachments.map((attachment) => attachment.id))
      }}>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想完成的工作…" rows={4} />
        {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <span key={attachment.id}><Icon name="file" size={13} />{attachment.name}<button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}>×</button></span>)}</div>}
        {attachmentError && <small className="composer-error">{attachmentError}</small>}
        <div className="composer-toolbar">
          <div className="composer-options">
            <select
              className="access-mode-select"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value as RunAccessMode)}
              aria-label="文件访问权限"
              title="完全访问允许读取和修改整个磁盘；删除、发送等高风险操作仍需确认"
            >
              <option value="approval">请求批准</option>
              <option value="full_disk">完全访问</option>
            </select>
            <button type="button" className="attachment-button" onClick={async () => {
              try {
                setAttachmentError(undefined)
                const imported = await bridge.importAttachments()
                setAttachments((items) => [
                  ...items,
                  ...imported
                    .filter((next) => !items.some((item) => item.id === next.id))
                    .map((item) => ({ id: item.id, name: item.name })),
                ])
              } catch (error) {
                setAttachmentError(errorMessage(error))
              }
            }}><Icon name="plus" size={14} />添加文件</button>
            <select value={mode} onChange={(event) => setMode(event.target.value as 'plan' | 'execute')} aria-label="执行模式">
              <option value="execute">直接处理</option>
              <option value="plan">先整理计划</option>
            </select>
            <select value={modelId} onChange={(event) => setModelId(event.target.value)} aria-label="模型">
              {models.length === 0 && <option value="">未配置模型</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.modelId}</option>)}
            </select>
          </div>
          <button className="send-button" type="submit" disabled={!prompt.trim() || !workspace || models.length === 0} aria-label="开始工作">
            <Icon name="arrowRight" size={18} />
          </button>
        </div>
      </SubmitForm>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion.text} type="button" onClick={() => setPrompt(suggestion.text)}>
            <Icon name={suggestion.icon} />
            <span>{suggestion.text}</span>
            <Icon name="arrowRight" size={15} />
          </button>
        ))}
      </div>
      <div className="local-trust"><Icon name="lock" size={14} /> 数据与操作留在本机 · 需要你决定时才会打断</div>
    </div>
  )
}
