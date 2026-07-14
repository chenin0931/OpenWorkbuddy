# OpenWorkbuddy

OpenWorkbuddy is a local-first macOS desktop agent for real work: files,
Shell, the web, an existing Chrome session, MCP, Skills, Memory and scheduled
automations. It is designed as a recoverable workbench with explicit permission
boundaries rather than a chat wrapper.

> **Project status:** early open-source preview. The current local artifact is
> an unsigned Intel macOS build. Signed, notarized and universal releases require
> maintainer-provided Apple Developer credentials and are not published yet.

## Product principles

- **Local-first and BYOK.** Structured state, tools and audit data live on the
  Mac. Users connect their own OpenAI, Anthropic or Kimi/Moonshot API key.
- **Model intent is not authority.** Every external action becomes a structured
  tool request that is validated and, when necessary, presented for approval.
- **Recoverable by design.** Work state, tool receipts and checkpoints survive
  app and worker restarts.
- **Evidence over celebration.** Diffs, checks, sources and outputs are shown as
  result evidence; ordinary completion does not generate a success dashboard.
- **No developer account, cloud sync or telemetry.** Network requests still occur
  when users call a model, search/fetch the web, use remote MCP or act on a site.
  See [PRIVACY.md](PRIVACY.md).

## What it includes

- OpenAI, Anthropic and Kimi/Moonshot model profiles with replaceable BYOK keys.
- Permissioned file access, stale-write protection, snapshots, Diff and undo.
- Per-work access switch beside “Add files”: keep the project boundary and
  request approval, or explicitly grant full-disk local access for that work.
- The access choice is made in each work composer, persists with that work and
  does not create a broad global default. External, destructive and irreversible
  actions stay behind approval in either mode.
- Shell execution with a strict read-only allowlist and deterministic risk policy.
- Cursor-based managed processes for long-running commands, with timeout,
  cancellation, crash interruption and Artifact-backed logs.
- Web Search and safe Web Fetch with redirect, address and response-size checks.
- MCP stdio and Streamable HTTP, encrypted secrets and OAuth PKCE.
- Progressive Skill loading, confirmed Memory and local capability packages.
- Chrome Manifest V3 bridge with explicit task-scoped tab binding.
- Local sub-agents, schedules, crash recovery, audit export and macOS notifications.
- Ordered Context Pipeline, provider-neutral tool-receipt integrity checks,
  hierarchical Trace and SHA-256-chained audit entries.
- Sandboxed Markdown-to-PDF export with automatic output registration.
- Quiet Workbench UI with grouped work turns, collapsed activity and a persistent
  artifact shelf for outputs, screenshots and file changes.

## Architecture

```text
React Renderer (sandboxed, no Node or secrets)
    │ versioned preload API + Zod validation
    ▼
Electron Main / product Harness
    ├── Run Coordinator, Context, Memory, Skills, Automation
    ├── Tool Broker, risk policy, approvals, audit
    ├── SQLite WAL, safeStorage, Artifact Store
    ├── Agent Host utilityProcess ── Pi Agent Loop ── model APIs
    ├── Tool Runner utilityProcess ── files / Shell / Web / MCP
    └── Unix socket ── Rust Native Host ── Chrome extension
```

The Agent Loop uses MIT-licensed `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` for model streaming, tool turns, steering, cancellation
and provider abstraction. OpenWorkbuddy keeps credentials, permissions,
approval grants, state, tools and recovery in its own Harness. Pi is not treated
as a security boundary.

Read [the architecture overview](docs/architecture.md),
[the Context and Harness Engineering design](docs/context-and-harness-engineering.md),
[the Pi decision record](docs/adr-001-pi-agent-core.md) and
[the security model](docs/security.md) for the detailed boundaries.

## Repository layout

```text
apps/desktop          Electron, React, Main Harness, Agent Host, Tool Runner
apps/chrome-extension Chrome MV3 tab bridge
apps/native-host      Rust Native Messaging ↔ Unix socket bridge
packages/contracts    Versioned TypeScript and Zod process contracts
packages/core         Policy, state machine, path guard and verification logic
```

## Requirements

- macOS 14 or later
- Node.js 24
- pnpm 10.28 (`corepack` recommended)
- Rust stable
- Google Chrome for optional Chrome Bridge development

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

On first launch, add an OpenAI, Anthropic or Kimi/Moonshot API key and authorize
a workspace. Keys are system-encrypted and are not returned to the Renderer.
Kimi protocol details and the opt-in online smoke test are documented in
[docs/kimi.md](docs/kimi.md).

## Verification

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
cargo test --manifest-path apps/native-host/Cargo.toml --locked
corepack pnpm build
corepack pnpm test:e2e
```

The test suite covers provider event conversion, policy classification, path
guards, persistence and crash recovery, tool cancellation, approvals, Chrome tab
authority, WorkTurn aggregation, accessibility and fixed visual scenarios.

## Local packaging

```bash
corepack pnpm package:mac
```

Without a Developer ID this produces unsigned x64 `.app`, `.dmg` and `.zip`
artifacts plus a Chrome extension ZIP under the ignored `outputs/` directory.
Do not redistribute unsigned development builds as trusted production releases.
See [docs/release.md](docs/release.md) for the signing/notarization pipeline and
the Chrome/Native Host READMEs for local bridge installation.

## Security and privacy

- The Renderer has no Node integration, model key or filesystem authority.
- Model tool requests must pass through Main-process policy and approval checks.
- File access uses real-path, symlink and path-traversal checks. Full-disk mode
  is explicit, persisted per work and still subject to macOS privacy controls.
- Approved Shell commands and user-installed stdio MCP servers are local code;
  Electron utility processes are not an OS hard sandbox.
- Authorized browser or file content may be sent to the user's configured model
  provider when required for the task.

Please report vulnerabilities through the process in
[.github/SECURITY.md](.github/SECURITY.md), not a public exploit report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes to permissions, execution,
credential flow or recovery require corresponding contract and regression tests.

## License and trademarks

The project source is licensed under the [MIT License](LICENSE). Third-party
software remains under its respective license; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

OpenAI, Anthropic, Kimi/Moonshot, Chrome, macOS and other names are trademarks
of their respective owners. This independent project is not endorsed by those
companies.
