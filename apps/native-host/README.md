# On My WorkBuddy Native Messaging Host

This small Rust process is the bidirectional transport between the Chrome extension and the desktop broker. It does not interpret browser commands, read cookies, or connect to the network.

## Transport

Chrome starts the host with stdin/stdout attached. Chrome Native Messaging uses a 4-byte little-endian unsigned length followed by one UTF-8 JSON value. The Unix socket uses the same framing, so payloads may contain newlines and no delimiter escaping is required.

The socket path is:

1. `ON_MY_WORKBUDDY_SOCKET`, when set; otherwise
2. `~/Library/Application Support/On My WorkBuddy/chrome.sock`.

Frames from Chrome may be at most 64 MiB. Desktop-to-Chrome frames are capped at Chrome's 1 MiB native-host output limit. A disconnect or protocol failure produces a structured `bridge.error` message before the process exits when possible.

## Build, test, and install

```bash
cargo test --manifest-path apps/native-host/Cargo.toml
cargo build --release --manifest-path apps/native-host/Cargo.toml
apps/native-host/scripts/install.sh <extension-id>
```

The install script copies the binary into `~/Library/Application Support/On My WorkBuddy/NativeHost` and writes Chrome's user-level manifest to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.onmyworkbuddy.chrome.json`. The manifest allowlists exactly the supplied extension ID.

To point at a prebuilt binary:

```bash
apps/native-host/scripts/install.sh <extension-id> /absolute/path/to/on-my-workbuddy-native-host
```

Uninstall with:

```bash
apps/native-host/scripts/uninstall.sh
```

Restart the extension after installing or changing the Native Messaging manifest. The desktop app must create and listen on the Unix socket before Chrome connects.
