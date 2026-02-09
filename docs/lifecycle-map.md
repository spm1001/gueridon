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
- No timeout/give-up — transport retries forever
- No offline indicator beyond the connection status dot

### 2. Ordering (picking a folder)

You tap a folder. The bridge figures out whether to start Claude fresh or
resume a previous conversation. Then it tells your phone "you're connected."

**What can go wrong:**
- Folder was deleted since the list was built → bridge tries to spawn CC in a nonexistent directory
- Resume fails (corrupted session file) → CC crashes on launch
- CC won't start (wrong version, bad flags) → early exit within 2s, bridge sends error
- Phone drops during this step → state machine is stuck in "connecting"

**What's handled today:**
- Early exit detection (CC dies within 2s → stderr surfaced)
- Resume vs fresh decision (handoff-aware, won't resume intentionally-closed sessions)
- State machine retries connect on WS reconnect during connecting phase

**What's missing:**
- No retry limit on the reconnect→retry loop (infinite)
- Bridge errors (`processExit`, `error` messages) don't reach the state machine — it stays stuck in "connecting"
- No timeout on the connecting phase itself
- No fallback from failed resume to fresh session
- "Switching" phase (mid-session folder change) has the same stuck-forever problem

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
- No message buffering — events during a WiFi gap are permanently lost
- Idle timer doesn't check if Claude is actively working (kills mid-stream after 5min)
- No application-level heartbeat from Claude (can't detect hangs)
- Reconnecting after idle-kill loses folder metadata (session has `folder: null`)

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
- No message replay — whatever Claude said while you were away is lost to the UI
- No notification ("Claude finished" / "Claude needs your input")
- No `visibilitychange` listener — tab resume waits for ping/pong timeout (up to 30s) instead of reconnecting immediately
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

The cells in **bold** are where the gaps live:

- **Phone gone + Claude working**: Output is lost. Should be buffered.
- **Phone back + Claude working (was gone)**: Missed output. Should be replayed.
- **Phone gone + Claude idle**: Timer might kill a session you want to keep. Timer should be smarter.

---

## What the State Machine Knows vs Doesn't Know

The current folder-lifecycle state machine tracks **the folder selection process only**.
It goes idle → browsing → connecting → idle. Once you're connected, it's done.
It has no awareness of:

- Whether Claude is running, idle, or dead
- Whether the phone connection is healthy
- Whether output was missed during a disconnect
- How long you've been in "connecting" with no response

This is why errors during connecting are invisible to it — it has no event for
"something went wrong" and no timeout for "nothing is happening."

The transport (WSTransport) tracks **connection health** — connecting, lobby,
connected, disconnected. But it doesn't know about the folder lifecycle or
Claude's work state.

The adapter (ClaudeCodeAgent) tracks **Claude's conversation** — messages,
streaming state, tool calls. But it doesn't know about connection health or
folder selection.

Three components, each knowing one piece. Nobody has the full picture.

---

## The Path Forward

Each item is one distinct thing. No duplicates.

### Minimum (unblock the stuck states)

1. **Connecting can fail gracefully** — retry limit (3 attempts) + timeout (30s), then back to the folder picker with an explanation. Covers both "connecting" and "switching" phases. Bridge errors and processExit during connecting count as failures.
2. **Instant reconnect on tab resume** — `visibilitychange` listener triggers immediate WS reconnect instead of waiting up to 30s for ping/pong timeout to notice.

### Medium (the butler — Claude works while you're away)

3. **Bridge buffers output while you're away** — ring buffer per session. When your phone reconnects, bridge replays what you missed. One feature: save on the bridge side, replay on reconnect.
4. **Don't kill Claude mid-work** — idle timer checks whether CC is actively streaming before killing. Only starts the countdown when Claude is idle AND no clients are connected.
5. **Folder list is a dashboard** — shows what each Claude is doing: "working", "finished, waiting for you", "idle". The bridge already tracks whether CC is running; surfacing it in the folder list turns the picker into a status screen you open to check on things, not just to switch. Pairs naturally with buffering — once the bridge is paying attention to Claude's state, this is almost free.

### Ambitious (you can forget about it)

6. **You know when Claude is done without looking** — page title update ("Claude finished"), or push notification via service worker. You don't have to watch the screen or open the folder list.
