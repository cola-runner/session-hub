#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT="${CODEX_HISTORY_INSTALL_ROOT:-$HOME/.codex-history-manager}"
BIN_DIR="${CODEX_HISTORY_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER_PATH="${BIN_DIR}/codex-history"
LEGACY_LAUNCHER_PATH="${BIN_DIR}/codex-session-tool"

assert_safe_install_root() {
  local target="${1%/}"
  if [[ -z "$target" ]]; then
    target="/"
  fi

  if [[ "$target" == "/" || "$target" == "$HOME" ]]; then
    echo "Refusing unsafe install root: $1" >&2
    echo "Use a dedicated directory such as ~/.codex-history-manager" >&2
    exit 1
  fi
}

assert_safe_install_root "$INSTALL_ROOT"

if [[ -f "$LAUNCHER_PATH" ]]; then
  rm -f "$LAUNCHER_PATH"
  echo "Removed launcher: $LAUNCHER_PATH"
else
  echo "Launcher not found: $LAUNCHER_PATH"
fi

if [[ -f "$LEGACY_LAUNCHER_PATH" ]]; then
  rm -f "$LEGACY_LAUNCHER_PATH"
  echo "Removed legacy launcher: $LEGACY_LAUNCHER_PATH"
fi

if [[ -d "$INSTALL_ROOT" ]]; then
  rm -rf "$INSTALL_ROOT"
  echo "Removed install directory: $INSTALL_ROOT"
else
  echo "Install directory not found: $INSTALL_ROOT"
fi

echo "Codex local data was kept: ~/.codex and ~/.codex-trash"
