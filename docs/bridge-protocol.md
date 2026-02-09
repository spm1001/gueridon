# Bridge Protocol

WebSocket protocol between browser and bridge server (`server/bridge.ts`).

## Overview

```
Browser ←→ WebSocket ←→ Bridge ←→ claude -p (stdin/stdout)
```

The bridge is a WebSocket-to-stdio proxy with session management. It spawns and manages `claude -p` processes, one per session.

## Connection

```
ws://host:3001                    # Lobby mode (folder chooser, no session)
ws://host:3001?session=<uuid>     # Direct session (legacy, backwards compat)
```

Port configurable via `BRIDGE_PORT` env var.

### Lobby Mode

Connecting without `?session=` enters **lobby mode** — no CC process, no session. The browser can list folders and pick one before committing to a session. This is the path used by the folder chooser UI.

### Direct Session Mode

Connecting with `?session=<uuid>` skips the lobby and immediately creates/reconnects a session. This is the legacy path, preserved for backwards compatibility.

## Message Discrimination

Every server→browser message carries a `source` field: `"bridge"` for lifecycle messages, `"cc"` for forwarded Claude Code events. This is a structural discriminator — no string-convention tricks.

```typescript
if (msg.source === "bridge") { /* lifecycle */ }
if (msg.source === "cc")     { /* CC event in msg.event */ }
```

## Client → Bridge Messages

### listFolders (lobby only)

Request the enriched folder list. Returns `folderList` with session states.

```json
{ "type": "listFolders" }
```

### connectFolder (lobby only)

Connect to a folder — creates or resumes a session. Transitions from lobby to session mode. Bridge responds with `connected`.

```json
{ "type": "connectFolder", "path": "/Users/modha/Repos/gueridon" }
```

If the folder has an existing CC session (paused), the bridge reuses that session ID so `--resume` works. If fresh, a new UUID is generated.

### prompt (session only)

Send a user message. On first prompt, the bridge spawns the CC process (lazy spawn).

```json
{ "type": "prompt", "text": "Your message here" }
```

Sending `prompt` in lobby mode returns an error.

### abort (session only)

Kill the CC process (SIGTERM, escalates to SIGKILL after 3s).

```json
{ "type": "abort" }
```

## Bridge → Client Messages

### lobbyConnected

Sent on WebSocket connection without `?session=`. The browser is in lobby mode — can send `listFolders` and `connectFolder`.

```json
{ "source": "bridge", "type": "lobbyConnected" }
```

### folderList

Response to `listFolders`. Contains enriched folder data with session states.

```json
{
  "source": "bridge",
  "type": "folderList",
  "folders": [
    {
      "name": "gueridon",
      "path": "/Users/modha/Repos/gueridon",
      "state": "paused",
      "sessionId": "abc-123",
      "lastActive": "2026-02-09T06:00:00.000Z",
      "handoffPurpose": "Built folder scan module..."
    }
  ]
}
```

States: `active` (CC running), `paused` (session files exist), `closed` (handoff only), `fresh` (neither).

### connected

Sent after `connectFolder` or on direct `?session=` connection. No CC process is spawned yet (lazy spawn).

```json
{ "source": "bridge", "type": "connected", "sessionId": "uuid", "resumed": false }
```

`resumed: true` when the session ID maps to existing CC state (will use `--resume` on first prompt).

### promptReceived

Ack that the prompt was written to CC's stdin. In the browser, this is the signal that the remote end has the message — the transition point from "sending" to "waiting for response."

```json
{ "source": "bridge", "type": "promptReceived" }
```

### error

Bridge-level error. On early process exit (<2s), includes captured stderr for diagnostics.

```json
{ "source": "bridge", "type": "error", "error": "description" }
```

### processExit

CC process exited. Session remains in memory for reconnect/resume.

```json
{ "source": "bridge", "type": "processExit", "code": 0, "signal": null }
```

### CC event (forwarded)

Raw Claude Code JSONL event, forwarded verbatim inside the `event` field.

```json
{ "source": "cc", "event": { "type": "system", "subtype": "init", ... } }
```

See `docs/empirical-verification.md` for all CC event types and their schemas.

## Session Lifecycle

### Lobby → Session Flow (folder chooser)

```
Browser connects (no ?session=)  → bridge:lobbyConnected
Browser sends listFolders        → bridge:folderList (enriched folder data)
Browser sends connectFolder      → bridge:connected (session created, no CC yet)
Browser sends prompt             → CC spawned (lazy) → bridge:promptReceived
```

### Direct Session Flow (legacy)

```
Browser connects (?session=uuid) → bridge:connected (no CC process yet)
Browser sends prompt             → CC spawned (lazy) → bridge:promptReceived
```

### Common (both flows)

```
CC streams events         → forwarded as cc:event messages
CC completes (result)     → cc:event with type="result"
Browser disconnects       → 5-minute idle timer starts
                            If timer fires: CC killed, session removed
Browser reconnects        → idle timer cancelled
                            If CC still running: session resumes
                            If CC died: respawned with --resume on next prompt
```

## Reliability

### Ping/pong (mobile connection health)

Server pings every 30s. If no pong within 10s, connection is terminated. This catches silently-dead mobile connections that would otherwise leave orphaned CC processes.

Browsers respond to WebSocket pings automatically — no client-side code needed.

### SIGTERM → SIGKILL escalation

All process kills (abort, idle timeout, shutdown) send SIGTERM first, then SIGKILL after 3s if the process hasn't exited.

### Early exit detection

If CC exits with non-zero code within 2s of spawn, the bridge sends a `bridge:error` with captured stderr. This catches flag/version problems that would otherwise appear as a silent `processExit`.

### stdin write safety

Writes to CC's stdin are wrapped in try/catch to handle the race where the process dies between the liveness check and the write.

## CC Process Flags

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --session-id <uuid> \              # or --resume <uuid>
  --dangerously-skip-permissions \
  --allow-dangerously-skip-permissions
```

## Running

```bash
npm run bridge              # Start on :3001
BRIDGE_PORT=4000 npm run bridge  # Custom port
```

## Testing

```bash
# Terminal 1:
npm run bridge

# Terminal 2:
npx tsx scripts/test-bridge.ts   # Tests: basic flow, multi-turn, reconnect
```
