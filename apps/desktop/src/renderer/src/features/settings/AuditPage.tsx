import { useEffect, useState } from 'react'
import { bridge, errorMessage } from '../../bridge'
import { Icon, type IconName } from '../../icons'
import type { JsonRecord, WorkbenchSnapshot } from '../../types'
import { EmptyState, PageHeader, Spinner } from '../../ui'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

function formatDate(value?: string, includeDate = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date)
}

export function AuditPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  const [entries, setEntries] = useState<JsonRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    bridge.listAudit().then((value) => {
      if (cancelled) return
      const source = value && typeof value === 'object' ? value as JsonRecord : {}
      const items = Array.isArray(value) ? value : Array.isArray(source.items) ? source.items : []
      setEntries(items.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object')))
      setLoadError(undefined)
    }).catch((cause) => {
      if (!cancelled) setLoadError(errorMessage(cause))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  const successful = snapshot.runs.filter((run) => run.status === 'completed').length
  const waiting = snapshot.runs.filter((run) => run.status === 'waiting_approval').length
  const failures = snapshot.runs.filter((run) => run.status === 'failed').length
  return (
    <main className="management-page">
      <PageHeader title="隐私与记录" description="查看本机保存的操作、确认、错误和检查记录；不会保存隐藏思维链或原始密钥。" action={<button className="button primary" type="button" onClick={() => void perform(async () => { const result = await bridge.exportAudit(); if (result === null) return 'cancelled'; return result }, undefined, { refresh: false })}><Icon name="download" />导出诊断包</button>} />
      <div className="audit-metrics"><Metric icon="tasks" label="本地工作" value={snapshot.runs.length} tone="blue" /><Metric icon="check" label="已有结果" value={successful} tone="green" /><Metric icon="shield" label="需要确认" value={waiting} tone="amber" /><Metric icon="warning" label="未完成" value={failures} tone="red" /></div>
      <div className="security-banner"><Icon name="lock" /><div><strong>本地、脱敏、可追溯</strong><p>详细记录受保留天数和容量双重限制；工作、记忆与最终输出会保留到你删除。</p></div></div>
      <section className="audit-table-card">
        <div className="table-heading"><div><h2>最近活动</h2><span>最多显示 100 条本地记录</span></div><span className="local-only"><i />仅本机</span></div>
        {loading ? <div className="table-loading"><Spinner />读取审计日志…</div> : loadError ? <div className="inline-notice error"><Icon name="warning" /><span>{loadError}</span></div> : entries.length ? (
          <div className="audit-table" role="table">
            <div className="audit-table-row table-header" role="row"><span>时间</span><span>操作</span><span>目标</span><span>结果</span><span>摘要</span></div>
            {entries.map((entry, index) => {
              const outcome = String(entry.outcome ?? 'started')
              return <div className="audit-table-row" role="row" key={String(entry.id ?? index)}><span>{formatDate(typeof entry.createdAt === 'string' ? entry.createdAt : undefined, true)}</span><span className="mono">{String(entry.action ?? '—')}</span><span>{String(entry.target ?? '—')}</span><span><em className={`outcome outcome-${outcome}`}>{auditOutcomeLabel(outcome)}</em></span><span title={String(entry.summary ?? '')}>{String(entry.summary ?? '—')}</span></div>
            })}
          </div>
        ) : <EmptyState compact icon="activity" title="还没有活动记录" description="执行操作、确认和检查结果会显示在这里。" />}
      </section>
      <div className="audit-footnote"><Icon name="info" size={14} />模型密钥和文件操作由本机权限层处理；界面无法绕过授权直接访问。</div>
    </main>
  )
}

function auditOutcomeLabel(value: string) {
  const labels: Record<string, string> = { started: '已开始', allowed: '已允许', blocked: '已阻止', approved: '已批准', rejected: '已拒绝', succeeded: '成功', failed: '失败' }
  return labels[value] ?? value
}

function Metric({ icon, label, value, tone }: { icon: IconName; label: string; value: number; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><span><Icon name={icon} /></span><div><strong>{value}</strong><small>{label}</small></div></div>
}
