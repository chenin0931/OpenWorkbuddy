import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

type StatusUxScenario = 'ordinary-completed' | 'current-verified' | 'current-partial' | 'running' | 'waiting_approval' | 'waiting_user' | 'paused' | 'failed'

const FRONTEND_SCREENSHOT_DIR = path.resolve(process.cwd(), '../../outputs/frontend-refactor')

async function ensureInspector(page: Page) {
  const inspector = page.locator('.inspector')
  if (await inspector.count() === 0) await page.getByRole('button', { name: '工作详情' }).click()
  await expect(inspector).toBeVisible()
  return inspector
}

async function installMockBridge(page: Page, onboarding: boolean, failModelSecret = false, presentation = false, timelineRegression = false, turnGroupingRegression = false, statusUxScenario?: StatusUxScenario, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.addInitScript(({ onboardingMode, failSecret, presentationMode, timelineRegressionMode, turnGroupingRegressionMode, statusUxScenarioMode, themeMode }) => {
    const now = '2026-07-10T16:50:00.000Z'
    const statusUxRunStatus = statusUxScenarioMode === 'ordinary-completed' || statusUxScenarioMode === 'current-verified' || statusUxScenarioMode === 'current-partial'
      ? 'completed'
      : statusUxScenarioMode
    const statusUxMode = Boolean(statusUxScenarioMode)
    const state = {
      onboardingDone: !onboardingMode,
      modelConnected: !onboardingMode,
      workspaceAdded: !onboardingMode,
      approvalPending: statusUxScenarioMode === 'waiting_approval' || (!statusUxMode && !(presentationMode || timelineRegressionMode || turnGroupingRegressionMode)),
      runStatus: statusUxRunStatus || (presentationMode || turnGroupingRegressionMode ? 'completed' : timelineRegressionMode ? 'running' : 'waiting_approval'),
      followUpContent: undefined as string | undefined,
      permissionMode: 'balanced' as string,
      accessMode: 'approval' as 'approval' | 'full_disk',
    }
    const workspace = { id: 'workspace-1', name: 'WorkBuddy Demo', path: '/tmp/workbuddy-demo', selected: true, createdAt: now, updatedAt: now }
    const model: Record<string, unknown> = { id: 'model-1', name: 'OpenAI 主模型', provider: 'openai', modelId: 'gpt-5.4', isDefault: true, isSubagentDefault: true, keyConfigured: true, createdAt: now, updatedAt: now }
    const run = () => ({
      id: 'run-1', workspaceId: workspace.id, title: statusUxMode ? '状态展示回归工作' : presentationMode ? '搜索今日新闻' : timelineRegressionMode ? '检查消息时间线' : turnGroupingRegressionMode ? '联网搜索今天新闻' : '完成桌面应用的安全验收', objective: statusUxMode ? '验证工作状态只在有操作价值或验证证据时显示' : presentationMode ? '搜索今日新闻' : timelineRegressionMode ? '检查消息时间线' : turnGroupingRegressionMode ? '联网搜索今天新闻' : '检查实现并生成可验证发行物', status: state.runStatus, accessMode: state.accessMode,
      ...(presentationMode || statusUxScenarioMode === 'current-partial' ? { outcome: 'partial', summary: '两条来源已读取，仍有一项待交叉核验。' } : statusUxScenarioMode === 'ordinary-completed' || statusUxScenarioMode === 'current-verified' ? { outcome: 'verified', summary: '工作内容已回复。' } : {}),
      model: { profileId: model.id, provider: model.provider, modelId: model.modelId, capabilities: {} },
      limits: { maxModelTurns: 60, maxDurationMs: 7_200_000, maxSubagents: 3, maxParallelReadTools: 4 }, modelTurns: 18,
      createdAt: now, updatedAt: now,
    })
    const bootstrap = () => ({
      app: { name: 'OpenWorkbuddy', version: '0.3.0', platform: 'darwin', arch: 'x64', locale: 'zh-CN' },
      onboardingComplete: state.onboardingDone,
      settings: { onboardingCompleted: state.onboardingDone, theme: themeMode, locale: 'zh-CN', memoryEnabled: true, permissionMode: state.permissionMode, timezone: 'Asia/Shanghai' },
      workspaces: state.workspaceAdded ? [workspace] : [],
      modelProfiles: state.modelConnected ? [model] : [],
      runs: onboardingMode ? [] : [run()],
      memory: onboardingMode ? [] : [{ id: 'memory-1', scope: 'workspace', kind: 'continuation', content: '发行前运行应用冒烟测试', confidence: 0.8, status: 'proposed', source: [{ kind: 'run', reference: 'run-1' }], createdAt: now, updatedAt: now }],
      mcpServers: [], skills: [], automations: [],
      chrome: presentationMode
        ? { connected: false, extensionInstalled: true, nativeHostInstalled: true, grants: [] }
        : { connected: true, extensionInstalled: true, nativeHostInstalled: true, grants: statusUxMode ? [] : [{ id: 'grant-1', runId: 'run-1', tabId: 101, title: '验收页', url: 'http://127.0.0.1' }] },
    })
    const api = {
      apiVersion: 1,
      bootstrap: async () => bootstrap(),
      app: {
        getInfo: async () => bootstrap().app,
        chooseWorkspace: async () => workspace.path,
        importAttachments: async () => [{ id: 'attachment-1', kind: 'attachment', sha256: 'a'.repeat(64), mediaType: 'text/plain', byteLength: 12, displayName: '验收说明.txt', createdAt: now }],
      },
      workspaces: {
        create: async () => { state.workspaceAdded = true; return workspace },
        select: async () => workspace,
      },
      models: {
        catalog: async ({ provider }: { provider: string }) => provider === 'moonshotai-cn'
          ? [{ id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144, reasoning: true }]
          : [],
        upsert: async (input: Record<string, unknown>) => {
          Object.assign(model, input)
          ;(window as typeof window & { __lastModelSelection?: Record<string, unknown> }).__lastModelSelection = {
            provider: input.provider,
            modelId: input.modelId,
            name: input.name,
          }
          return model
        },
        setSecret: async () => {
          if (failSecret) throw new Error('模拟密钥保存失败')
          state.modelConnected = true
        },
        setDefaults: async () => undefined,
      },
      settings: {
        update: async (input: { permissionMode?: string }) => {
          state.onboardingDone = true
          if (input.permissionMode) state.permissionMode = input.permissionMode
          return bootstrap().settings
        },
      },
      runs: {
        list: async () => ({ items: onboardingMode ? [] : [run()] }),
        create: async (input: Record<string, unknown>) => {
          state.accessMode = input.accessMode === 'full_disk' ? 'full_disk' : 'approval'
          ;(window as typeof window & { __lastCreateRunInput?: Record<string, unknown> }).__lastCreateRunInput = input
          return run()
        },
        get: async () => {
          if (state.followUpContent) {
            ;(window as typeof window & { __followUpDetailReloaded?: boolean }).__followUpDetailReloaded = true
          }
          return {
          ...run(),
          steps: [
            { id: 'step-1', runId: 'run-1', title: '读取项目规则', ordinal: 0, status: 'completed', createdAt: now, updatedAt: now },
            { id: 'step-2', runId: 'run-1', title: '运行最终验证', ordinal: 1, status: 'in_progress', createdAt: now, updatedAt: now },
          ],
          messages: statusUxMode ? [
            { id: 'status-message-user', role: 'user', title: '你', content: '请回答这个普通问题。', actor: 'user', createdAt: '2026-07-10T16:50:00.000Z' },
            { id: 'status-message-assistant', role: 'assistant', title: 'OpenWorkbuddy', content: '这是本轮对话的回答。', actor: 'assistant', createdAt: '2026-07-10T16:50:01.000Z' },
          ] : turnGroupingRegressionMode ? [
            { id: 'turn-message-user-1', role: 'user', title: '你', content: '联网搜下今天新闻呢', actor: 'user', createdAt: '2026-07-10T16:50:00.000Z' },
            { id: 'turn-message-assistant-1', role: 'assistant', title: 'OpenWorkbuddy', content: '好的，我来搜索一下今天的新闻。', actor: 'assistant', createdAt: '2026-07-10T16:50:01.000Z' },
            { id: 'turn-message-assistant-2', role: 'assistant', title: 'OpenWorkbuddy', content: '第一次检索没有得到足够结果，我又抓取了新闻原文并完成整理。', actor: 'assistant', createdAt: '2026-07-10T16:50:04.000Z' },
            { id: 'turn-message-user-2', role: 'user', title: '你', content: '那换个关键词再试一次', actor: 'user', createdAt: '2026-07-10T16:50:05.000Z' },
            { id: 'turn-message-assistant-3', role: 'assistant', title: 'OpenWorkbuddy', content: '可以，我会按新关键词重新搜索。', actor: 'assistant', createdAt: '2026-07-10T16:50:06.000Z' },
          ] : [
            { id: 'message-1', role: 'user', title: '你', content: '请完成安全验收。', actor: 'user', createdAt: now },
            ...(presentationMode ? [
              { id: 'message-empty', role: 'assistant', title: 'OpenWorkbuddy', content: '', actor: 'assistant', createdAt: now },
              { id: 'message-2', role: 'assistant', title: 'OpenWorkbuddy', content: '## 国内要闻\n\n- **重点新闻**：已读取原文并整理。\n- [查看来源](https://example.com/news)', actor: 'assistant', createdAt: now },
            ] : [{ id: 'message-2', role: 'assistant', title: 'OpenWorkbuddy', content: timelineRegressionMode ? '我会先读取工作区，再汇总结果。' : '需要运行构建验证，因此先请求授权。', actor: 'assistant', createdAt: '2026-07-10T16:50:01.000Z' }]),
            ...(timelineRegressionMode && state.followUpContent ? [{ id: 'message-follow-up', role: 'user', title: '你', content: state.followUpContent, actor: 'user', createdAt: '2026-07-10T16:50:03.000Z' }] : []),
          ],
          pendingApprovals: state.approvalPending ? [{ id: 'approval-1', runId: 'run-1', toolCallId: 'tool-1', toolName: 'shell_run', riskLevel: 'reversible_write', title: '运行项目验证命令', reason: '构建会写入缓存', target: 'pnpm test', arguments: { command: 'pnpm test' }, sendsData: [], reversible: true, status: 'pending', createdAt: now }] : [],
          artifacts: [{ id: 'diff-1', runId: 'run-1', kind: 'diff', sha256: 'b'.repeat(64), mediaType: 'text/x-diff', byteLength: 90, displayName: 'tool-broker.ts.diff', createdAt: now, metadata: { path: '/tmp/workbuddy-demo/tool-broker.ts', additions: 4, deletions: 1, snapshotArtifactId: 'snapshot-1', afterSha256: 'c'.repeat(64), createdFile: false } }],
          ...(statusUxScenarioMode === 'current-verified' ? {
            verification: { status: 'verified', summary: '本轮检查已经通过。', checks: [{ name: '当前结果检查', status: 'passed' }] },
          } : statusUxScenarioMode === 'current-partial' ? {
            verification: { status: 'partial', summary: '本轮仍有一项证据需要补充。', checks: [{ name: '补充来源', status: 'not_run' }] },
          } : presentationMode ? {
            toolCalls: [
              { id: 'tool-search', toolName: 'web_search', status: 'succeeded', argumentsSummary: { query: '今日新闻' }, resultSummary: '返回 5 条结果', sources: [{ url: 'https://example.com/news', title: '示例新闻来源', domain: 'Example News', status: 'fetched' }], createdAt: now, updatedAt: now },
              { id: 'tool-chrome', toolName: 'chrome_snapshot', status: 'failed', argumentsSummary: {}, error: '浏览器连接已断开', createdAt: now, updatedAt: now },
            ],
            approvalHistory: [{ id: 'approval-history-1', title: '搜索互联网', reason: '请求外部网络', status: 'approved', scope: 'once', createdAt: now, resolvedAt: now }],
            verification: { status: 'partial', summary: '两条来源已读取，仍有一项待交叉核验。', checks: [{ name: '来源可访问', status: 'passed' }, { name: '多源交叉核验', status: 'not_run' }] },
          } : timelineRegressionMode ? {
            toolCalls: [{ id: 'tool-workspace', toolName: 'filesystem_list', status: 'succeeded', argumentsSummary: { path: '.' }, resultSummary: '返回 12 个目录项', createdAt: '2026-07-10T16:50:02.000Z', updatedAt: '2026-07-10T16:50:02.000Z' }],
          } : turnGroupingRegressionMode ? {
            toolCalls: [
              { id: 'turn-tool-search', toolName: 'web_search', status: 'succeeded', argumentsSummary: { query: '今天新闻' }, resultSummary: '返回 8 条搜索结果', createdAt: '2026-07-10T16:50:02.000Z', updatedAt: '2026-07-10T16:50:02.000Z' },
              { id: 'turn-tool-fetch', toolName: 'web_fetch', status: 'succeeded', argumentsSummary: { url: 'https://example.com/today' }, resultSummary: '已抓取新闻原文', createdAt: '2026-07-10T16:50:03.000Z', updatedAt: '2026-07-10T16:50:03.000Z' },
            ],
          } : {}),
          }
        },
        respondToApproval: async () => { state.approvalPending = false; state.runStatus = 'running' },
        sendMessage: async ({ content, accessMode }: { content: string; accessMode?: 'approval' | 'full_disk' }) => {
          ;(window as typeof window & { __lastSendMessageInput?: Record<string, unknown> }).__lastSendMessageInput = { content, accessMode }
          ;(window as typeof window & { __sendMessageStarted?: boolean; __sendMessageSettled?: boolean }).__sendMessageStarted = true
          ;(window as typeof window & { __sendMessageStarted?: boolean; __sendMessageSettled?: boolean }).__sendMessageSettled = false
          await new Promise((resolve) => window.setTimeout(resolve, 650))
          state.followUpContent = content
          state.accessMode = accessMode === 'full_disk' ? 'full_disk' : 'approval'
          ;(window as typeof window & { __sendMessageStarted?: boolean; __sendMessageSettled?: boolean }).__sendMessageSettled = true
        },
        pause: async () => undefined,
        cancel: async () => undefined,
      },
      artifacts: {
        getText: async () => ({ text: '--- before\n+++ after\n-old\n+new\n', truncated: false }),
        undoChange: async () => ({ restored: true, path: '/tmp/workbuddy-demo/tool-broker.ts', createdFileRemoved: false }),
      },
      events: { subscribe: () => () => undefined },
    }
    Object.defineProperty(window, 'workbuddy', { value: api, configurable: false })
  }, { onboardingMode: onboarding, failSecret: failModelSecret, presentationMode: presentation, timelineRegressionMode: timelineRegression, turnGroupingRegressionMode: turnGroupingRegression, statusUxScenarioMode: statusUxScenario, themeMode: theme })
}

test('首次启动完成模型、工作区和执行边界配置', async ({ page }) => {
  await installMockBridge(page, true)
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: '欢迎使用 OpenWorkbuddy' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '开始设置' }).click()
  await onboarding.getByRole('button', { name: /Kimi \/ Moonshot/ }).click()
  await expect(onboarding.getByRole('textbox', { name: '模型 ID' })).toHaveValue('kimi-k2.7-code')
  await expect(onboarding).toContainText('256K 上下文，仅思考模式')
  await onboarding.getByLabel('API Key').fill('fake-moonshot-key-e2e-only')
  await onboarding.getByRole('button', { name: '安全保存并继续' }).click()
  await expect(onboarding.getByRole('heading', { name: '授权一个工作区' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __lastModelSelection?: Record<string, unknown> }).__lastModelSelection)).toMatchObject({
    provider: 'moonshotai-cn',
    modelId: 'kimi-k2.7-code',
    name: 'Kimi / Moonshot',
  })
  await onboarding.getByRole('button', { name: '选择文件夹' }).click()
  await expect(onboarding.getByRole('heading', { name: '连接 Chrome' })).toBeVisible()
  await onboarding.getByRole('button', { name: /继续/ }).click()
  await expect(onboarding.getByRole('heading', { name: '确认工作方式' })).toBeVisible()
  await expect(onboarding).toContainText('在输入框“添加文件”左侧选择“请求批准”或“完全访问”')
  await onboarding.getByRole('button', { name: '进入工作台' }).click()
  await expect(onboarding).toBeHidden()
})

test('Kimi 设置支持目录、品牌样式，并在失败与取消后清空假 Key', async ({ page }) => {
  await installMockBridge(page, false, true)
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '工作权限' })).toBeVisible()
  await expect(page.getByText('新工作和追问时，在“添加文件”左侧选择“请求批准”或“完全访问”。')).toBeVisible()
  await page.getByRole('button', { name: /添加配置/ }).click()

  const addDialog = page.getByRole('dialog', { name: '添加模型配置' })
  await addDialog.getByRole('button', { name: 'K Kimi / Moonshot 256K · 仅思考', exact: true }).click()
  await expect(addDialog.getByRole('textbox', { name: '配置名称' })).toHaveValue('Kimi / Moonshot')
  await expect(addDialog.getByLabel('模型 ID')).toHaveValue('kimi-k2.7-code')
  await expect(addDialog).toContainText('256K 上下文，仅思考模式')

  const keyInput = addDialog.getByLabel('API Key')
  await keyInput.fill('fake-moonshot-key-failure-only')
  await addDialog.getByRole('button', { name: '安全保存' }).click()
  await expect(addDialog).toBeVisible()
  await expect(keyInput).toHaveValue('')
  await addDialog.getByRole('button', { name: '取消' }).click()
  await expect(addDialog).toBeHidden()

  await page.getByRole('button', { name: /添加配置/ }).click()
  await addDialog.getByLabel('API Key').fill('fake-moonshot-key-cancel-only')
  await addDialog.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: /添加配置/ }).click()
  await expect(addDialog.getByLabel('API Key')).toHaveValue('')
  await addDialog.getByRole('button', { name: '取消' }).click()

  await page.getByRole('button', { name: '刷新工作台' }).click()
  await expect(page.locator('.provider-logo.moonshotai-cn')).toContainText('K')
  await page.getByRole('button', { name: '更新 Key' }).click()
  const replacementDialog = page.getByRole('dialog', { name: '替换 API Key' })
  const replacementInput = replacementDialog.getByLabel('新 API Key')
  await replacementInput.fill('fake-replacement-key-failure-only')
  await replacementDialog.getByRole('button', { name: '替换密钥' }).click()
  await expect(replacementDialog).toBeVisible()
  await expect(replacementInput).toHaveValue('')
  await replacementDialog.getByRole('button', { name: '取消' }).click()
})

test('工作台支持确认、添加文件与持久化 Diff 预览', async ({ page }) => {
  await installMockBridge(page, false)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '完成桌面应用的安全验收' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '运行项目验证命令' })).toBeVisible()
  await page.getByRole('button', { name: '允许这一次' }).click()
  await expect(page.getByRole('heading', { name: '运行项目验证命令' })).toBeHidden()
  await page.getByRole('button', { name: '添加文件' }).click()
  await expect(page.getByRole('button', { name: '移除 验收说明.txt' })).toBeVisible()
  const inspector = await ensureInspector(page)
  await expect(inspector.getByRole('region', { name: '产物' })).toContainText('文件变更')
  await expect(inspector.getByRole('tab', { name: '详细' })).toBeVisible()
  await expect(inspector.getByRole('tab', { name: /变更/ })).toBeVisible()
  await expect(inspector.getByRole('tab', { name: '活动' })).toBeVisible()
  await inspector.getByRole('tab', { name: /变更/ }).click()
  await expect(inspector.getByText('tool-broker.ts', { exact: true }).first()).toBeVisible()
  await inspector.getByRole('button', { name: '查看', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'tool-broker.ts' })).toContainText('WorkBuddy 保存的本地文件变更')
})

test('新工作与追问可在添加文件左侧选择文件访问权限，并随请求持久化', async ({ page }) => {
  await installMockBridge(page, false, false, false, true)
  await page.goto('/')

  const runningAccess = page.getByLabel('文件访问权限')
  await expect(runningAccess).toHaveValue('approval')
  const runningOrder = await runningAccess.evaluate((select) => {
    const addFile = select.parentElement?.querySelector<HTMLButtonElement>('.attachment-button')
    return Boolean(addFile && (select.compareDocumentPosition(addFile) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(runningOrder).toBe(true)

  await runningAccess.selectOption('full_disk')
  await page.getByPlaceholder('继续补充、调整方向或交代下一步…').fill('继续检查桌面上的资料')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __lastSendMessageInput?: Record<string, unknown> }).__lastSendMessageInput)).toMatchObject({
    content: '继续检查桌面上的资料',
    accessMode: 'full_disk',
  })
  await expect.poll(() => runningAccess.inputValue()).toBe('full_disk')

  await page.locator('.new-task-button').click()
  await expect(page.getByRole('heading', { name: '从这里开始一项工作' })).toBeVisible()
  const newRunAccess = page.getByLabel('文件访问权限')
  await expect(newRunAccess).toHaveValue('approval')
  const newRunOrder = await newRunAccess.evaluate((select) => {
    const addFile = select.parentElement?.querySelector<HTMLButtonElement>('.attachment-button')
    return Boolean(addFile && (select.compareDocumentPosition(addFile) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(newRunOrder).toBe(true)

  await newRunAccess.selectOption('full_disk')
  await page.getByPlaceholder('描述你想完成的工作…').fill('整理整个磁盘中的项目资料')
  await page.getByRole('button', { name: '开始工作' }).click()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __lastCreateRunInput?: Record<string, unknown> }).__lastCreateRunInput)).toMatchObject({
    objective: '整理整个磁盘中的项目资料',
    accessMode: 'full_disk',
  })
})

test('工作结果安全渲染 Markdown、过滤空消息并保持可追问', async ({ page }) => {
  await installMockBridge(page, false, false, true)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '国内要闻' })).toBeVisible()
  await expect(page.locator('.agent-message')).toHaveCount(1)
  await expect(page.getByText('还有内容未检查', { exact: true }).first()).toBeVisible()
  await expect(page.getByPlaceholder('继续补充、调整方向或交代下一步…')).toBeEnabled()

  const inspector = await ensureInspector(page)
  await expect(inspector.getByRole('tab', { name: '详细' })).toBeVisible()
  await expect(inspector.getByRole('link', { name: /示例新闻来源/ })).toBeVisible()

  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.run-composer')?.getBoundingClientRect()
    const pane = document.querySelector('.run-pane')?.getBoundingClientRect()
    return { composerBottom: composer?.bottom ?? Infinity, paneBottom: pane?.bottom ?? Infinity, viewport: window.innerHeight }
  })
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewport + 1)
  expect(layout.paneBottom).toBeLessThanOrEqual(layout.viewport + 1)
})

test('新追问立即显示为右侧气泡，并排在工具活动之后且持久化后不重复', async ({ page }) => {
  await installMockBridge(page, false, false, false, true)
  await page.goto('/')

  const activity = page.locator('.turn-activity')
  await expect(activity).not.toHaveAttribute('open', '')
  await expect(activity.locator('.turn-activity-content')).toBeHidden()
  const activitySummary = activity.locator(':scope > summary')
  const collapsedHeight = await activitySummary.evaluate((element) => element.getBoundingClientRect().height)
  expect(collapsedHeight).toBeLessThanOrEqual(36)
  await activitySummary.click()
  await expect(activity.locator('.turn-activity-content')).toBeVisible()
  await activitySummary.click()
  await expect(activity.locator('.turn-activity-content')).toBeHidden()

  const content = '请继续检查刚才的工具结果。'
  const composer = page.getByPlaceholder('继续补充、调整方向或交代下一步…')
  await composer.fill(content)
  await page.locator('.send-button').click()

  const followUp = page.locator('.user-message').filter({ hasText: content })
  await expect(followUp).toBeVisible({ timeout: 300 })
  await expect.poll(() => page.evaluate(() => ({
    started: Boolean((window as typeof window & { __sendMessageStarted?: boolean }).__sendMessageStarted),
    settled: Boolean((window as typeof window & { __sendMessageSettled?: boolean }).__sendMessageSettled),
  }))).toEqual({ started: true, settled: false })

  const placement = await page.evaluate((message) => {
    const userMessage = [...document.querySelectorAll<HTMLElement>('.user-message')].find((element) => element.textContent?.includes(message))
    const userBubble = userMessage?.querySelector<HTMLElement>('.markdown-content')
    const agentBubble = document.querySelector<HTMLElement>('.agent-message .markdown-content')
    const timeline = document.querySelector<HTMLElement>('.timeline')
    const toolActivity = document.querySelector<HTMLElement>('.turn-activity')
    if (!userMessage || !userBubble || !agentBubble || !timeline || !toolActivity) return undefined
    const userBox = userBubble.getBoundingClientRect()
    const agentBox = agentBubble.getBoundingClientRect()
    const timelineBox = timeline.getBoundingClientRect()
    return {
      userX: userBox.x,
      agentX: agentBox.x,
      rightGap: timelineBox.right - userBox.right,
      toolBeforeUser: Boolean(toolActivity.compareDocumentPosition(userMessage) & Node.DOCUMENT_POSITION_FOLLOWING),
    }
  }, content)
  expect(placement).toBeDefined()
  expect(placement!.userX).toBeGreaterThan(placement!.agentX + 100)
  expect(placement!.rightGap).toBeLessThan(70)
  expect(placement!.toolBeforeUser).toBe(true)

  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __followUpDetailReloaded?: boolean }).__followUpDetailReloaded))).toBe(true)
  await expect(followUp).toHaveCount(1)
})

test('同一用户轮次的多段回复与多次工具调用合并为一个 WorkBuddy 响应', async ({ page }) => {
  await installMockBridge(page, false, false, false, false, true)
  await page.goto('/')

  const userMessages = page.locator('.user-message')
  const agentTurns = page.locator('.agent-turn')
  await expect(userMessages).toHaveCount(2)
  await expect(agentTurns).toHaveCount(2)

  const firstTurn = agentTurns.nth(0)
  await expect(firstTurn).toContainText('好的，我来搜索一下今天的新闻。')
  await expect(firstTurn).toContainText('第一次检索没有得到足够结果，我又抓取了新闻原文并完成整理。')
  await expect(firstTurn.locator('.message-avatar.agent')).toHaveCount(1)
  await expect(firstTurn.locator('.message-meta')).toHaveCount(1)

  const firstTurnActivity = firstTurn.locator('.turn-activity')
  await expect(firstTurnActivity).toHaveCount(1)
  await expect(firstTurnActivity).not.toHaveAttribute('open', '')
  const firstTurnActivitySummary = firstTurnActivity.locator(':scope > summary')
  await expect(firstTurnActivitySummary).toContainText(/已处理.*网页/)
  await expect(firstTurnActivity.locator('.turn-activity-content')).toBeHidden()
  const collapsedHeight = await firstTurnActivitySummary.evaluate((element) => element.getBoundingClientRect().height)
  expect(collapsedHeight).toBeLessThanOrEqual(36)

  const firstTurnOrder = await firstTurn.evaluate((turn) => {
    const textNodes = [...turn.querySelectorAll<HTMLElement>('.markdown-content')]
    const acknowledgement = textNodes.find((element) => element.textContent?.includes('好的，我来搜索一下今天的新闻。'))
    const activity = turn.querySelector<HTMLElement>('.turn-activity')
    const result = textNodes.find((element) => element.textContent?.includes('第一次检索没有得到足够结果'))
    if (!acknowledgement || !activity || !result) return undefined
    return {
      acknowledgementBeforeActivity: Boolean(acknowledgement.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING),
      resultBeforeActivity: Boolean(result.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING),
    }
  })
  expect(firstTurnOrder).toEqual({ acknowledgementBeforeActivity: true, resultBeforeActivity: true })

  const secondUserMessage = userMessages.filter({ hasText: '那换个关键词再试一次' })
  await expect(secondUserMessage).toHaveCount(1)
  const secondTurn = agentTurns.nth(1)
  await expect(secondTurn).toContainText('可以，我会按新关键词重新搜索。')
  await expect(secondTurn.locator('.message-avatar.agent')).toHaveCount(1)
  await expect(secondTurn.locator('.message-meta')).toHaveCount(1)

  const turnBoundaries = await page.evaluate(() => {
    const turns = [...document.querySelectorAll<HTMLElement>('.agent-turn')]
    const nextUser = [...document.querySelectorAll<HTMLElement>('.user-message')].find((element) => element.textContent?.includes('那换个关键词再试一次'))
    if (turns.length !== 2 || !nextUser) return undefined
    return {
      firstTurnBeforeUser: Boolean(turns[0].compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING),
      userBeforeSecondTurn: Boolean(nextUser.compareDocumentPosition(turns[1]) & Node.DOCUMENT_POSITION_FOLLOWING),
    }
  })
  expect(turnBoundaries).toEqual({ firstTurnBeforeUser: true, userBeforeSecondTurn: true })
})

test('普通已结束对话不显示完成庆祝、状态圆点或无证据的验证结论', async ({ page }) => {
  await installMockBridge(page, false, false, false, false, false, 'ordinary-completed')
  await page.goto('/')

  const selectedTask = page.locator('.task-list-item.is-active')
  await expect(page.locator('.run-header .status-badge')).toHaveCount(0)
  await expect(selectedTask.locator('.status-badge')).toHaveCount(0)
  await expect(selectedTask.locator('.status-dot')).toHaveCount(0)
  await expect(page.locator('.completion-card')).toHaveCount(0)

  const inspector = await ensureInspector(page)
  await expect(inspector.getByRole('region', { name: '产物' })).toContainText('文件变更')
  await expect(page.locator('.run-header')).not.toContainText('检查通过')
  await expect(page.locator('.run-header')).not.toContainText('还有内容未检查')
})

for (const { status, label } of [
  { status: 'running', label: '正在处理' },
  { status: 'waiting_approval', label: '需要确认' },
  { status: 'waiting_user', label: '等你回复' },
  { status: 'paused', label: '已暂停' },
  { status: 'failed', label: '未完成' },
] as const) {
  test(`可操作状态仍清晰显示：${label}`, async ({ page }) => {
    await installMockBridge(page, false, false, false, false, false, status)
    await page.goto('/')

    await expect(page.locator(`.run-header .status-${status}`)).toBeVisible()
    await expect(page.locator(`.task-list-item.is-active .status-${status}`)).toBeVisible()
    await expect(page.locator('.run-header .status-badge')).toContainText(label)
  })
}

for (const { scenario, wording } of [
  { scenario: 'current-verified', wording: '检查通过' },
  { scenario: 'current-partial', wording: '还有内容未检查' },
] as const) {
  test(`本轮存在真实验证记录时显示“${wording}”`, async ({ page }) => {
    await installMockBridge(page, false, false, false, false, false, scenario)
    await page.goto('/')

    const inspector = await ensureInspector(page)
    await expect(inspector.getByRole('tab', { name: '详细' })).toHaveAttribute('aria-selected', 'true')
    await expect(inspector).toContainText(wording)
    await expect(page.locator('.run-header')).not.toContainText(wording)
  })
}

test('多尺寸、浅深色工作台视觉基准', async ({ browser }) => {
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1728, height: 1117 },
  ]) {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      const page = await context.newPage()
      await installMockBridge(page, false, false, false, false, true, undefined, theme)
      await page.goto('/')

      await expect(page.locator('.agent-turn')).toHaveCount(2)
      await expect(page.locator('.inspector')).toBeVisible()
      await expect(page.getByRole('region', { name: '产物' })).toContainText('文件变更')
      const activity = page.locator('.turn-activity').first()
      await expect(activity).not.toHaveAttribute('open', '')
      const activityHeight = await activity.locator(':scope > summary').evaluate((element) => element.getBoundingClientRect().height)
      expect(activityHeight).toBeLessThanOrEqual(36)
      const shell = await page.locator('.app-shell').evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
      expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth + 1)

      await page.screenshot({
        path: `${FRONTEND_SCREENSHOT_DIR}/workbench-${theme}-${width}x${height}.png`,
        animations: 'disabled',
        fullPage: false,
      })
      await context.close()
    }
  }
})

test('高对比度与 Reduce Motion 工作台视觉基准', async ({ browser }) => {
  for (const mode of ['high-contrast', 'reduce-motion'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      contrast: mode === 'high-contrast' ? 'more' : 'no-preference',
      reducedMotion: mode === 'reduce-motion' ? 'reduce' : 'no-preference',
    })
    const page = await context.newPage()
    await installMockBridge(page, false, false, false, false, true, undefined, 'light')
    await page.goto('/')

    await expect(page.locator('.agent-turn')).toHaveCount(2)
    const activity = page.locator('.turn-activity').first()
    await expect(activity).not.toHaveAttribute('open', '')
    const height = await activity.locator(':scope > summary').evaluate((element) => element.getBoundingClientRect().height)
    expect(height).toBeLessThanOrEqual(36)

    await page.screenshot({
      path: `${FRONTEND_SCREENSHOT_DIR}/workbench-${mode}-1440x900.png`,
      animations: 'disabled',
      fullPage: false,
    })
    await context.close()
  }
})

test('确认、检查、失败与浏览器恢复场景视觉基准', async ({ browser }) => {
  const scenes = [
    { name: 'ordinary-answer', scenario: 'ordinary-completed' as const },
    { name: 'approval' },
    { name: 'verified-changes', scenario: 'current-verified' as const, inspector: 'changes' as const },
    { name: 'partial-checks', scenario: 'current-partial' as const, inspector: 'details' as const },
    { name: 'failed', scenario: 'failed' as const },
    { name: 'chrome-reconnect', presentation: true, inspector: 'details' as const },
  ]

  for (const scene of scenes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const page = await context.newPage()
    await installMockBridge(page, false, false, scene.presentation === true, false, false, scene.scenario, 'light')
    await page.goto('/')

    if (scene.inspector) {
      const inspector = await ensureInspector(page)
      if (scene.inspector === 'changes') await inspector.getByRole('tab', { name: /变更/ }).click()
    }

    if (scene.name === 'ordinary-answer') {
      await expect(page.locator('.status-badge')).toHaveCount(0)
      await expect(page.locator('.completion-card')).toHaveCount(0)
    }
    if (scene.name === 'approval') await expect(page.getByText('需要你的确认', { exact: true })).toBeVisible()
    if (scene.name === 'failed') await expect(page.locator('.inline-notice.error')).toBeVisible()
    if (scene.name === 'partial-checks') await expect(page.locator('.inspector')).not.toContainText('浏览器连接')
    if (scene.name === 'chrome-reconnect') await expect(page.locator('.inspector')).toContainText('需要重新连接')

    await page.screenshot({
      path: `${FRONTEND_SCREENSHOT_DIR}/scene-${scene.name}-1440x900.png`,
      animations: 'disabled',
      fullPage: false,
    })
    await context.close()
  }
})
