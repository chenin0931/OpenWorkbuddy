#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${ROOT_DIR}/apps/native-host/Cargo.toml"
TARGET_ROOT="${ROOT_DIR}/apps/native-host/target"

rustup target add x86_64-apple-darwin aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin --manifest-path "${MANIFEST}"
cargo build --release --target aarch64-apple-darwin --manifest-path "${MANIFEST}"
mkdir -p "${TARGET_ROOT}/release"
lipo -create \
  "${TARGET_ROOT}/x86_64-apple-darwin/release/on-my-workbuddy-native-host" \
  "${TARGET_ROOT}/aarch64-apple-darwin/release/on-my-workbuddy-native-host" \
  -output "${TARGET_ROOT}/release/on-my-workbuddy-native-host"
lipo -info "${TARGET_ROOT}/release/on-my-workbuddy-native-host"
