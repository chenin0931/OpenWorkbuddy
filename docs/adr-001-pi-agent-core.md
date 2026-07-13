# ADR-001: Use Pi as the Agent Loop, not as the security boundary

Status: accepted for v0.1

## Decision

Use `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.80.6 for the stateful model/tool loop, streaming events, steering, cancellation and provider abstraction.

Keep the following in OpenWorkbuddy's own Electron main-process Harness:

- model profile snapshots and encrypted credentials;
- policy classification, approval grants and non-replay rules;
- workspace path authorization, stale-write checks, snapshots and file leases;
- SQLite state, audit, Memory admission and automation scheduling;
- MCP configuration/OAuth, Chrome tab grants and Native Messaging;
- completion gates, crash recovery and user notifications.

Pi runs in an Electron `utilityProcess`. It receives only the tools selected for a run and cannot access the Renderer or the Keychain directly. Tool requests must return through the main-process Broker before the independent Tool Runner receives them.

## Why

Pi is small enough to act as a replaceable loop kernel and already models the event lifecycle needed by the product. Reimplementing streaming tool turns, provider event normalization, cancellation and steering would add risk without improving the product's differentiating Harness.

Pi deliberately does not provide a complete desktop permission system. Treating it as one would collapse the distinction between model intent and host authorization. The application therefore never trusts a tool request merely because Pi emitted it.

## Consequences

- OpenAI and Anthropic use Pi's provider packages; the original AI SDK dependencies are not included.
- A future loop replacement is possible behind the versioned Agent Host IPC contract.
- Pi and the Harness must be evaluated together whenever the model/provider or loop package changes.
- Pi upgrades require contract, cancellation, tool-result and retry regression tests before release.

References: [Pi repository](https://github.com/earendil-works/pi), [Pi package migration announcement](https://pi.dev/news/2026/5/7/pi-has-a-new-home).
