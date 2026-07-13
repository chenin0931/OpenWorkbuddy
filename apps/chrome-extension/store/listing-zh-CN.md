# OpenWorkbuddy Chrome Bridge

把你明确选择的 Chrome 标签页连接到本机运行的 OpenWorkbuddy 桌面 Agent。

## 单一用途

扩展只负责在用户点击工具栏图标后，将当前标签页通过 Chrome DevTools Protocol 和 Native Messaging 暴露给本机桌面应用。桌面应用不能静默选择其他已有标签页。

## 功能

- 读取已授权标签页的 DOM、无障碍树与截图。
- 在任务授权范围内导航、点击和输入。
- 允许 Agent 新建属于该任务的子标签页。
- 随时从桌面应用或扩展撤销授权。

## 权限说明

- `activeTab`：只在你点击扩展时选择当前标签页。
- `debugger`：通过受限 CDP 命令读取和操作已授权标签页。
- `nativeMessaging`：只与本机 OpenWorkbuddy Native Host 通信。
- `tabs`：识别已授权标签页和由它打开的子标签页。

扩展不申请 `cookies` 权限，不导出 Cookie，不读取未授权的现有标签页，也不向开发者服务器上传遥测。为完成用户交代的工作，桌面应用可能把已授权页面中必要的内容发送给用户自行配置的模型服务商；详情见仓库根目录 `PRIVACY.md`。
