import { BrandMark, Icon, type IconName } from '../../icons'
import type { ViewKey, WorkbenchSnapshot } from '../../types'
import { IconButton, StatusBadge } from '../../ui'

const NAV_ITEMS: Array<{ id: ViewKey; label: string; icon: IconName }> = [
  { id: 'tasks', label: '工作', icon: 'tasks' },
  { id: 'automations', label: '自动化', icon: 'clock' },
]

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export interface ShellSidebarProps {
  view: ViewKey
  onView: (view: ViewKey) => void
  snapshot: WorkbenchSnapshot
  selectedWorkspaceId: string | undefined
  onWorkspace: (id: string) => void
  selectedRunId: string | undefined
  onRun: (id: string) => void
  onNewTask: () => void
  search: string
  onSearch: (value: string) => void
  refreshing: boolean
  onRefresh: () => void
  onHide: () => void
}

export function ShellSidebar({
  view,
  onView,
  snapshot,
  selectedWorkspaceId,
  onWorkspace,
  selectedRunId,
  onRun,
  onNewTask,
  search,
  onSearch,
  refreshing,
  onRefresh,
  onHide,
}: ShellSidebarProps) {
  const runs = snapshot.runs.filter((run) => {
    const inWorkspace = !selectedWorkspaceId || run.workspaceId === selectedWorkspaceId
    const matches = !search || run.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    return inWorkspace && matches
  })

  return (
    <aside className="sidebar">
      <div className="titlebar-drag sidebar-titlebar" aria-hidden="true" />
      <div className="brand-row">
        <div className="brand-mark"><BrandMark size={20} /></div>
        <div className="brand-copy"><strong>On My WorkBuddy</strong><span>本地工作助手</span></div>
        <IconButton icon="panelRight" label="隐藏侧栏" onClick={onHide} />
      </div>

      <div className="workspace-select-wrap">
        <Icon name="folder" size={16} />
        <select
          value={selectedWorkspaceId ?? ''}
          onChange={(event) => onWorkspace(event.target.value)}
          aria-label="当前工作区"
        >
          {snapshot.workspaces.length === 0 && <option value="">尚未添加工作区</option>}
          {snapshot.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
        <Icon name="chevronDown" size={14} />
      </div>

      <button className="new-task-button" type="button" onClick={onNewTask}>
        <Icon name="plus" size={17} />
        新工作
        <kbd>⌘ N</kbd>
      </button>

      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button key={item.id} type="button" className={view === item.id ? 'is-active' : ''} onClick={() => onView(item.id)}>
            <Icon name={item.icon} size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />
      <div className="task-list-header">
        <span>最近</span>
        <div>
          <IconButton icon="refresh" label="刷新工作台" className={refreshing ? 'is-spinning' : ''} onClick={onRefresh} />
          <IconButton icon="search" label="搜索工作" onClick={() => document.getElementById('run-search')?.focus()} />
        </div>
      </div>
      <div className="run-search-wrap">
        <Icon name="search" size={14} />
        <input id="run-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索" />
        {search && <button type="button" aria-label="清除搜索" onClick={() => onSearch('')}><Icon name="x" size={13} /></button>}
      </div>
      <div className="task-list">
        {runs.map((run) => (
          <button
            type="button"
            key={run.id}
            className={`task-list-item ${view === 'tasks' && selectedRunId === run.id ? 'is-active' : ''}`}
            onClick={() => { onRun(run.id); onView('tasks') }}
          >
            <StatusBadge status={run.status} compact />
            <span className="task-list-copy"><strong>{run.title}</strong><small>{formatDate(run.updatedAt ?? run.createdAt)}</small></span>
            {run.status === 'waiting_approval' && <span className="attention-dot" />}
          </button>
        ))}
        {runs.length === 0 && <div className="sidebar-empty">{search ? '没有匹配的工作' : '最近工作会显示在这里'}</div>}
      </div>

      <div className="sidebar-footer">
        <button type="button" className={['memory', 'mcp', 'skills'].includes(view) ? 'is-active' : ''} onClick={() => onView('memory')}>
          <Icon name="layers" size={17} /><span>资料库</span>
          {snapshot.memory.some((memory) => memory.status === 'proposed') && <em className="nav-count">{snapshot.memory.filter((memory) => memory.status === 'proposed').length}</em>}
        </button>
        <button type="button" className={view === 'settings' ? 'is-active' : ''} onClick={() => onView('settings')}>
          <Icon name="settings" size={17} /><span>设置</span>
        </button>
      </div>
    </aside>
  )
}
