# Security policy

## Supported version

Security fixes are made against the latest `main` branch. The project is an
early open-source preview and does not currently publish signed production
binaries.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** flow in the Security tab instead
of opening a public issue. Include the affected version, impact, reproduction
steps and a minimal proof of concept. Do not include real API keys, private files
or sensitive browser content.

If private vulnerability reporting is unavailable, open a public issue that
contains no exploit details and asks the maintainer to establish a private
channel.

## Security boundaries

Electron `utilityProcess` provides process and fault isolation; it is not an OS
hard sandbox for approved Shell commands or user-installed stdio MCP servers.
See `docs/security.md` for the complete threat model and documented limitations.
