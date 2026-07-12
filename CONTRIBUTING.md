# Contributing

Thanks for helping improve On My WorkBuddy.

## Before opening a change

- Use an issue for bugs, product proposals or behavior changes that affect the
  permission model.
- Never include API keys, local databases, audit exports, browser captures or
  personal workspace content in an issue, test fixture or commit.
- Keep the product local-first and BYOK. New accounts, cloud sync, telemetry or
  remote control surfaces require an explicit architecture decision.

## Development setup

Requirements: macOS, Node.js 24, pnpm 10.28, Rust stable and Google Chrome for
Chrome Bridge testing.

```bash
corepack pnpm install
corepack pnpm dev
```

## Required checks

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
cargo test --manifest-path apps/native-host/Cargo.toml --locked
corepack pnpm build
```

Run `corepack pnpm test:e2e` for changes to Electron IPC, security boundaries,
the work timeline, approvals, Chrome behavior or release packaging.

## Architecture rules

- Pi is the replaceable Agent Loop, not the security boundary.
- Model tool requests must pass through the Main-process Broker before execution.
- The Renderer must not receive raw secrets, Node access or unrestricted IPC.
- Keep versioned Zod contracts at every process boundary.
- Preserve workspace path checks, stale-write protection, non-replay rules,
  approval semantics and recovery behavior.
- UI changes should follow `docs/design-system.md` and expose internal execution
  detail progressively rather than by default.

By submitting a contribution, you agree that it is licensed under the MIT
License included in this repository.
