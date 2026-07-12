# Kimi K2.7 Code 接入说明

On My WorkBuddy 将 Kimi 作为独立 Provider `moonshotai-cn` 接入，默认模型为 `kimi-k2.7-code`。它使用 Moonshot 官方中国区 API `https://api.moonshot.cn/v1`，不允许用户把该 Profile 指向任意 OpenAI-compatible 地址。

## 运行边界

- 协议：OpenAI Chat Completions `/v1/chat/completions`，不是 OpenAI Responses API。
- 模型：`kimi-k2.7-code`，256K 上下文；产品把单轮输出预算限制为 32K。
- 思考：模型只支持思考模式。Agent Host 不发送关闭思考的参数，并在多轮工具调用时保留 API 返回的 `reasoning_content`。
- 参数：不主动设置 `temperature`、`top_p`、`n`、`presence_penalty` 或 `frequency_penalty`，避免违反 K2.7 的固定值约束。
- 工具：只使用 `tools` / `tool_calls` 和 `tool_choice=auto`。Kimi 不支持 `tool_choice=required`；需要工具的任务由提示契约、工具回执与完成门禁共同验证。
- Cache：任务 ID 作为稳定的 `prompt_cache_key`；不发送 Kimi 文档没有声明的 OpenAI cache-retention 扩展。
- Usage：流式结束块可能同时在标准位置和 choice 中出现 usage，Pi Adapter 以最后一次完整快照覆盖，应用不会重复累加同一轮 token。

## Key 与错误处理

API Key 沿用现有安全路径：Renderer 只能提交，Main 使用 Electron `safeStorage` 加密后写入 SQLite BLOB；运行时临时解密并通过版本化内部 IPC 交给 Agent Host 的内存 Credential Store。Key 不进入 Tool Runner、模型上下文、审计摘要或诊断包。

认证失败和参数错误不会自动重试；429、网络错误与 5xx 才可标记为可重试。公开错误在跨进程或 UI 边界前会按运行时已知值和常见 Key/Bearer 形态二次脱敏。

## 显式在线冒烟测试

该测试不属于默认 CI，也不会写入应用数据库：

```bash
pnpm test:online:kimi
```

脚本只从交互式、隐藏回显的 stdin 读取 Key，使用随机 nonce 完成两轮 `echo_nonce` 工具调用，并验证：模型连接、工具参数、`reasoning_content` 回传、最终结果和 usage。输出只包含成功状态、延迟和 token 数，不包含提示正文、模型思考或 Key。

需要同时验证 Electron `safeStorage → SQLite 密文 → Main → Agent Host` 完整路径时，在完成普通单元测试后运行：

```bash
pnpm test:online:kimi:app
```

该命令会为 Electron ABI 重建本地 SQLite 模块，创建隔离的临时 `userData`，通过真实 preload API 保存并测试 Profile，关闭应用后删除整个临时目录。它不启用 Playwright trace、截图、录像或 HAR。

参考：

- <https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart>
- <https://platform.kimi.com/docs/api/chat>
- <https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi>
