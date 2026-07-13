# Privacy Policy — OpenWorkbuddy Chrome Bridge

Last updated: 2026-07-13

OpenWorkbuddy Chrome Bridge connects a tab explicitly selected by the user to the locally installed OpenWorkbuddy desktop application.

- The extension itself communicates only with Chrome and the local Native Messaging host on the same Mac. It does not connect directly to a developer-operated cloud service.
- The desktop application may include content, screenshots, URLs or accessibility/DOM data from an authorized tab in a request to the model provider selected and configured by the user (OpenAI, Anthropic or Kimi/Moonshot) when that data is needed for the user's task.
- Interactions with websites, remote MCP servers and model providers are external network operations. The desktop application applies its permission and approval policy before sensitive submissions or external side effects.
- The extension does not operate a developer cloud service, upload telemetry, sell data, or use browser data for advertising.
- The extension does not request the Chrome cookies permission and does not provide a cookie export operation.
- Existing tabs are inaccessible until the user clicks the extension action on that tab. Tabs created within the bound task inherit that task-scoped grant; unrelated tabs remain inaccessible.
- The desktop application stores local task and audit records until the user removes them, subject to its configured detailed-log retention policy.
- Revoking a tab grant detaches the debugger connection and prevents further task access.

The complete product privacy notice is available at https://github.com/chenin0931/OpenWorkbuddy/blob/main/PRIVACY.md. Support and privacy questions may be filed at https://github.com/chenin0931/OpenWorkbuddy/issues.
