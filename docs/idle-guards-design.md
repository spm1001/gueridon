# Idle Guards Design

**Problem:** Bridge kills CC after 5 minutes of no WS clients, regardless of whether CC is mid-turn. Long tool executions (test suites, multi-file refactors) get killed.

**Solution:** Replace single timer with "check + guards" pattern. When idle timer fires, consult guards before killing. Guards can defer the kill.

## Architecture

```
last client disconnects
  → record idleStart, schedule checkIdle in IDLE_TIMEOUT_MS

checkIdle fires
  → safety cap exceeded? → kill
  → any guard says keepAlive? → log reason, schedule recheck in recheckMs
  → no guard keeping alive, but guard WAS deferred last check? → grace period (restart countdown)
  → grace period elapsed → kill

client reconnects at any point
  → cancel idleCheckTimer, clear idle state
```

## Pure function: checkIdle

Returns an action — no side effects, fully testable:

```typescript
type IdleAction =
  | { action: 'kill'; reason: string }
  | { action: 'recheck'; delayMs: number; guardDeferred: boolean; reason: string }
```

`guardDeferred` tells the caller what to store for the next check cycle.

**Grace period mechanism:** When `guardWasDeferred` was true on entry but no guard defers now, CC just transitioned from "working" to "idle." Return `{ action: 'recheck', delayMs: IDLE_TIMEOUT_MS, guardDeferred: false }` — a full idle countdown before killing. If the grace period elapses and nothing changes, next check kills.

## Guard interface

```typescript
interface IdleGuard {
  name: string;
  shouldKeepAlive(state: IdleSessionState, now?: number): {
    keep: boolean;
    reason?: string;
    recheckMs?: number;  // default IDLE_RECHECK_MS (30s)
  };
}
```

**Composition:** ANY guard can keep alive. Safety cap is checked BEFORE guards (inviolable).

## ActiveTurnGuard (first extension)

Defers when `turnInProgress && hasRecentOutput`. Two signals:
- **Protocol state:** prompt sent to stdin without corresponding `result` on stdout
- **Staleness:** stdout has produced output within `STALE_OUTPUT_MS`

If mid-turn but no output for 10 minutes: guard declines to keep alive (CC likely stuck). Safety cap catches the rest.

## Constants (env var overridable)

| Constant | Default | Env var | Purpose |
|----------|---------|---------|---------|
| `IDLE_TIMEOUT_MS` | 5 min | `IDLE_TIMEOUT_MS` | Time before first idle check (existing) |
| `MAX_IDLE_MS` | 30 min | `MAX_IDLE_MS` | Absolute cap since client disconnect |
| `STALE_OUTPUT_MS` | 10 min | `STALE_OUTPUT_MS` | Stdout silence → "probably stuck" |
| `IDLE_RECHECK_MS` | 30s | (not configurable) | Guard recheck interval |

## Session state additions

```typescript
// Add to Session interface:
turnInProgress: boolean;       // true between user prompt and result event
lastOutputTime: number | null; // updated on every stdout line
idleStart: number | null;      // when last client disconnected
idleCheckTimer: ReturnType<typeof setTimeout> | null;  // replaces idleTimer
guardWasDeferred: boolean;     // for grace period detection
```

Remove: `idleTimer` field.

## Turn lifecycle (precise set/clear points)

| Event | Where in bridge.ts | State change |
|-------|-------------------|--------------|
| User prompt written to stdin | `handleSessionMessage` prompt case, after `writeToStdin` succeeds | `turnInProgress = true` |
| `result` event parsed from stdout | `wireProcessToSession` rl.on('line'), check `event.type === 'result'` | `turnInProgress = false` |
| Process exit | `proc.on('exit')` | `turnInProgress = false` |
| Any stdout line parsed | `wireProcessToSession` rl.on('line') | `lastOutputTime = Date.now()` |

## bridge.ts changes (clean replacement)

**Remove:**
- `session.idleTimer` field from Session interface
- `setTimeout(() => { kill... }, IDLE_TIMEOUT_MS)` in ws.on('close') (lines 654-662)
- `clearTimeout(session.idleTimer)` in `attachWsToSession` (lines 385-388)

**Add:**
- New fields on Session (above)
- Turn tracking in `wireProcessToSession` and `handleSessionMessage`
- `startIdleCheck(session)` — records idleStart, schedules first checkIdle
- `cancelIdleCheck(session)` — clears timer and idle state
- Call `startIdleCheck` from ws.on('close') when last client disconnects
- Call `cancelIdleCheck` from `attachWsToSession` when client reconnects
- Clear `turnInProgress` in process exit handler
- Update `lastOutputTime` in stdout line handler

## What lives where

| File | What goes there |
|------|----------------|
| `bridge-logic.ts` | `IdleGuard`, `IdleSessionState`, `IdleAction`, `checkIdle()`, `createActiveTurnGuard()`, constants |
| `bridge-logic.test.ts` | Pure function tests for checkIdle + activeTurnGuard |
| `bridge.ts` | Session state additions, wiring (startIdleCheck/cancelIdleCheck), turn tracking |

## Edge cases handled

| Scenario | Outcome |
|----------|---------|
| CC finishes during idle → client returns 1 min later | Grace period (5 min) running, process still alive |
| CC finishes during idle → nobody returns | Grace period elapses, kill after idle+grace time |
| CC stuck mid-turn, no stdout for 10 min | Staleness check declines to keep alive, killed at next recheck |
| CC stuck mid-turn, staleness check not reached before 30 min | Safety cap kills |
| Process crashes mid-turn | Exit handler clears turnInProgress, normal idle proceeds |
| Client reconnects during deferred check | cancelIdleCheck, normal flow |
| Compaction flickers result event | Grace period starts, CC immediately re-activates, guard defers again |
| Multiple prompts/turns while client away | turnInProgress stays true throughout multi-tool chain (result only at end) |
