# OpenWorkbuddy 本地安装与使用

## 当前交付形态

- macOS Intel (`x86_64`) unsigned `.app`、`.dmg` 和 `.zip`
- Chrome 扩展 ZIP（Manifest V3）
- Rust Native Messaging Host 及安装、卸载脚本
- 完整源码与签名、公证、universal 构建流水线

当前机器没有 Developer ID，因此本地包未签名、未公证，也不会启用自动更新。正式分发前应使用仓库中的 release workflow 生成签名并公证的 universal 包。

## 安装桌面应用

1. 打开 DMG，把 `OpenWorkbuddy.app` 拖入“应用程序”。也可以直接解压 macOS ZIP。
2. 首次打开 unsigned 本地构建时，优先在 Finder 中右键应用并选择“打开”。
3. 如果 macOS 仍阻止启动，可在“系统设置 → 隐私与安全性”中确认打开。只在你确认包来源可信时，才在终端执行：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/OpenWorkbuddy.app"
   ```

应用数据默认保存在：

```text
~/Library/Application Support/OpenWorkbuddy
```

模型 API Key 通过 Electron `safeStorage` 加密，macOS 下由登录钥匙串保护；Key 不会暴露给 Renderer、工具环境、模型上下文或诊断包。

## 首次启动

首次启动会依次完成：

1. 添加 OpenAI、Anthropic 或 Kimi（Moonshot 中国区）官方 API Key，并填写/选择模型 ID；Kimi 默认使用 `kimi-k2.7-code`；
2. 授权一个本地工作区；
3. 检查 Chrome Bridge 状态；未安装时可先跳过，随后按下方流程完成；
4. 确认 Memory 建议与默认执行边界。

运行中的任务固定使用创建时的模型快照。替换 Key 或默认模型只影响新任务和后续新建的子 Agent。

Kimi K2.7 Code 使用固定的 Moonshot 中国区地址 `https://api.moonshot.cn/v1`，支持 256K 上下文、图片输入、思考与多轮工具调用。它不支持关闭思考，也不支持 `tool_choice=required`；应用使用 `auto` 工具选择，并由任务计划和完成门禁验证是否真的执行了所需工具。详细兼容边界见 `docs/kimi.md`。

## 安装 Chrome Bridge

Chrome 出于安全原因要求用户手动加载 unpacked 扩展并点击工具栏图标，应用不会静默安装或自动接管标签页。

1. 解压 `on-my-workbuddy-chrome.zip` 到固定目录。
2. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”。
3. 复制扩展卡片显示的 32 位扩展 ID。
4. 保持桌面应用已安装，运行其 Native Host 安装脚本：

   ```bash
   "/Applications/OpenWorkbuddy.app/Contents/Resources/NativeHost/scripts/install.sh" <扩展ID>
   ```

5. 重启 Chrome 和 OpenWorkbuddy。
6. 打开一个普通 `http(s)` 页面，点击 OpenWorkbuddy 扩展图标，再在具体任务中选择“绑定当前标签页”。

Agent 只能访问用户点击授权的根标签和由它新开的子标签；扩展不会导出 Cookie，也不会读取其他既有标签。Chrome 或 Native Host 断线时，相关任务会进入等待状态，可在重连后恢复。

卸载 Native Host：

```bash
"/Applications/OpenWorkbuddy.app/Contents/Resources/NativeHost/scripts/uninstall.sh"
```

## 权限与审批

- 新工作和追问输入框的“添加文件”左侧提供任务级文件范围：**请求批准**保留当前工作区边界，**完全访问**把本工作后续文件与 Shell 的授权根扩展到整个磁盘。选择会随工作保存，应用重启后不会悄悄改变。
- 完全访问不会把项目工作区改成 `/`：项目规则、相对路径和 Shell 默认目录仍以当前工作区为准，只有绝对路径授权根扩展为 `/`。子 Agent 只能继承这一范围，不能自行提升。
- 完全访问仍受 macOS 隐私权限（TCC / Full Disk Access）约束；系统没有授予的受保护目录，应用不能绕过。Electron `utilityProcess` 也不是恶意代码硬沙箱。
- 完全访问只自动放行明确的低风险本机动作（如带快照和过期检查的文件写入）；未知 Shell、网络、删除和外部副作用仍会停下来确认。
- 文件写入前校验读取时的 SHA-256/mtime，并保存修改前快照；工作区外的变更同样生成 Diff 并支持带过期校验的撤销。
- `pwd`、`ls`、`rg`、只读 Git 查询等明确只读命令可自动执行。
- 产品不再提供覆盖所有工作的全局“谨慎 / 平衡 / 高效”设置。每项工作都在输入框中独立选择文件访问范围，当前选择会随工作持久化并用于后续追问。
- 无论选择哪种文件访问范围，搜索、发送、发布、支付、上传、删除、网络命令、未知外部 MCP 操作和高风险不可逆动作仍按执行策略要求确认或被拒绝。
- 永久授权只能在“设置 → 永久授权”中创建；首版只允许 `file.write` / `file.edit` 绑定“工作区 + 精确路径”，不支持跨工作区复用、通配符、目录递归、Shell 或外部副作用。
- 发送、发布、删除、购买、敏感输入等外部/不可逆动作不会自动重放。
- macOS 应用自动化命令（AppleScript、Shortcuts、Automator、`open -a/-b` 等）被直接拒绝；产品只控制已授权 Chrome 标签页。

Shell 和用户安装的 stdio MCP Server 都以当前 macOS 用户身份运行，不是恶意代码硬沙箱。审批前应核对完整目标、参数、数据去向和可逆性。

## 产物区

工作详情右侧顶部是常驻产物区。Agent 生成的最终文件、浏览器截图和文件变更会自动集中到这里；点击文件可在 Finder 中定位，点击“文件变更”可查看 Diff 或撤销。附件、修改前快照、上下文 Checkpoint 和仅供诊断的长工具结果属于内部运行材料，不会显示为用户产物。新产物出现或切换到已有产物的工作时，右侧面板会自动打开；仍可通过工具栏按钮手动收起。

## MCP、Skills、Memory 与自动化

- MCP 支持 stdio 与 Streamable HTTP，可使用无认证、加密 Header/Bearer 或 OAuth PKCE。
- Skills 以 `SKILL.md` 为入口，引用和脚本按需读取；脚本执行仍经过 Shell 权限代理。
- 长期 Memory 只有 `confirmed` 状态才会进入匹配作用域的上下文，候选可确认、停用或删除。
- 自动化支持一次性、固定间隔和 Cron；保存前显示系统时区、规范化日程和下一次运行时间。
- 关闭窗口后菜单栏进程继续调度；显式退出应用后停止。错过的执行不会自动补跑，高风险动作会暂停并通知。

本地能力包使用根目录中的 `workbuddy-package.json` 组合 Skills、MCP JSON、规则和模板。通过“设置 → 本地能力包”选择目录后，应用会先递归检查真实路径、符号链接、文件类型、大小与哈希，并展示 MCP 命令、环境和权限；确认后才复制 Skills/模板、注册 MCP，并把规则追加到所选工作区。能力包不允许 `.js`、`.cjs` 或 `.mjs` 注入 Electron/Agent Host，也不会形成在线市场。完整 manifest 与 MCP 示例见源码中的 `docs/capability-packages.md`。

## 完成与恢复

完成门禁只用于本轮实际执行了文件、Shell、网页、Chrome、MCP 或子 Agent 等可观察工作的场景。普通问答、寒暄和确认结束不会进入完成门禁。门禁会检查当前轮计划步骤、工具状态和可观察验证结果；Diff 只证明“发生了变更”，不证明业务正确，修改文件的任务如果没有成功的测试、构建或其他明确验证，只能在右侧标记为“待核验”。

任务、步骤、审批、回执、检查点和产物引用写入本地 SQLite WAL。应用或 utility process 异常退出后，未完成任务恢复为暂停状态；外部副作用不会自动重放。
