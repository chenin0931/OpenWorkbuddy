# Architecture

OpenWorkbuddy 使用四个运行边界：沙箱化 Renderer、Electron Main 权限代理、Agent Host、Tool Runner。Chrome 通过单独扩展和 Native Messaging 连接。

所有模型建议的外部动作都先成为 `ToolCall`，再由 Main 进程执行策略判断、等待审批、委托 Runner，并把可观察结果送回 Agent Host。模型不能直接批准自己的动作。

Agent Host 使用 `@earendil-works/pi-agent-core` 负责状态化工具循环、事件流、steering 与取消，使用 `@earendil-works/pi-ai` 连接 OpenAI、Anthropic 与 Kimi/Moonshot。Kimi 走独立的 `moonshotai-cn` Provider 和 OpenAI Chat Completions 兼容协议，不会被当作 OpenAI Responses API。Pi 不承担权限边界；其工具回调只负责把请求交给 Main Broker，最终许可和执行仍在宿主进程。

SQLite 是 canonical state store；每个模型、工具、审批、任务和自动化事件以 append-only `RunEvent` 保存，同时维护便于 UI 查询的物化表。

更完整的控制系统设计见 [Context Engineering and Harness Engineering](context-and-harness-engineering.md)，其中包括上下文编译、渐进式能力加载、70% Checkpoint、风险策略、审批、验证门禁和崩溃恢复。
