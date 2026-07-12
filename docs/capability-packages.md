# Local capability packages

A package is a user-selected local directory with a strict `workbuddy-package.json`:

```json
{
  "name": "personal-research",
  "version": "1.0.0",
  "skills": ["skills/research"],
  "mcp": ["mcp/local-docs.json"],
  "rules": ["rules/research.md"],
  "templates": ["templates/report.md"]
}
```

Paths are forward-slash relative paths inside the package. A declared Skill is a directory containing `SKILL.md`. Each MCP file uses the same secret-free shape as the desktop MCP form:

```json
{
  "name": "Local docs",
  "enabled": true,
  "toolNamespace": "local_docs",
  "transport": {
    "type": "stdio",
    "command": "/absolute/path/to/server",
    "args": ["--stdio"],
    "envKeys": []
  }
}
```

HTTP packages use `type: "streamable_http"`, an HTTPS `url`, an `auth` value, and `secretConfigured: false`. Packages cannot include secrets; configure Bearer/Header/OAuth material after installation through the encrypted desktop settings.

Before confirmation the app recursively scans the entire package, rejects symlinks, traversal, non-regular files, unsafe JSON, over-limit content and all `.js`/`.cjs`/`.mjs` files. The review card exposes MCP commands and environment declarations. Installation copies Skills and templates into managed local storage, registers MCP entries without starting them, and appends package rules to the selected workspace.
