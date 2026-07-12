# Release guide

Local development produces an unsigned Intel build because this machine has no Developer ID identity:

```bash
pnpm package:mac
```

The release workflow builds a universal Rust Native Host, a universal Electron application, signs with Developer ID, enables Hardened Runtime, notarizes with Apple, and uploads the DMG/ZIP plus Chrome extension ZIP. Configure these repository secrets before running a tagged release:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `WORKBUDDY_UPDATE_FEED_URL`（稳定 HTTPS Squirrel.Mac feed；可暂不设置）

The Chrome Web Store is a separate release. Follow `apps/chrome-extension/store/submission-checklist.md`; its final extension ID must be passed to the packaged Native Host install script.

The app contains an automatic-update client, but it is hard-disabled for development, unsigned, non-macOS, missing-feed and non-HTTPS builds. The release workflow writes `WORKBUDDY_UPDATE_FEED_URL` into signed package metadata when configured. Publish the signed/notarized ZIP and Squirrel.Mac feed metadata at that stable HTTPS URL; unsigned local builds never contact it.
