import { useState } from 'react'
import { bridge, resultId } from '../../bridge'
import { Icon } from '../../icons'
import type { JsonRecord, McpServerItem, MemoryItem, SkillItem, WorkbenchSnapshot } from '../../types'
import { EmptyState, Field, IconButton, Modal, PageHeader, Spinner, SubmitForm, Toggle } from '../../ui'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

export type LibraryView = 'memory' | 'mcp' | 'skills'

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

export function LibraryPage({ view, snapshot, workspaceId, perform, onView }: { view: LibraryView; snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform; onView: (view: LibraryView) => void }) {
  return (
    <section className="library-shell">
      <header className="library-toolbar titlebar-drag">
        <div><span>资料库</span><strong>长期信息与可用能力</strong></div>
        <nav className="library-nav no-drag" aria-label="资料库分类">
          <button type="button" className={view === 'memory' ? 'is-active' : ''} onClick={() => onView('memory')}><Icon name="memory" size={16} />记忆</button>
          <button type="button" className={view === 'mcp' ? 'is-active' : ''} onClick={() => onView('mcp')}><Icon name="plug" size={16} />连接</button>
          <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => onView('skills')}><Icon name="skill" size={16} />技能</button>
        </nav>
      </header>
      <div className="library-content">
        {view === 'memory' && <MemoryPage snapshot={snapshot} workspaceId={workspaceId} perform={perform} />}
        {view === 'mcp' && <McpPage snapshot={snapshot} perform={perform} />}
        {view === 'skills' && <SkillsPage snapshot={snapshot} perform={perform} />}
      </div>
    </section>
  )
}

function MemoryPage({ snapshot, workspaceId, perform }: { snapshot: WorkbenchSnapshot; workspaceId: string | undefined; perform: Perform }) {
  const [filter, setFilter] = useState<'all' | 'proposed' | 'confirmed' | 'disabled'>('all')
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'user' | 'workspace' | 'thread'>('user')
  const [kind, setKind] = useState('stable_fact')
  const visible = snapshot.memory.filter((item) => filter === 'all' || item.status === filter)
  const counts = {
    proposed: snapshot.memory.filter((item) => item.status === 'proposed').length,
    confirmed: snapshot.memory.filter((item) => item.status === 'confirmed').length,
    disabled: snapshot.memory.filter((item) => item.status === 'disabled').length,
  }
  const createMemory = async () => {
    if (!content.trim()) return
    const input: JsonRecord = {
      type: kind,
      scope,
      content: content.trim(),
      confidence: 1,
      source: { kind: 'user', reference: 'memory-manager' },
    }
    if (scope === 'workspace' && workspaceId) input.workspaceId = workspaceId
    const result = await perform(() => bridge.proposeMemory(input), '已创建记忆候选')
    if (result !== undefined) { setContent(''); setOpen(false) }
  }
  return (
    <main className="management-page">
      <PageHeader title="记忆" description="只有经过你确认的信息才会在相关工作中重新出现。" action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />添加记忆</button>} />
      <div className="segmented-filter">
        {([
          ['all', `全部 ${snapshot.memory.length}`], ['proposed', `待确认 ${counts.proposed}`], ['confirmed', `已确认 ${counts.confirmed}`], ['disabled', `已停用 ${counts.disabled}`],
        ] as const).map(([id, label]) => <button type="button" key={id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <div className="memory-grid">
        {visible.map((memory) => <MemoryCard key={memory.id} memory={memory} perform={perform} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="memory" title={filter === 'all' ? '还没有记忆' : '这里暂时为空'} description="WorkBuddy 可以在工作结束时提出候选；未经确认的内容不会影响以后。" action={<button type="button" className="button secondary" onClick={() => setOpen(true)}>添加第一条</button>} />}
      <Modal open={open} onClose={() => setOpen(false)} title="添加记忆候选" description="先作为候选保存，确认后才会在相关工作中使用。">
        <SubmitForm onSubmit={() => void createMemory()} className="modal-form">
          <Field label="内容"><textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：我偏好先看结论，再看实现细节。" autoFocus /></Field>
          <div className="field-row">
            <Field label="类型"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="stable_fact">稳定事实</option><option value="knowledge_background">知识背景</option><option value="behavior_signal">行为信号</option><option value="style_preference">表达偏好</option><option value="continuation">会话延续</option></select></Field>
            <Field label="作用范围"><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="user">所有工作区</option><option value="workspace" disabled={!workspaceId}>当前工作区</option><option value="thread">当前工作</option></select></Field>
          </div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setOpen(false)}>取消</button><button type="submit" className="button primary" disabled={!content.trim()}>保存候选</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function MemoryCard({ memory, perform }: { memory: MemoryItem; perform: Perform }) {
  const labels: Record<string, string> = { stable_fact: '稳定事实', knowledge_background: '知识背景', behavior_signal: '行为信号', style_preference: '表达偏好', continuation: '会话延续' }
  const scopeLabels: Record<string, string> = { user: '所有工作区', workspace: '当前工作区', thread: '当前工作' }
  return (
    <article className={`memory-card memory-${memory.status}`}>
      <div className="memory-card-top"><span className={`memory-state ${memory.status}`}>{memory.status === 'proposed' ? '待确认' : memory.status === 'confirmed' ? '已确认' : '已停用'}</span></div>
      <p>{memory.content}</p>
      <div className="memory-meta"><span><Icon name="layers" size={13} />{labels[memory.kind ?? ''] ?? memory.kind ?? '记忆'}</span><span><Icon name="globe" size={13} />{scopeLabels[memory.scope] ?? memory.scope}</span>{memory.confidence !== undefined && <span>{Math.round(memory.confidence * 100)}% 置信</span>}</div>
      {memory.source && <div className="memory-source">来源：{memory.source}</div>}
      <div className="card-actions">
        {memory.status === 'proposed' && <><button className="button primary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), '记忆已确认')}>确认使用</button><button className="button ghost small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), '候选已删除')}>删除</button></>}
        {memory.status === 'confirmed' && <button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'disable'), '记忆已停用')}>停用</button>}
        {memory.status === 'disabled' && <><button className="button secondary small" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'confirm'), '记忆已恢复')}>恢复</button><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.updateMemory(memory.id, 'remove'), '记忆已删除')}>永久删除</button></>}
      </div>
    </article>
  )
}

function McpPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<'none' | 'bearer' | 'headers' | 'oauth'>('none')
  const [secret, setSecret] = useState('')
  const save = async () => {
    const secretEntries = Object.fromEntries(secret.split('\n').map((line) => {
      const separator = line.includes('=') ? line.indexOf('=') : line.indexOf(':')
      return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : ['', '']
    }).filter(([key, value]) => key && value))
    const secrets: JsonRecord = transport === 'stdio'
      ? secretEntries
      : auth === 'bearer'
        ? (secret ? { bearer: secret } : {})
        : auth === 'headers'
          ? secretEntries
          : {}
    const input: JsonRecord = {
      name: name.trim(),
      enabled: true,
      toolNamespace: namespace.trim(),
      transport: transport === 'stdio'
        ? { type: 'stdio', command: command.trim(), args: args.split(/\s+/).filter(Boolean), envKeys: Object.keys(secrets) }
        : { type: 'streamable_http', url: url.trim(), auth, secretConfigured: Boolean(secret) },
    }
    if (Object.keys(secrets).length) input.secrets = secrets
    const result = await perform(() => bridge.saveMcp(input), 'MCP Server 已保存')
    if (result !== undefined) {
      setOpen(false); setName(''); setNamespace(''); setCommand(''); setUrl(''); setSecret('')
      const id = resultId(result)
      if (auth === 'oauth' && id) await perform(() => bridge.authorizeMcp(id), '已在浏览器打开 OAuth 授权')
    }
  }
  return (
    <main className="management-page">
      <PageHeader title="连接" description="连接你选择的本地服务或外部工具；详细协议设置保留在高级选项中。" action={<button className="button primary" type="button" onClick={() => setOpen(true)}><Icon name="plus" />添加连接</button>} />
      <div className="security-banner"><Icon name="shield" /><div><strong>能力按需使用</strong><p>每个连接彼此隔离，详细能力说明只在当前工作需要时加载。</p></div></div>
      <div className="connection-grid">
        {snapshot.mcpServers.map((server) => <McpCard key={server.id} server={server} perform={perform} />)}
      </div>
      {snapshot.mcpServers.length === 0 && <EmptyState icon="plug" title="还没有连接" description="你可以添加本地命令，或连接支持 MCP 的服务。" action={<button className="button secondary" type="button" onClick={() => setOpen(true)}>添加连接</button>} />}
      <Modal open={open} onClose={() => setOpen(false)} title="添加 MCP Server" description="连接信息会留在本机，Secret 使用系统加密存储。" wide>
        <SubmitForm className="modal-form" onSubmit={() => void save()}>
          <div className="field-row"><Field label="名称"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 GitHub MCP" autoFocus /></Field><Field label="工具命名空间" hint="字母开头，可用数字、_、-．"><input value={namespace} onChange={(event) => setNamespace(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} placeholder="github" /></Field></div>
          <Field label="传输方式"><div className="radio-cards"><button type="button" className={transport === 'stdio' ? 'is-active' : ''} onClick={() => { setTransport('stdio'); setSecret('') }}><Icon name="terminal" /><span><strong>stdio</strong><small>启动本地进程</small></span></button><button type="button" className={transport === 'http' ? 'is-active' : ''} onClick={() => { setTransport('http'); setSecret('') }}><Icon name="globe" /><span><strong>Streamable HTTP</strong><small>连接远程 Server</small></span></button></div></Field>
          {transport === 'stdio' ? <><Field label="命令"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></Field><Field label="参数" hint="按空格分隔；执行前会展示完整命令。"><input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @example/mcp-server" /></Field><Field label="Secret 环境变量" hint="可选；每行 KEY=value，仅这些名称会注入 Server。"><textarea value={secret} onChange={(event) => setSecret(event.target.value)} rows={3} placeholder="API_TOKEN=…" /></Field></> : <><Field label="Server URL"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></Field><div className="field-row"><Field label="认证"><select value={auth} onChange={(event) => { setAuth(event.target.value as typeof auth); setSecret('') }}><option value="none">无认证</option><option value="bearer">Bearer Token</option><option value="headers">自定义 Header</option><option value="oauth">OAuth</option></select></Field>{auth === 'bearer' && <Field label="Bearer Token"><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="不会回显" /></Field>}{auth === 'headers' && <Field label="Secret Header" hint="每行 Header-Name=value"><textarea value={secret} onChange={(event) => setSecret(event.target.value)} rows={3} placeholder="X-API-Key=…" /></Field>}</div></>}
          <div className="inline-notice"><Icon name="info" /><span>本地 stdio Server 以当前 macOS 用户身份运行，并非恶意代码沙箱。</span></div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setOpen(false)}>取消</button><button type="submit" className="button primary" disabled={!name.trim() || !namespace.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}>保存连接</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function McpCard({ server, perform }: { server: McpServerItem; perform: Perform }) {
  const [testing, setTesting] = useState(false)
  return (
    <article className="connection-card">
      <div className="connection-card-head"><div className="connection-logo"><Icon name={server.transport === 'stdio' ? 'terminal' : 'globe'} /></div><div><h3>{server.name}</h3><span>{server.transport === 'stdio' ? 'stdio · 本地' : 'Streamable HTTP'}</span></div><span className={`health-pill ${server.status === 'connected' ? 'healthy' : server.status === 'error' ? 'unhealthy' : ''}`}><i />{server.status === 'connected' ? '健康' : server.status === 'error' ? '异常' : '未检查'}</span></div>
      <code>{server.command ?? server.url ?? '未配置端点'}</code>
      <div className="connection-stats"><span><strong>{server.toolCount ?? '—'}</strong><small>工具</small></span><span><strong>{server.transport === 'stdio' ? '本机' : '远程'}</strong><small>运行位置</small></span></div>
      <div className="card-actions">{server.auth === 'oauth' && <button className="button secondary small" type="button" onClick={() => void perform(() => bridge.authorizeMcp(server.id), '已在浏览器打开 OAuth 授权')}><Icon name="key" size={14} />{server.secretConfigured ? '重新授权' : '授权'}</button>}<button className="button secondary small" type="button" disabled={testing} onClick={async () => { setTesting(true); await perform(async () => { const result = await bridge.testMcp({ id: server.id }); const payload = result && typeof result === 'object' ? result as JsonRecord : {}; if (!payload.ok) { const issue = payload.error && typeof payload.error === 'object' ? payload.error as JsonRecord : {}; throw new Error(String(issue.message ?? 'MCP 连接测试失败')) } return result }, '连接测试通过', { refresh: true }); setTesting(false) }}>{testing ? <Spinner size={13} /> : <Icon name="activity" size={14} />}测试</button><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.removeMcp(server.id), '连接已移除')}>移除</button></div>
    </article>
  )
}

function SkillsPage({ snapshot, perform }: { snapshot: WorkbenchSnapshot; perform: Perform }) {
  const [query, setQuery] = useState('')
  const visible = snapshot.skills.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <main className="management-page">
      <PageHeader title="技能" description="保存可复用的工作方法，需要时才加载；脚本仍然遵守相同权限。" action={<button type="button" className="button primary" onClick={() => void perform(() => bridge.importSkill(), '技能已导入')}><Icon name="plus" />从文件夹导入</button>} />
      <div className="page-tools"><div className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills" /></div><span>{snapshot.skills.filter((skill) => skill.enabled).length} 个已启用</span></div>
      <div className="skill-list">
        {visible.map((skill) => <SkillRow key={skill.id} skill={skill} perform={perform} />)}
      </div>
      {visible.length === 0 && <EmptyState icon="skill" title={query ? '没有匹配的技能' : '还没有技能'} description="选择包含 SKILL.md 的本地文件夹即可导入。" />}
    </main>
  )
}

function SkillRow({ skill, perform }: { skill: SkillItem; perform: Perform }) {
  return (
    <article className="skill-row">
      <div className="skill-symbol"><Icon name="skill" /></div>
      <div className="skill-main"><div><h3>{skill.name}</h3><span>v{skill.version ?? '—'}</span></div><p>{skill.description}</p><div className="permission-chips">{skill.permissions?.map((permission) => <span key={permission}>{permission}</span>)}{(!skill.permissions || skill.permissions.length === 0) && <span>无额外权限声明</span>}</div><small>{skill.source ? shortPath(skill.source) : '本地 Skill'}</small></div>
      <div className="skill-controls"><Toggle checked={skill.enabled} label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`} onChange={(enabled) => void perform(() => bridge.toggleSkill(skill.id, enabled), enabled ? 'Skill 已启用' : 'Skill 已停用')} /><IconButton icon="trash" label="移除 Skill" onClick={() => void perform(() => bridge.removeSkill(skill.id), 'Skill 已移除')} /></div>
    </article>
  )
}
