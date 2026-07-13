#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.onmyworkbuddy.chrome"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <chrome-extension-id> [native-host-binary]" >&2
  exit 64
fi

EXTENSION_ID="$1"
if [[ ! "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Invalid Chrome extension id: expected 32 characters in the range a-p." >&2
  exit 64
fi

if [[ $# -eq 2 ]]; then
  SOURCE_BINARY="$2"
elif [[ -x "${PROJECT_DIR}/on-my-workbuddy-native-host" ]]; then
  # Layout inside the packaged .app Resources/NativeHost directory.
  SOURCE_BINARY="${PROJECT_DIR}/on-my-workbuddy-native-host"
else
  SOURCE_BINARY="${PROJECT_DIR}/target/release/on-my-workbuddy-native-host"
fi
if [[ ! -x "${SOURCE_BINARY}" ]]; then
  echo "Native host binary not found; building release binary..." >&2
  cargo build --release --manifest-path "${PROJECT_DIR}/Cargo.toml"
fi

APP_SUPPORT="${HOME}/Library/Application Support/OpenWorkbuddy"
INSTALL_DIR="${APP_SUPPORT}/NativeHost"
INSTALLED_BINARY="${INSTALL_DIR}/on-my-workbuddy-native-host"
MANIFEST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="${MANIFEST_DIR}/${HOST_NAME}.json"
if [[ -f "${PROJECT_DIR}/manifests/${HOST_NAME}.json.template" ]]; then
  TEMPLATE_PATH="${PROJECT_DIR}/manifests/${HOST_NAME}.json.template"
else
  TEMPLATE_PATH="${PROJECT_DIR}/native-messaging-host/${HOST_NAME}.json.template"
fi

mkdir -p "${INSTALL_DIR}" "${MANIFEST_DIR}"
install -m 755 "${SOURCE_BINARY}" "${INSTALLED_BINARY}"

ESCAPED_BINARY="${INSTALLED_BINARY//\\/\\\\}"
ESCAPED_BINARY="${ESCAPED_BINARY//&/\\&}"
ESCAPED_BINARY="${ESCAPED_BINARY//|/\\|}"
/usr/bin/sed \
  -e "s|__HOST_BINARY__|${ESCAPED_BINARY}|g" \
  -e "s|__EXTENSION_ID__|${EXTENSION_ID}|g" \
  "${TEMPLATE_PATH}" > "${MANIFEST_PATH}"
chmod 644 "${MANIFEST_PATH}"

echo "Installed ${HOST_NAME} for Chrome extension ${EXTENSION_ID}."
echo "Manifest: ${MANIFEST_PATH}"
echo "Binary:   ${INSTALLED_BINARY}"
