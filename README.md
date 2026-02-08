# Codex History Manager

A local web tool for batch-managing Codex conversation history.

> Prerequisite: Node.js 18+ must be installed on the machine before running the installer.

It helps you:
- browse active and archived sessions
- batch archive and unarchive
- soft-delete sessions to trash
- restore or permanently purge trash items
- auto-clean expired trash on startup
- hide system-generated sessions automatically

This is a community utility and is not affiliated with OpenAI.

## Quick Start

Before you start, verify Node is available:

```bash
node -v
```

### 1) Install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/cola-runner/session-hub/main/scripts/install.sh | bash
```

### 2) Start the app

```bash
codex-history start
```

This starts a local server and opens the web UI.

### 3) Manage sessions

Use the tabs in the UI:
- `Active`: archive or move sessions to trash
- `Archived`: unarchive or move to trash
- `Trash`: restore or permanently delete

## Requirements

- Node.js 18+ (or newer)
- `curl` and `tar` for one-line installer

## Default Paths

| Item | Default |
| --- | --- |
| Codex home | `~/.codex` |
| Active sessions | `~/.codex/sessions` |
| Archived sessions | `~/.codex/archived_sessions` |
| Trash root | `~/.codex-trash` |
| Local install dir | `~/.codex-history-manager` |
| Launcher path | `~/.local/bin/codex-history` |

## CLI Usage

```bash
codex-history start [--codex-home PATH] [--trash-root PATH] [--retention-days N] [--port N] [--no-open]
codex-history cleanup [--codex-home PATH] [--trash-root PATH] [--retention-days N]
codex-history install [--bin-dir PATH]
codex-history uninstall [--bin-dir PATH]
```

### `start` flags

| Flag | Description | Default |
| --- | --- | --- |
| `--codex-home` | Codex data directory | `~/.codex` |
| `--trash-root` | Soft-delete storage root | `~/.codex-trash` |
| `--retention-days` | Trash retention window | `30` |
| `--port` | HTTP port (`0` = random free port) | `0` |
| `--no-open` | Do not auto-open browser | `false` |

Example:

```bash
codex-history start \
  --codex-home ~/.codex \
  --trash-root ~/.codex-trash \
  --retention-days 30 \
  --port 3789 \
  --no-open
```

### Run cleanup only

```bash
codex-history cleanup --retention-days 30
```

## Install Options

### A) One-line installer (GitHub)

```bash
curl -fsSL https://raw.githubusercontent.com/cola-runner/session-hub/main/scripts/install.sh | bash
```

Optional install variables:

```bash
CODEX_HISTORY_REPO=<owner/repo> \
CODEX_HISTORY_REF=main \
CODEX_HISTORY_BIN_DIR="$HOME/.local/bin" \
CODEX_HISTORY_INSTALL_ROOT="$HOME/.codex-history-manager" \
bash scripts/install.sh
```

Note: installer refuses unsafe install roots like `/` and `$HOME`.

### B) Install from local source

```bash
node src/cli.js install
```

### C) Homebrew

Use `packaging/homebrew/codex-history.rb` as the formula template when publishing a tap.

## Uninstall

One-line:

```bash
curl -fsSL https://raw.githubusercontent.com/cola-runner/session-hub/main/scripts/uninstall.sh | bash
```

Local:

```bash
node src/cli.js uninstall
```

## Safety

- binds to `127.0.0.1` only (local machine)
- no remote upload of session contents
- delete is soft by default (trash-first)
- permanent delete requires explicit action

## Development

```bash
npm test
```
