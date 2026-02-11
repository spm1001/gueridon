# Guéridon Lifecycle Map

Two independent lifecycles multiplied together. The bridge sits between them.

```
  Your phone                    The bridge                    Claude
  ──────────                    ──────────                    ──────
  connects  ───WebSocket───►  receives you   ───stdio───►  (not started yet)
  picks folder ────────────►  spawns Claude  ────────────►  wakes up, starts working
  reads response ◄─────────  forwards output ◄────────────  streams response
  locks screen  ───WS dies──►  notices you left              keeps working (doesn't know)
  ...                          starts 5min timer             finishes, waits for input
  wakes up  ───new WS──────►  cancels timer, you're back    still waiting
```

The key: the phone↔bridge connection and the bridge↔Claude connection are
independent. Your phone can vanish and reappear without Claude caring.

---

## The User's Journey

### 1. Getting the menu

You open the app. Your phone connects to the bridge. The bridge scans your
`~/Repos` folders and sends you the list. You see the folder picker.

**What can go wrong:**
- Bridge is down → you see nothing (WebSocket won't connect, transport retries with backoff forever)
- Folder scan fails → empty list, no explanation
- Phone connection drops before list arrives → transport reconnects, re-enters lobby, re-requests list

**What's handled today:**
- Transport auto-reconnects with backoff (1s, 2s, 4s... up to 30s)
- Lobby mode sends folder list on connect

**What's missing:**
- No error message if bridge is unreachable (just infinite "connecting...")
- No offline indicator beyond the connection status dot

### 2. Ordering (picking a folder)

You tap a folder. The bridge figures out whether to start Claude fresh or
resume a previous conversation. Then it tells your phone "you're connected."

**What can go wrong:**
- Folder was deleted since the list was built → bridge tries to spawn CC in a nonexistent directory
- Resume fails (corrupted session file) → CC crashes on launch
- CC won't start (wrong version, bad flags) → early exit within 2s, bridge sends error
- Phone drops during this step → transport reconnects and retries

**What's handled today:**
- Early exit detection (CC dies within 2s → stderr surfaced)
- Resume vs fresh decision (handoff-aware, won't resume intentionally-closed sessions)
- `connectToFolder()` on transport: retry (3 attempts), timeout (30s), failure callback
- Mid-session folder switch tears down old WS, reconnects fresh, retries connect
- Flash bug prevention via structural callback split (`onFolderConnected` vs `onSessionId`)

**What's missing:**
- No fallback from failed resume to fresh session

### 3. Being served (the conversation)

You're chatting with Claude. You type, Claude responds. This is the happy path.

**What can go wrong:**
- Phone drops briefly (WiFi blip, tunnel) → you miss whatever Claude said during the gap
- Phone drops for 5+ minutes → bridge kills Claude, you lose the in-flight response
- Claude crashes mid-response → UI shows infinite streaming cursor
- Claude hangs (stuck in a tool) → nothing detects it

**What's handled today:**
- Transport auto-reconnects and re-enters the session (using saved session ID)
- `processExit` → transport synthesises an error result → adapter stops streaming
- Ping/pong (30s/10s) catches silently-dead connections

**What's missing:**
- No application-level heartbeat from Claude (can't detect hangs)

### 4. Coming back (the butler feature)

You locked your phone, went to make coffee, or switched to another app.
Claude may have finished working, or may still be going.

**What can go wrong:**
- WiFi blip (few seconds) → you miss some streamed output
- Phone locked briefly (under 5min) → CC still alive, but you missed events
- Phone locked for 5+ minutes → CC was killed, session is resumable
- Tab was closed entirely → WS gone, CC eventually killed, must reconnect fresh

**What's handled today:**
- Within 5min: transport reconnects with session ID, session resumes
- After 5min: session is resumable via `--resume` on next prompt
- Multi-tab: other tabs keep the session alive even if one closes

**What's missing:**
- No notification ("Claude finished" / "Claude needs your input")
- Can't distinguish "Claude is done, waiting for you" from "Claude is still working"

---

## The Two Lifecycles

### Your phone's lifecycle

```
not here ──► connecting ──► in lobby ──► in session ──► gone ──► back
                                              │                    │
                                              └── (same session) ◄─┘
```

**"Gone" means:** WiFi dropped, phone locked, tab backgrounded, tab closed.
The bridge can't tell the difference — it just sees the WebSocket die.

### Claude's lifecycle (per folder)

```
not started ──► spawning ──► working ──► idle ──► killed ──► resumable
                    │                      │         │            │
                    └── (crash) ───────────┘         │            │
                                                     │            │
                              (5min no clients) ─────┘            │
                                                                  │
                              (next prompt) ──────────────────────┘
```

**"Killed" is not the end.** The session file survives. `--resume` brings
Claude back with full conversation history. The cost is ~8s cold start.

### The multiplication

Every combination of phone-state and Claude-state is a scenario:

| | Claude not started | Claude working | Claude idle | Claude killed |
|---|---|---|---|---|
| **Phone here** | Pick a folder, spawn | See streaming response | Send next prompt | Resume on next prompt |
| **Phone gone** | Nothing happens | Claude keeps working, output lost | Idle timer ticking | Session file on disk |
| **Phone back** | Re-enter lobby | Reconnect, but missed output | Continue normally | Resume on next prompt |

Cells that used to be gaps:

- ~~**Phone gone + Claude working**: Output lost~~ — bridge buffers, replays on reconnect.
- ~~**Phone back + Claude working (was gone)**: Missed output~~ — `historyStart`/`historyEnd` replay.
- ~~**Phone gone + Claude idle**: Timer kills prematurely~~ — idle guards check active-turn state.

---

## What Each Component Knows

The three client components each own one concern:

**WSTransport** owns **connection + folder selection**. Lobby/session modes,
`connectToFolder()` with retry (3) and timeout (30s), auto-reconnect with
backoff, `visibilitychange` instant reconnect. Fires `onFolderConnected` and
`onFolderConnectFailed` callbacks so the UI can react without tracking state.

**ClaudeCodeAgent** owns **Claude's conversation** — messages, streaming state,
tool calls, context gauge. Pure event translation from CC stream-json to
pi-agent-core AgentEvents. No DOM, no WS.

**main.ts** is the **wiring layer** — 3 variables (`folderDialog`,
`cachedFolders`, `connectingFromDialog`) and direct callbacks. No dispatch queue,
no effect executor, no state machine. The `connectingFromDialog` guard prevents
flash bugs where a stale `connected` event could close a picker the user is
actively browsing.

No single component has the full picture, but the separation is intentional —
each concern is testable in isolation.

---

## The Path Forward

### Done

1. ~~**Connecting can fail gracefully**~~ — `connectToFolder()` with retry (3) + timeout (30s), failure callback returns to folder picker.
2. ~~**Instant reconnect on tab resume**~~ — `visibilitychange` listener triggers immediate WS reconnect.
3. ~~**Bridge buffers output while you're away**~~ — message buffer per session, replayed on reconnect within `historyStart`/`historyEnd` envelope.
4. ~~**Don't kill Claude mid-work**~~ — idle guard system checks active-turn state before killing. 10min stuck-process safety net.

### Remaining

5. **Folder list is a dashboard** (gdn-hikosa) — show what each Claude is doing: working, finished, idle. Bridge tracks CC state; surfacing it in folder list turns picker into a status screen.
6. **You know when Claude is done without looking** — page title update or push notification via service worker.
7. **Definitive session close** (gdn-hilapa) — bridge intercepts `/exit` as protocol command, writes marker. Folder scanner distinguishes "deliberately closed" from "abandoned."
