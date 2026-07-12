# On My WorkBuddy Chrome Bridge

This Manifest V3 extension connects only a tab that the user explicitly selects by clicking the extension action. The desktop process cannot bind an arbitrary existing tab. Tabs created by the agent's `openTab` command, or immediately produced by an agent click, inherit that tab's grant; unrelated popups and all other browser tabs remain invisible to `tabs.list` and inaccessible to CDP commands.

The extension requests `activeTab`, `tabs`, `debugger`, and `nativeMessaging`. It deliberately does not request the `cookies` permission and has no cookie export command.

## Build and load

```bash
pnpm --filter @onmyworkbuddy/chrome-extension build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/chrome-extension`. Copy the resulting extension ID, then install the Native Messaging manifest as described in `../native-host/README.md`.

After installation, open an `http` or `https` page and click the extension action. The badge changes to `ON`; the desktop app may then issue `bind` with a `taskId`. Chrome internal pages, `file:`, `data:`, and `javascript:` URLs are rejected.

## Native JSON protocol

Desktop-to-extension requests have this shape:

```json
{
  "requestId": "unique-id",
  "command": "dom",
  "params": { "taskId": "run-id", "tabId": 123 }
}
```

Responses are `{ "type": "response", "requestId": "...", "ok": true, "data": ... }`, or the same envelope with `ok: false` and a structured `error`. User actions and disconnects are sent as `{ "type": "event", "event": "tab.userAuthorized", "data": ... }`.

Commands:

- `tabs.list`: returns only user-authorized tabs, optionally filtered by `taskId`.
- `bind`: binds the most recently user-selected grant (or a supplied `grantId`) to a `taskId`; it cannot authorize a new tab.
- `snapshot`: CDP `DOMSnapshot.captureSnapshot`.
- `dom`: CDP `DOM.getDocument`.
- `ax`: CDP `Accessibility.getFullAXTree`.
- `screenshot`: visible-viewport PNG/JPEG/WebP capture; JPEG 80 is the default.
- `navigate`: absolute `http(s)` or `about:blank` only.
- `click`: CSS `selector`, or both `x` and `y`.
- `type`: optional CSS `selector`, required `text`, optional `clear`.
- `openTab`: creates a child tab inside the same grant.
- `detach`: revokes a child tab or, for the root tab/default `all`, the entire grant.

The desktop broker remains responsible for approval policy. In particular, it must approve sensitive typing, uploads, form submissions, purchases, sends, and deletes before sending a bridge command.
