# Codex History Manager Plan

## Goal
Build a local-first tool that lets Codex users batch-manage conversation history and archived history from `~/.codex`, with a safe trash-based delete flow and automatic expiration cleanup.

## Scope (Current)
1. CLI commands:
   - `codex-history start`
   - `codex-history cleanup`
   - `codex-history install`
   - `codex-history uninstall`
2. Data loading:
   - Read active and archived history from `~/.codex`.
   - Allow overriding home path via `--codex-home`.
3. Web UI:
   - Separate Active / Archived / Trash tabs.
   - Multi-select, select-all-filtered, batch actions.
4. Batch actions:
   - Archive selected active items.
   - Unarchive selected archived items.
   - Move selected items to trash (soft delete).
5. Trash lifecycle:
   - Restore, permanent delete, and auto-clean by `retention-days`.
6. Title resolution:
   - Prefer Desktop summary title from `.codex-global-state.json`.
   - Fallback to first meaningful user message in rollout file.
7. Distribution:
   - Local launcher install/uninstall.
   - `curl` installer/uninstaller scripts.
   - Homebrew formula template for tap publishing.

## Out of Scope (for now)
1. Authentication and remote access.
2. Cloud sync.
3. Full-text search index.
4. Windows-specific native packaging.

## Acceptance Criteria
1. Running `codex-history start` launches local UI.
2. Active/Archived are separated to reduce confusion.
3. Batch archive/unarchive/delete works with report summary.
4. Delete goes to trash first, not immediate hard delete.
5. Trash supports restore and permanent delete.
6. Expired trash is auto-cleaned at startup.
7. README documents install and safety behavior.

## Status
1. [x] Core CLI + HTTP API + web UI implemented.
2. [x] Active/Archived/Trash split and batch operations implemented.
3. [x] Desktop summary title integration implemented.
4. [x] Soft-delete trash lifecycle implemented.
5. [x] Custom in-app confirmation modal implemented.
6. [x] `curl` install/uninstall scripts prepared.
7. [x] Homebrew formula template prepared.
