# Privacy

Last updated: 2026-07-13

OpenWorkbuddy is a local-first desktop application. It does not require a
developer-operated account and does not provide developer-operated cloud sync,
analytics or telemetry.

## Data stored on the Mac

- Workspaces, runs, messages, approvals, audit events, Memory entries, Skills,
  MCP configuration and automation state are stored in a local SQLite database.
- Attachments, file snapshots, diffs and large tool results are stored in the
  local Artifact Store.
- Model and MCP secrets are encrypted with Electron `safeStorage`, backed by
  the macOS system credential facilities when available.
- Detailed local logs are subject to the retention settings in the app. Runs,
  confirmed Memory and final artifacts remain until the user removes them.

## When data leaves the Mac

The application performs network operations only as needed for a user-requested
feature. Depending on the task and the user's configuration:

- prompts, selected context and relevant tool results may be sent to the user's
  configured OpenAI, Anthropic or Kimi/Moonshot model API;
- built-in web-search queries are sent to Bing's web result endpoint, and Web
  Fetch connects to the requested source website;
- calls to a remote MCP server send the arguments shown by the app to that
  server;
- browser navigation and form actions communicate with the destination website;
- an authorized Chrome tab's URL, screenshot, DOM or accessibility content may
  be included in model context when required to perform the task;
- signed production builds may contact a configured HTTPS update feed. Unsigned
  development builds keep automatic updates disabled.

API keys are used to authenticate to the selected service. They are not exposed
to the Renderer, normal tool environment, model prompt or exported audit bundle.

## Chrome Bridge

The Chrome extension connects only to the local Native Messaging host. A tab is
not available until the user explicitly binds it, and unrelated existing tabs
remain inaccessible. The extension does not request cookie access or implement
cookie export. Data received from an authorized tab is governed by the desktop
application behavior described above.

## User controls

Users can revoke Chrome tab grants, disable or delete Memory, and remove MCP or
model configuration in the app. The current preview does not yet provide a
complete per-run and per-artifact deletion UI. To erase all locally stored runs,
artifacts and audit data, quit the application and remove its Application
Support data through macOS. High-risk and external-side-effect actions are
presented for approval according to the app's policy.

Privacy questions and corrections can be submitted at
https://github.com/chenin0931/OpenWorkbuddy/issues. Please do not include API
keys, private files or sensitive page content in a public issue.
