# Folder Lifecycle Simplification

## The Problem

The current folder lifecycle (`src/folder-lifecycle.ts`) is a 4-phase state machine with ~22 transition cases. It tracks two independent concerns as one combined thing, producing combinatorial complexity.

## The Insight

From the user's perspective, there are two independent things:

1. **Folder picker** — open or closed (an overlay)
2. **Session** — connected to a folder or not (underneath)

These are orthogonal. All four combinations are valid:

| Picker | Session | What you see |
|--------|---------|-------------|
| closed | disconnected | Empty app, fresh load |
| open | disconnected | Picking your first folder |
| open | connected | Browsing while Claude works underneath |
| closed | connected | Normal conversation |

## Three Things That Should Be Two

Currently there are three overlapping state models:

1. **Transport** `ConnectionState` — the WS pipe (connecting/lobby/connected/disconnected/error). Drives the green status dot.
2. **Folder lifecycle** `FolderPhase` — 4 phases (idle/browsing/switching/connecting), ~22 transitions.
3. **Status indicator** — driven by #1.

The folder lifecycle does double duty: UI state (picker open/closed) AND transport mechanics (lobby teardown, retries, switching). The status dot and transport are the same concern. Kill the lifecycle as a combined machine, and you have two things:

- **Transport** — pipe status, owns reconnect/lobby/retry mechanics, drives the status dot
- **Picker** — open or closed, which folder did you tap

## Why The Current Model Is Complex

The transition table:

```
Current State    ×  Event              →  New State    + Effects
─────────────       ─────              ─  ─────────      ───────
idle                open_requested     →  browsing       open dialog, list folders
idle                auto_connect       →  connecting     set cwd, connect, timeout
idle                folder_list        →  browsing       open dialog
browsing            folder_selected    →  connecting     reset agent, connect
browsing            folder_selected    →  switching      reset agent, return to lobby
  (in session)
connecting          session_started    →  idle           close dialog, store folder
connecting          lobby_entered      →  connecting     retry (increment counter)
switching           lobby_entered      →  connecting     send connectFolder
...~14 more cases
```

About half deal with transport mechanics (lobby_entered, retry counting, switching→connecting, auto_connect). These are transport concerns wearing UI clothes.

## The Simplified Model

```
pickerOpen: boolean              — is the overlay showing?
session: connected | null        — am I talking to a folder?
pendingConnect: string | null    — loading indicator on a folder row
```

Four behaviours:
- Open picker
- Close picker
- Connect to folder (transport handles the mechanics)
- Disconnect from folder

"User picked a different folder while connected" is not special — it's disconnect + connect. "Connect failed" isn't a transition — session stays null, picker stays open, error shown.

## Where Transport Concerns Move

The transport layer (`ws-transport.ts`) already manages reconnection and backoff. It should also own:

- **Lobby/session protocol** — already partially does this
- **Folder switching** — tear down WS, reconnect through lobby, send connectFolder. The UI says "connect to X", transport figures out how.
- **Retry counting** — internal to transport, not visible to UI state
- **Timeout** — transport-level concern

The UI state says "connect me to folder X" and gets back "done" or "failed, here's why."

## The Layered Architecture

```
UI Components        ← what you see (Lit elements)
      ↓
UI State             ← what should be on screen (picker + session)
      ↓
Transport            ← manages the pipe (ws-transport.ts)
      ↓
 ≈ NETWORK ≈         ← Tailscale/DERP
      ↓
Bridge               ← manages sessions + processes (bridge.ts)
      ↓
CC Process           ← claude -p
```

The phone owns the top three layers. The server owns the bottom two. The folder lifecycle currently reaches from layer 2 into layer 3's concerns. The fix: each layer does its own job and presents a clean interface upward.

## Impact

This simplification should happen before building the dashboard (gdn-hikosa), abort control (gdn-wiruvu), and folder creation (gdn-cahato) — all of which touch picker and session state. Building on the simplified model means those features land cleaner.

## See Also

- Arc item: gdn-picoki
- Bridge protocol: `docs/bridge-protocol.md`
- Current lifecycle: `src/folder-lifecycle.ts`
