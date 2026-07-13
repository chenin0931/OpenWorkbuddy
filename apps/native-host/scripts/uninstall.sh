#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.onmyworkbuddy.chrome"
MANIFEST_PATH="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
INSTALL_DIR="${HOME}/Library/Application Support/OpenWorkbuddy/NativeHost"
INSTALLED_BINARY="${INSTALL_DIR}/on-my-workbuddy-native-host"

rm -f "${MANIFEST_PATH}" "${INSTALLED_BINARY}"
rmdir "${INSTALL_DIR}" 2>/dev/null || true
echo "Uninstalled ${HOST_NAME}."
