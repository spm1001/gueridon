> **Staleness note (2026-02):** Implementation section references `ws-transport.ts` and `main.ts` — both deleted. The decision (single connection path, no `?session=` URL param) still holds and is implemented in the current SSE+POST transport.

# Single Connection Path Decision (2026-02-10)

## Context

Guéridon had two WebSocket connection paths:

1. **Lobby path:** Client connects plain → gets `lobbyConnected` → sends `connectFolder` with folder path → bridge resolves session from filesystem → `connected` + buffer replay.
2. **`?session=` path:** Client appends session ID to URL → bridge looks up session by ID → `connected` + buffer replay. Used for reconnects after WS drops.

## Problem

The `?session=` path bypassed `connectFolder`, creating sessions with `folder: null`. This caused three bugs:

1. **CC spawned with no cwd on bridge restart.** If the bridge restarted and a client reconnected with `?session=`, the bridge created a new session with `folder: null`. When CC needed spawning, `spawnCC` got no cwd and CC inherited the bridge's working directory — wrong project, wrong CLAUDE.md.

2. **Session invisible to folder lookup.** `connectFolder` finds existing sessions by `s.folder === folderPath`. Sessions with `folder: null` are invisible — the bridge creates a duplicate fresh session for the same folder.

3. **Lost conversation history.** The combination: bridge restart → `?session=` creates `folder: null` session → new `connectFolder` can't find it → fresh session ID → old JSONL not loaded → empty screen.

Diagnosed from kube bridge logs (2026-02-10) showing repeated `(legacy ?session= path)` reconnections after DERP relay disconnects on cellular.

## The Chesterton's Fence Question

Why did `?session=` exist? Speed. It skipped the lobby round-trip and async filesystem reads:

| Path | Steps |
|------|-------|
| `?session=` | WS open → Map lookup (μs) → connected |
| Lobby | WS open → lobbyConnected → client sends connectFolder → scanFolders + getLatestSession + getLatestHandoff (filesystem) → connected |

Estimated difference: ~200ms on cellular via DERP relay.

But the lobby path is already the **first-load experience** — every initial connection goes through it without complaint. If it's acceptable for the first connection, it's acceptable for a reconnect.

The messageBuffer mechanism (which captures all CC events and replays them synchronously on attach) provides the same event-safety guarantee regardless of connection path. There is no window for missed events in either case.

## Decision

Remove `?session=` entirely. Single connection path: all connections start in lobby.

## Implementation

**Transport (`ws-transport.ts`):**
- Stores `folderPath` when `connectFolder()` is called
- `doConnect()` always connects with plain URL (no query params)
- On `lobbyConnected`: if `folderPath` is set, auto-sends `connectFolder` (transparent reconnect); otherwise fires `onLobbyConnected` callback for lobby UI
- `returnToLobby()` clears `folderPath`
- Error during auto-connectFolder falls back to lobby (clears `folderPath`, fires `onLobbyConnected`)

**Bridge (`bridge.ts`):**
- Connection handler only has lobby path (40 lines removed)
- `Session.folder` is now `string` (was `string | null`)
- `spawnCC` requires `cwd` (was optional)

**Interaction with `main.ts` auto_connect:**
- Transport's auto-reconnect suppresses `onLobbyConnected` (has stored folder)
- `main.ts`'s `onLobbyConnected` handler (localStorage auto_connect) only fires on first load or after `returnToLobby`
- No double-send: the two mechanisms are mutually exclusive

## Trade-offs

| Gained | Lost |
|--------|------|
| `folder` always set — no null guard paths | ~200ms reconnect latency (same as first-load) |
| Sessions always findable by folder | Must deploy client + bridge together (old client sends `?session=`, new bridge ignores it) |
| Bridge restart recovers cleanly via JSONL | — |
| Single code path to maintain | — |
