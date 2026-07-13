import { useEffect, useState, type ReactNode } from 'react'
import { bridge, resultId } from '../../bridge'
import { Icon, type IconName } from '../../icons'
import type {
  JsonRecord,
  ModelProfileItem,
  ModelProvider,
  PersistentGrantItem,
  WorkbenchSnapshot,
  WorkspaceItem,
} from '../../types'
import {
  EmptyState,
  Field,
  IconButton,
  Modal,
  PageHeader,
  Spinner,
  SubmitForm,
  Toggle,
} from '../../ui'
import { MODEL_PROVIDER_META } from './model-meta'

type Perform = <T>(
  action: () => Promise<T>,
  successTitle?: string,
  options?: { refresh?: boolean; refreshRun?: boolean },
) => Promise<T | undefined>

function formatBytes(value?: number) {
  if (value === undefined) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsPage({ snapshot, selectedWorkspaceId, perform, onWorkspaceAdded, onWorkspaceSelected, onOpenAudit }: { snapshot: WorkbenchSnapshot; selectedWorkspaceId: string | undefined; perform: Perform; onWorkspaceAdded: () => void; onWorkspaceSelected: (id: string) => void; onOpenAudit: () => void }) {
  const [modelOpen, setModelOpen] = useState(false)
  const [provider, setProvider] = useState<ModelProvider>('openai')
  const [name, setName] = useState('OpenAI')
  const [modelId, setModelId] = useState('gpt-5.2')
  const [apiKey, setApiKey] = useState('')
  const [modelCatalog, setModelCatalog] = useState<JsonRecord[]>([])
  const [testingId, setTestingId] = useState<string>()
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string }>()
  const [secretProfile, setSecretProfile] = useState<ModelProfileItem>()
  const [replacementKey, setReplacementKey] = useState('')
  const [rulesWorkspace, setRulesWorkspace] = useState<WorkspaceItem>()
  const [rulesText, setRulesText] = useState('')
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantTool, setGrantTool] = useState<'file.write' | 'file.edit'>('file.write')
  const [grantPath, setGrantPath] = useState('')
  const [packagePreview, setPackagePreview] = useState<JsonRecord>()
  const settings = snapshot.settings
  const defaultLimits = (settings.defaultRunLimits && typeof settings.defaultRunLimits === 'object' ? settings.defaultRunLimits : {}) as JsonRecord

  useEffect(() => {
    let cancelled = false
    bridge.listModelCatalog(provider).then((value) => {
      if (cancelled) return
      setModelCatalog(Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object')) : [])
    }).catch(() => { if (!cancelled) setModelCatalog([]) })
    return () => { cancelled = true }
  }, [provider])

  const addWorkspace = async () => {
    const path = await perform(() => bridge.chooseWorkspace(), undefined, { refresh: false })
    if (typeof path !== 'string' || !path) return
    const result = await perform(() => bridge.addWorkspace(path), '工作区已添加')
    if (result !== undefined) onWorkspaceAdded()
  }
  const selectProvider = (nextProvider: ModelProvider) => {
    const metadata = MODEL_PROVIDER_META[nextProvider]
    setApiKey('')
    setProvider(nextProvider)
    setName(metadata.name)
    setModelId(metadata.defaultModelId)
  }
  const closeModelModal = () => {
    setApiKey('')
    setModelOpen(false)
  }
  const closeSecretModal = () => {
    setReplacementKey('')
    setSecretProfile(undefined)
  }
  const saveModel = async () => {
    const submittedKey = apiKey.trim()
    setApiKey('')
    const profile = await perform(() => bridge.saveModel({ name: name.trim(), provider, modelId: modelId.trim() }), undefined, { refresh: false })
    const id = resultId(profile)
    if (!id) return
    if (submittedKey) {
      const saved = await perform(async () => {
        await bridge.setModelSecret({ profileId: id, apiKey: submittedKey })
        return true
      }, undefined, { refresh: false })
      if (!saved) return
    }
    if (snapshot.models.length === 0) await perform(() => bridge.setDefaultModel(id), undefined, { refresh: false })
    await perform(async () => profile, '模型配置已保存')
    setModelOpen(false)
  }
  const testModel = async (id: string) => {
    setTestingId(id)
    const result = await perform(() => bridge.testModel({ profileId: id }), undefined, { refresh: false }) as JsonRecord | undefined
    if (result) {
      const ok = Boolean(result.ok)
      const latency = typeof result.latencyMs === 'number' ? ` · ${result.latencyMs} ms` : ''
      const publicError = result.error && typeof result.error === 'object' ? result.error as JsonRecord : {}
      setTestResult({ ok, message: ok ? `连接成功${latency}` : String(publicError.message ?? '连接测试失败') })
    }
    setTestingId(undefined)
  }
  const savePersistentGrant = async () => {
    if (!selectedWorkspaceId) return
    const result = await perform(() => bridge.createPersistentGrant({ workspaceId: selectedWorkspaceId, toolName: grantTool, path: grantPath.trim() }), '永久授权已创建')
    if (result !== undefined) { setGrantOpen(false); setGrantPath('') }
  }
  const chooseCapabilityPackage = async () => {
    const result = await perform(() => bridge.chooseCapabilityPackage(), undefined, { refresh: false })
    if (result && typeof result === 'object') setPackagePreview(result as JsonRecord)
  }
  const installCapabilityPackage = async () => {
    const selectionId = typeof packagePreview?.selectionId === 'string' ? packagePreview.selectionId : ''
    if (!selectionId) return
    const result = await perform(() => bridge.installCapabilityPackage(selectionId, selectedWorkspaceId), '能力包已安装')
    if (result !== undefined) setPackagePreview(undefined)
  }
  return (
    <main className="management-page settings-page">
      <PageHeader title="设置" description="管理模型、工作区、浏览器、权限和本地数据。" />

      <SettingsSection icon="layers" title="模型" description="正在进行的工作固定使用创建时的模型；默认值只影响新工作。" action={<button className="button secondary small" type="button" onClick={() => setModelOpen(true)}><Icon name="plus" />添加配置</button>}>
        {snapshot.models.length ? <><div className="model-list">{snapshot.models.map((model) => <div key={model.id} className="model-row"><div className={`provider-logo ${model.provider}`} aria-label={MODEL_PROVIDER_META[model.provider].name}><span>{MODEL_PROVIDER_META[model.provider].mark}</span></div><div><strong>{model.name}</strong><span>{model.modelId} · {model.hasSecret ? '密钥已配置' : '缺少密钥'}</span></div>{model.isDefault && <span className="default-pill">默认</span>}<div className="model-actions">{!model.isDefault && <button type="button" onClick={() => void perform(() => bridge.setModelDefaults(model.id, snapshot.models.find((item) => item.isSubagentDefault)?.id), '默认模型已更新')}>设为默认</button>}<button type="button" onClick={() => { setSecretProfile(model); setReplacementKey('') }}>更新 Key</button><button type="button" onClick={() => void testModel(model.id)} disabled={testingId === model.id}>{testingId === model.id ? <Spinner size={12} /> : '测试'}</button><IconButton icon="trash" label="删除模型配置" onClick={() => void perform(() => bridge.removeModel(model.id), '模型配置已删除')} /></div></div>)}</div><div className="model-defaults"><SettingRow title="工作默认模型" detail="开始新工作时默认选择的模型配置。"><select value={snapshot.models.find((item) => item.isDefault)?.id ?? snapshot.models[0]?.id} onChange={(event) => void perform(() => bridge.setModelDefaults(event.target.value, snapshot.models.find((item) => item.isSubagentDefault)?.id), '工作默认模型已更新')}>{snapshot.models.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}</select></SettingRow><SettingRow title="并行助手默认模型" detail="没有单独指定时，用于并行处理。"><select value={snapshot.models.find((item) => item.isSubagentDefault)?.id ?? snapshot.models.find((item) => item.isDefault)?.id ?? snapshot.models[0]?.id} onChange={(event) => { const primary = snapshot.models.find((item) => item.isDefault) ?? snapshot.models[0]; if (primary) void perform(() => bridge.setModelDefaults(primary.id, event.target.value), '并行助手默认模型已更新') }}>{snapshot.models.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}</select></SettingRow></div>{testResult && <div className={`inline-notice ${testResult.ok ? '' : 'error'}`}><Icon name={testResult.ok ? 'check' : 'warning'} /><span>{testResult.message}</span><button type="button" onClick={() => setTestResult(undefined)}>关闭</button></div>}</> : <EmptyState compact icon="key" title="尚未配置模型" description="添加 OpenAI、Anthropic 或 Kimi / Moonshot API Key 后才能开始工作。" />}
      </SettingsSection>

      <SettingsSection icon="folder" title="工作区" description="WorkBuddy 只能通过文件工具访问你明确授权的根目录。" action={<button type="button" className="button secondary small" onClick={() => void addWorkspace()}><Icon name="plus" />添加工作区</button>}>
        <div className="workspace-settings-list">{snapshot.workspaces.map((workspace) => <div key={workspace.id} className={workspace.id === selectedWorkspaceId ? 'is-selected' : ''}><span className="folder-symbol"><Icon name="folder" /></span><span><strong>{workspace.name}</strong><small>{workspace.path}</small></span>{workspace.id === selectedWorkspaceId ? <span className="default-pill">当前</span> : <button type="button" className="text-button" onClick={() => onWorkspaceSelected(workspace.id)}>切换</button>}<IconButton icon="edit" label="编辑工作区规则" onClick={() => { setRulesWorkspace(workspace); setRulesText(typeof workspace.rules === 'string' ? workspace.rules : '') }} /><IconButton icon="trash" label="移除工作区授权" onClick={() => void perform(() => bridge.removeWorkspace(workspace.id), '工作区授权已移除')} /></div>)}</div>
      </SettingsSection>

      <SettingsSection icon="skill" title="本地能力包" description="组合 Skills、MCP 配置、规则和模板；安装前会显示命令、环境和权限，不允许 JavaScript 注入。" action={<button type="button" className="button secondary small" onClick={() => void chooseCapabilityPackage()}><Icon name="plus" />选择能力包</button>}>
        {snapshot.capabilityPackages.length > 0 ? <div className="persistent-grant-list">{snapshot.capabilityPackages.map((item) => <div key={item.id}><span className="folder-symbol"><Icon name="skill" /></span><span><strong>{item.name} · v{item.version}</strong><small>{item.skillIds.length} Skills · {item.mcpServerIds.length} MCP · {item.ruleSources.length} Rules · {item.templatePaths.length} Templates</small></span><span className="default-pill">本地安装</span></div>)}</div> : <EmptyState compact icon="skill" title="尚未安装能力包" description="能力包只从你手动选择的本地目录导入，不连接在线市场。" />}
      </SettingsSection>

      <SettingsSection icon="sun" title="外观与语言" description="界面遵循 macOS；回答语言由当前请求决定。">
        <SettingRow title="主题" detail="跟随系统可自动切换浅色与深色。"><select value={String(settings.theme ?? 'system')} onChange={(event) => void perform(() => bridge.updateSettings({ theme: event.target.value }), '主题已更新')}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></SettingRow>
        <SettingRow title="界面语言" detail="当前版本提供简体中文；回答会跟随你使用的语言。"><select value="zh-CN" aria-label="界面语言" disabled><option value="zh-CN">简体中文</option></select></SettingRow>
        <SettingRow title="开机启动" detail="默认关闭；显式退出应用会停止自动化。"><Toggle checked={Boolean(settings.launchAtLogin)} label="开机启动" onChange={(checked) => void perform(() => bridge.updateSettings({ launchAtLogin: checked }), checked ? '已开启开机启动' : '已关闭开机启动')} /></SettingRow>
      </SettingsSection>

      <SettingsSection icon="memory" title="记忆" description="未经确认的候选不会影响以后的工作。">
        <SettingRow title="启用记忆建议" detail="工作收尾时允许 WorkBuddy 提出带来源的候选记忆。"><Toggle checked={settings.memoryEnabled !== false} label="启用记忆" onChange={(checked) => void perform(() => bridge.updateSettings({ memoryEnabled: checked }), checked ? '记忆建议已启用' : '记忆建议已关闭')} /></SettingRow>
      </SettingsSection>

      <SettingsSection icon="lock" title="工作权限" description="文件访问范围按工作选择，不设置覆盖所有工作的全局自动化级别。">
        <SettingRow title="在输入框中选择" detail="新工作和追问时，在“添加文件”左侧选择“请求批准”或“完全访问”。"><span className="default-pill">按工作保存</span></SettingRow>
        <div className="inline-notice"><Icon name="shield" /><span>完全访问会把当前工作的文件授权根扩展到整个磁盘；删除、发送、发布、搜索查询、网络命令和其他外部副作用仍需确认。</span></div>
      </SettingsSection>

      <SettingsSection icon="shield" title="默认处理方式" description="只影响新工作；先整理计划时，宿主只提供只读能力。">
        <SettingRow title="新工作默认方式" detail="开始每项工作时仍可临时切换。"><select value={String(settings.defaultExecutionMode ?? 'execute')} onChange={(event) => void perform(() => bridge.updateSettings({ defaultExecutionMode: event.target.value }), '默认处理方式已更新')}><option value="execute">直接处理</option><option value="plan">先整理计划（只读）</option></select></SettingRow>
      </SettingsSection>

      <SettingsSection icon="lock" title="永久授权" description="只能在设置中创建。首版仅允许对当前工作区中的一个精确路径放行可逆文件写入；Shell、发送和不可逆动作不支持永久授权。" action={<button className="button secondary small" type="button" onClick={() => setGrantOpen(true)} disabled={!selectedWorkspaceId}><Icon name="plus" />添加授权</button>}>
        {snapshot.persistentGrants.length > 0 ? <div className="persistent-grant-list">{snapshot.persistentGrants.map((grant: PersistentGrantItem) => <div key={grant.id}><span className="folder-symbol"><Icon name="file" /></span><span><strong>{grant.toolName === 'file.edit' ? '编辑文件' : '写入文件'} · {snapshot.workspaces.find((workspace) => workspace.id === grant.workspaceId)?.name ?? '未知工作区'}</strong><small className="mono">{grant.path}</small></span><span className="default-pill">工作区 + 精确路径</span><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.removePersistentGrant(grant.id), '永久授权已撤销')}>撤销</button></div>)}</div> : <EmptyState compact icon="lock" title="没有永久授权" description="工作中的单次允许不会自动升级为永久授权。" />}
      </SettingsSection>

      <SettingsSection icon="globe" title="浏览器连接" description="只有你通过扩展绑定的标签页和它新开的子标签可被当前工作访问。">
        <div className="chrome-settings"><div className="chrome-illustration"><Icon name="globe" size={24} /></div><div><strong>{snapshot.chrome.connected ? 'Chrome 已连接' : snapshot.chrome.extensionInstalled && snapshot.chrome.nativeHostInstalled ? '组件已安装，等待连接' : '浏览器尚未连接'}</strong><span>{snapshot.chrome.connected ? `${snapshot.chrome.grants.length} 个活跃标签页授权` : `扩展：${snapshot.chrome.extensionInstalled ? '已安装' : '未安装'} · 本地桥接：${snapshot.chrome.nativeHostInstalled ? '已安装' : '未安装'}`}</span></div><span className={`health-pill ${snapshot.chrome.connected ? 'healthy' : ''}`}><i />{snapshot.chrome.connected ? '在线' : '离线'}</span></div>
        {snapshot.chrome.grants.length > 0 && <div className="chrome-grant-list">{snapshot.chrome.grants.map((grant) => <div key={grant.id}><Icon name="globe" size={14} /><span><strong>{grant.title || `标签页 ${grant.tabId ?? ''}`}</strong><small>{grant.url ?? '已授权给当前工作'}</small></span><button className="button ghost small danger-text" type="button" onClick={() => void perform(() => bridge.revokeChromeGrant(grant.id), '标签页授权已撤销')}>撤销</button></div>)}</div>}
      </SettingsSection>

      <SettingsSection icon="shield" title="隐私与记录" description="操作、确认、错误和检查结果只保存在本机，不记录隐藏思维链或原始密钥。">
        <SettingRow title="本地活动记录" detail="查看最近操作，或导出经过脱敏的诊断包。"><button type="button" className="button secondary small" onClick={onOpenAudit}>查看活动记录</button></SettingRow>
      </SettingsSection>

      <SettingsSection icon="settings" title="高级运行限制" description="限制只影响新工作，正在进行的工作继续使用创建时的设置。">
        <div className="limit-grid">
          <LimitInput label="模型循环" value={Number(defaultLimits.maxModelTurns ?? settings.maxIterations ?? 60)} onSave={(value) => void perform(() => bridge.updateSettings({ defaultRunLimits: { ...defaultLimits, maxModelTurns: value } }), '限制已保存')} />
          <LimitInput label="最长分钟" value={Math.round(Number(defaultLimits.maxDurationMs ?? 7_200_000) / 60_000)} onSave={(value) => void perform(() => bridge.updateSettings({ defaultRunLimits: { ...defaultLimits, maxDurationMs: value * 60_000 } }), '限制已保存')} />
          <LimitInput label="并行助手" value={Number(defaultLimits.maxSubagents ?? settings.maxSubagents ?? 3)} onSave={(value) => void perform(() => bridge.updateSettings({ defaultRunLimits: { ...defaultLimits, maxSubagents: value } }), '限制已保存')} />
          <LimitInput label="并行只读工具" value={Number(defaultLimits.maxParallelReadTools ?? settings.maxReadTools ?? 4)} onSave={(value) => void perform(() => bridge.updateSettings({ defaultRunLimits: { ...defaultLimits, maxParallelReadTools: value } }), '限制已保存')} />
        </div>
      </SettingsSection>

      <Modal open={modelOpen} onClose={closeModelModal} title="添加模型配置" description="API Key 由 macOS 系统加密存储保护，保存后无法从界面读回。">
        <SubmitForm className="modal-form" onSubmit={() => void saveModel()}>
          <div className="field"><span className="field-label">服务商</span><div className="radio-cards provider-radio-cards"><button type="button" className={provider === 'openai' ? 'is-active' : ''} onClick={() => selectProvider('openai')}><span className="provider-mini openai">O</span><span><strong>OpenAI</strong><small>官方 API</small></span></button><button type="button" className={provider === 'anthropic' ? 'is-active' : ''} onClick={() => selectProvider('anthropic')}><span className="provider-mini anthropic">A</span><span><strong>Anthropic</strong><small>官方 API</small></span></button><button type="button" className={provider === 'moonshotai-cn' ? 'is-active' : ''} onClick={() => selectProvider('moonshotai-cn')}><span className="provider-mini moonshotai-cn">K</span><span><strong>Kimi / Moonshot</strong><small>256K · 仅思考</small></span></button></div></div>
          <div className="field-row"><Field label="配置名称"><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="模型 ID" hint="可从本地模型目录选择，也可手动输入。"><input list="model-catalog" value={modelId} onChange={(event) => setModelId(event.target.value)} /><datalist id="model-catalog">{modelCatalog.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? item.id)}</option>)}</datalist></Field></div>
          <Field label="API Key" hint="保存后不可从界面读回。"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={MODEL_PROVIDER_META[provider].keyPlaceholder} /></Field>
          {provider === 'moonshotai-cn' && <div className="inline-notice kimi-model-notice"><Icon name="info" /><span>默认使用 Kimi K2.7 Code：256K 上下文，仅思考模式。</span></div>}
          <div className="inline-notice"><Icon name="lock" /><span>Key 不会发送给工具，也不会写入活动记录或工作上下文。</span></div>
          <div className="modal-actions"><button className="button secondary" type="button" onClick={closeModelModal}>取消</button><button className="button primary" type="submit" disabled={!name.trim() || !modelId.trim() || !apiKey.trim()}>安全保存</button></div>
        </SubmitForm>
      </Modal>
      <Modal open={grantOpen} onClose={() => setGrantOpen(false)} title="添加永久授权" description={`该规则只对 ${snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name ?? '当前工作区'} 生效，直到你在设置中撤销。`}>
        <SubmitForm className="modal-form" onSubmit={() => void savePersistentGrant()}>
          <Field label="允许的动作"><select value={grantTool} onChange={(event) => setGrantTool(event.target.value as 'file.write' | 'file.edit')}><option value="file.write">写入文件（file.write）</option><option value="file.edit">编辑文件（file.edit）</option></select></Field>
          <Field label="精确路径" hint="必须与实际操作路径完全一致；不支持通配符或目录递归。"><input className="mono" autoFocus value={grantPath} onChange={(event) => setGrantPath(event.target.value)} placeholder="docs/report.md" /></Field>
          <div className="inline-notice warning"><Icon name="warning" /><span>这不会放行 Shell、网络、上传、发送、删除、购买或发布。</span></div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setGrantOpen(false)}>取消</button><button type="submit" className="button primary" disabled={!grantPath.trim()}>创建授权</button></div>
        </SubmitForm>
      </Modal>
      <Modal open={Boolean(packagePreview)} onClose={() => setPackagePreview(undefined)} title="确认安装能力包" description={`${String(packagePreview?.name ?? '')} · v${String(packagePreview?.version ?? '')}`} wide>
        <div className="modal-form">
          <div className="schedule-preview"><span><strong>目录</strong>{String(packagePreview?.directory ?? '')}</span><span><strong>文件</strong>{String(packagePreview?.fileCount ?? 0)} 个 · {formatBytes(typeof packagePreview?.totalBytes === 'number' ? packagePreview.totalBytes : 0)}</span><span><strong>组件</strong>{Array.isArray(packagePreview?.skills) ? packagePreview.skills.length : 0} Skills · {Array.isArray(packagePreview?.mcpConfigs) ? packagePreview.mcpConfigs.length : 0} MCP · {Array.isArray(packagePreview?.rules) ? packagePreview.rules.length : 0} Rules · {Array.isArray(packagePreview?.templates) ? packagePreview.templates.length : 0} Templates</span></div>
          <Field label="MCP 命令、环境与权限" hint="安装不会执行 Server；首次真正调用仍经过权限代理。"><pre className="package-preview mono">{JSON.stringify(packagePreview?.mcpConfigs ?? [], null, 2)}</pre></Field>
          {Array.isArray(packagePreview?.rules) && packagePreview.rules.length > 0 && <div className="inline-notice warning"><Icon name="warning" /><span>规则会追加到当前工作区“{snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name ?? '未选择'}”。</span></div>}
          <div className="inline-notice"><Icon name="shield" /><span>包已通过路径穿越、符号链接、文件类型、大小、JSON 和 JavaScript 注入检查；其中脚本仍不能绕过 Shell 审批。</span></div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setPackagePreview(undefined)}>取消</button><button type="button" className="button primary" onClick={() => void installCapabilityPackage()} disabled={Array.isArray(packagePreview?.rules) && packagePreview.rules.length > 0 && !selectedWorkspaceId}>确认安装</button></div>
        </div>
      </Modal>
      <Modal open={Boolean(secretProfile)} onClose={closeSecretModal} title="替换 API Key" description={`为 ${secretProfile?.name ?? '模型配置'} 写入新密钥；旧密钥会被覆盖且无法恢复。`}>
        <SubmitForm className="modal-form" onSubmit={async () => {
          if (!secretProfile || !replacementKey.trim()) return
          const submittedKey = replacementKey.trim()
          setReplacementKey('')
          const saved = await perform(async () => { await bridge.setModelSecret({ profileId: secretProfile.id, apiKey: submittedKey }); return true }, 'API Key 已安全替换')
          if (saved) setSecretProfile(undefined)
        }}>
          <Field label="新 API Key" hint="密钥只提供写入入口，保存后不会回显。"><input autoFocus type="password" value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} /></Field>
          <div className="inline-notice"><Icon name="lock" /><span>Key 由系统加密存储保护，不写入活动记录或工作上下文。</span></div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={closeSecretModal}>取消</button><button type="submit" className="button primary" disabled={!replacementKey.trim()}>替换密钥</button></div>
        </SubmitForm>
      </Modal>
      <Modal open={Boolean(rulesWorkspace)} onClose={() => setRulesWorkspace(undefined)} title="工作区规则" description="这些规则只在该工作区的相关工作中加载，且不能改变平台安全边界。" wide>
        <SubmitForm className="modal-form" onSubmit={async () => {
          if (!rulesWorkspace) return
          const saved = await perform(() => bridge.updateWorkspace({ id: rulesWorkspace.id, rules: rulesText }), '工作区规则已保存')
          if (saved !== undefined) setRulesWorkspace(undefined)
        }}>
          <Field label={rulesWorkspace?.name ?? '规则'} hint="可记录架构、验证方式、输出位置和项目约定。"><textarea className="rules-editor mono" rows={13} value={rulesText} onChange={(event) => setRulesText(event.target.value)} placeholder="# 工作区规则\n\n- 修改前先阅读现有实现\n- 完成后运行相关测试" /></Field>
          <div className="inline-notice"><Icon name="shield" /><span>工作区规则用于引导 WorkBuddy；权限、确认和路径边界仍由本机执行层强制保证。</span></div>
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRulesWorkspace(undefined)}>取消</button><button type="submit" className="button primary">保存规则</button></div>
        </SubmitForm>
      </Modal>
    </main>
  )
}

function SettingsSection({ icon, title, description, action, children }: { icon: IconName; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-section"><div className="settings-section-heading"><span className="settings-icon"><Icon name={icon} /></span><div><h2>{title}</h2><p>{description}</p></div>{action && <div className="settings-action">{action}</div>}</div><div className="settings-section-body">{children}</div></section>
}

export function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{detail}</span></div><div>{children}</div></div>
}

function LimitInput({ label, value, onSave }: { label: string; value: number; onSave: (value: number) => void }) {
  const [current, setCurrent] = useState(value)
  useEffect(() => setCurrent(value), [value])
  return <label><span>{label}</span><input type="number" min="1" value={current} onChange={(event) => setCurrent(Number(event.target.value))} onBlur={() => { if (current !== value && current > 0) onSave(current) }} /></label>
}
