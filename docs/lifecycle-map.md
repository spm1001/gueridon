# Guéridon Lifecycle Map

> **Staleness note (2026-02):** This doc was written during the WebSocket era. The transport is now SSE+POST and the client is a single `index.html` (no Vite, no Lit, no pi-web-ui). The mental models and lifecycle multiplication table below remain valid; implementation details (component names, WS mechanics) are outdated.

Two independent lifecycles multiplied together. The bridge sits between them.

```
  Your phone                    The bridge                    Claude
  ──────────                    ──────────                    ──────
  connects  ───SSE+POST────►  receives you   ───stdio───►  (not started yet)
  picks folder ────────────►  spawns Claude  ────────────►  wakes up, starts working
  reads response ◄─────────  forwards output ◄────────────  streams response
  locks screen  ─SSE drops──►  notices you left              keeps working (doesn't know)
  ...                          idle guards check             finishes, waits for input
  wakes up  ───new SSE─────►  cancels timer, you're back    still waiting
```

The key: the phone↔bridge connection and the bridge↔Claude connection are
independent. Your phone can vanish and reappear without Claude caring.

---

## The User's Journey

### 1. Getting the menu

You open the app. Your phone connects to the bridge. The bridge scans your
`~/Repos` folders and sends you the list. You see the folder picker.

**What can go wrong:**
- Bridge is down → you see nothing (SSE won't connect, transport retries with backoff)
- Folder scan fails → empty list, no explanation
- Phone connection drops before list arrives → SSE reconnects, re-requests list

**What's handled today:**
- SSE auto-reconnects
- Folder list sent on `/events` connection (hello event)
- Error banner shown when bridge is unreachable
- Input bar hints show connection status

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
- `POST /session/:folder` connects to a folder session

**What's missing:**
- No fallback from failed resume to fresh session

### 3. Being served (the conversation)

You're chatting with Claude. You type, Claude responds. This is the happy path.

**What can go wrong:**
- Phone drops briefly (WiFi blip, tunnel) → SSE reconnects, full state snapshot replayed
- Phone drops for extended period → idle guards check before killing Claude
- Claude crashes mid-response → UI shows infinite streaming cursor
- Claude hangs (stuck in a tool) → nothing detects it

**What's handled today:**
- SSE auto-reconnects with full state snapshot replay
- `processExit` → error shown in UI
- SSE ping every 30s catches dead connections
- Push notifications when Claude finishes (phone-in-pocket scenario)

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

**What's handled today:**
- Push notifications ("Claude finished" / "Claude needs your input") via VAPID web push
- Page title + favicon badge distinguish "working" from "done" from "needs input"
- SSE reconnects with full state snapshot — no missed output

---

## The Two Lifecycles

### Your phone's lifecycle

```
not here ──► connecting ──► in lobby ──► in session ──► gone ──► back
                                              │                    │
                                              └── (same session) ◄─┘
```

**"Gone" means:** WiFi dropped, phone locked, tab backgrounded, tab closed.
The bridge can't tell the difference — it just sees the SSE connection drop.

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

**Bridge** (`server/bridge.ts` + `bridge-logic.ts`) owns **session lifecycle** — process spawn/kill, session resolution (reconnect/resume/fresh), orphan reaping, idle guards, push notifications. Pure decision logic in `bridge-logic.ts`, IO in `bridge.ts`.

**StateBuilder** (`server/state-builder.ts`) owns **CC event translation** — transforms CC stdout events into the frontend state shape. Emits SSE deltas during streaming, full state snapshots at turn end.

**Frontend** (`index.html`) owns **rendering and interaction** — SSE connection, folder picker, message display, markdown parsing, tool call rendering, AskUserQuestion buttons, push subscription. Single file, no build step.

---

## The Path Forward

### Done

1. ~~**Connecting can fail gracefully**~~ — `connectToFolder()` with retry (3) + timeout (30s), failure callback returns to folder picker.
2. ~~**Instant reconnect on tab resume**~~ — `visibilitychange` listener triggers immediate WS reconnect.
3. ~~**Bridge buffers output while you're away**~~ — message buffer per session, replayed on reconnect within `historyStart`/`historyEnd` envelope.
4. ~~**Don't kill Claude mid-work**~~ — idle guard system checks active-turn state before killing. 10min stuck-process safety net.

### Remaining

5. ~~**Folder list is a dashboard**~~ (gdn-hikosa) — folder picker shows activity state (working/waiting/idle) per folder. Bridge tracks CC turn state via `ActiveSessionInfo`.
6. ~~**You know when Claude is done without looking**~~ — page title + favicon badge (gdn-niwaru), push notifications via VAPID (gdn-beceto). Both shipped.
7. ~~**Definitive session close**~~ (gdn-hilapa) — bridge intercepts `/exit` as protocol command, writes `.exit` marker, sends `sessionClosed` message. Folder scanner distinguishes "deliberately closed" from "abandoned."
