# Changelog

## [0.3.0] - 2026-03-18

Batterie-wide consistency pass: docs consolidation, versioning.

## 2026-03-10–11 — Bystander Auto-Resume & AskUser

### Added
- Auto-resume mid-turn sessions at startup without client connection
- AskUserQuestion modal overlay with custom input and recovery chip
- Per-turn SSE byte counter by event type
- `.env` config pattern for deployment

### Fixed
- Bystander auto-resume: persist session state synchronously on shutdown
- Double push notifications: deduplicate by device ID
- iOS auto-zoom on AskUser custom input (16px minimum)

### Changed
- Server sends committed messages with current events (kill client commit logic)
- Streaming overlay excludes content already committed to messages[]

## 2026-03-04–06 — SSE Protocol Redesign

### Added
- Subagent event filtering from parent stdout
- Live stale-client detection via fs.watch (frontend changes without bridge restart)
- CC XML tag and synthetic message documentation

### Changed
- Removed old delta SSE protocol; server is sole authority
- Client consumes text/current/state events directly (killed delta handling)
- Bridge dual-emits new protocol alongside old deltas during transition

### Fixed
- Bridge survives restart without nuking client state
- Text vanishing mid-turn (commit overlay on message boundary)

## 2026-03-02–03 — UI Polish & Streaming Fixes

### Added
- Push-to-talk via Web Speech API (long-press on btn-bar)
- Turn-complete chime (350Hz sine wave)
- Loading state with amber tint during session switch and reconnect
- Table horizontal scroll wrapper for mobile

### Fixed
- Live streaming: new assistant messages after tool calls no longer overwrite previous
- iOS phantom submit (drop Shift+Enter, keep Cmd/Ctrl+Enter)
- Slash command intercept (only catch bridge/local commands, not CC skills)
- CC init hang: `--mcp-config` requires `mcpServers` key in JSON

### Changed
- Switched to `KillMode=control-group` for clean process tree shutdown

## 2026-02-26–28 — Modular Frontend & Upload

### Added
- Extracted client modules: render-utils, render-chips, render-messages, render-chrome
- Drag-and-drop overlay, mockup page
- Slash menu (sorted, searchable), chip Tetris packing
- Upload staging: files as pills below textarea, sent with prompt
- Folder chooser with Now/Previous groups
- Deploy script and early error banner for script load failures
- IIFE wrappers for Safari/WebKit global shadowing fix

### Changed
- Split index.html and bridge.ts along natural seams
- Body-scroll layout migration for Safari full-page screenshots

## 2026-02-24–25 — UX Overhaul

### Added
- Auto-resume interrupted sessions after bridge restart
- MCP config for bridge sessions, thinking chips with expandable reasoning
- Markdown rendering via marked library
- Anthropic palette, coral colour scheme, input bar multiline fix
- Coalesce queued prompts into single delivery
- Share-sheet upload: new folder, deposit, CC spawn, push enrichment

### Fixed
- Grace timer killing CC during active mobile sessions
- Stale handoff causing fresh session instead of resume
- API errors surfaced to mobile UI instead of silent stalling

## 2026-02-18–23 — Push Notifications & Observability

### Added
- Push notifications via Web Push (VAPID), service worker
- Structured observability: event bus, logger, status endpoint
- Session exit: long-press status bar, tap amber/red gauge
- Grace timer waits for turn completion, not just SSE disconnect

### Changed
- Replaced `--dangerously-skip-permissions` with `--allowed-tools` whitelist

## 2026-02-15–16 — Mobile Polish & Notifications

### Added
- Notification system: title badges, favicon dots, SW, manifest
- Build version tracking (vite plugin, bridge check, folder chooser)
- Message queueing and error routing
- Device emulation, fast JPEG screenshots, HMR watch verb
- Orphan reaper: kill orphaned CC processes on bridge restart

### Fixed
- Stale handoff no longer blocks session resume
- Session bleed on reconnect
- Oracle review findings: renotify, push re-subscribe

## 2026-02-11–12 — Image Upload & Lifecycle

### Added
- Image upload: file picker, clipboard paste, drag-and-drop
- Systemd service and deploy script for kube.lan
- Context fuel gauge: status bar, compaction detection
- `<foldable-block>` custom element for unified fold/expand
- Folder dashboard with fun names

### Fixed
- Fixed input bar positioning (position:fixed + measured padding + iOS keyboard meta tag)
- Context gauge uses per-message usage, not cumulative result

## 2026-02-08–10 — Core Bridge

### Added
- WebSocket transport and end-to-end browser-to-bridge-to-CC pipeline
- WebSocket-to-stdio bridge server for Claude Code
- AskUserQuestion intercept as tappable mobile buttons
- Session resume via visibilitychange reconnect + page refresh
- Folder chooser UI, folder lifecycle state machine
- JSONL history replay on session resume
- Idle guards: don't kill CC while it's working
- Vitest framework with ~100 adapter/transport/bridge tests

### Changed
- Vendor pi-web-ui containers, own message renderers

## 2026-02-08 — Initial Release

### Added
- Project scaffold with pi-web-ui and ClaudeCodeAgent adapter
- Empirical verification of Claude Code stream-json protocol
