#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_HISTORY_REPO:-cola-runner/session-hub}"
REF="${CODEX_HISTORY_REF:-main}"
TARBALL_URL="${CODEX_HISTORY_TARBALL_URL:-https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz}"
INSTALL_ROOT="${CODEX_HISTORY_INSTALL_ROOT:-$HOME/.codex-history-manager}"
BIN_DIR="${CODEX_HISTORY_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER_PATH="${BIN_DIR}/codex-history"

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

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

require_command curl
require_command tar
require_command node
require_command mktemp
assert_safe_install_root "$INSTALL_ROOT"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "Downloading ${TARBALL_URL}"
curl -fsSL "$TARBALL_URL" -o "$tmp_dir/codex-history-manager.tar.gz"

tar -xzf "$tmp_dir/codex-history-manager.tar.gz" -C "$tmp_dir"

source_dir="$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "$source_dir" ]]; then
  echo "Failed to locate extracted project directory" >&2
  exit 1
fi

rm -rf "$INSTALL_ROOT"
mkdir -p "$(dirname "$INSTALL_ROOT")"
mv "$source_dir" "$INSTALL_ROOT"

mkdir -p "$BIN_DIR"
cat > "$LAUNCHER_PATH" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
node "$INSTALL_ROOT/src/cli.js" "\$@"
LAUNCHER
chmod +x "$LAUNCHER_PATH"

echo "Installed project to: $INSTALL_ROOT"
echo "Installed launcher: $LAUNCHER_PATH"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "PATH does not include $BIN_DIR"
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi

echo
echo "Start with: codex-history start"
