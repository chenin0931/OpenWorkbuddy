# Third-party notices

OpenWorkbuddy is released under the MIT License. It depends on third-party
open-source software that remains under its respective license.

Key runtime dependencies include:

| Component | License | Project |
| --- | --- | --- |
| Pi Agent Core / Pi AI | MIT | https://github.com/earendil-works/pi |
| Model Context Protocol TypeScript SDK | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Phosphor Icons | MIT | https://github.com/phosphor-icons/react |
| React / React DOM | MIT | https://github.com/facebook/react |
| Electron | MIT | https://github.com/electron/electron |
| better-sqlite3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| Croner | MIT | https://github.com/Hexagon/croner |
| fast-diff | Apache-2.0 | https://github.com/jhchen/fast-diff |
| react-markdown / remark-gfm | MIT | https://github.com/remarkjs/react-markdown |
| Zod | MIT | https://github.com/colinhacks/zod |
| Zustand | MIT | https://github.com/pmndrs/zustand |

The exact resolved dependency graph is recorded in `pnpm-lock.yaml` and
`apps/native-host/Cargo.lock`. A machine-readable inventory can be generated
with:

```bash
corepack pnpm licenses list --prod --json
```

Electron distributions also include Chromium's generated third-party license
notices. Before publishing signed binary releases, maintainers must verify that
the packaged application contains the notices required by the exact resolved
dependency set.
