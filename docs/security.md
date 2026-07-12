# Security model

## 能保证的边界

- Renderer 不直接访问 Node、文件、Key 或原始 IPC。
- 文件工具在授权根目录内执行 realpath 和符号链接检查。
- 模型 Key 使用系统加密存储，工具进程不会继承这些变量。
- 外部副作用与不可逆动作必须审批。
- 工具调用和审批有本地审计记录。

## 不能保证的边界

- 本地 Shell 不是恶意代码沙箱，获批命令仍以当前 macOS 用户运行。
- 用户安装的 stdio MCP server 是本机代码，产品无法阻止它绕过 Agent 的文件工具。
- Chrome `debugger` 权限能力很强；产品按任务约束标签页，但 Chrome 扩展权限本身并非细粒度 OS 隔离。
