# Research Brief: Cross-Platform Notifications for Guéridon

**Context:** Guéridon is a self-hosted web UI for Claude Code, running as a Node.js WebSocket bridge on a Tailscale-accessible Linux box. The frontend is Lit web components served on port 3001. Users access it from mobile (iOS Safari "Add to Home Screen") and desktop browsers. There is currently **zero notification infrastructure** — no service worker, no PWA manifest, no Web Notification API usage.

**The problem:** When Claude finishes processing (a clear `result` event in the stream), the user has no way to know without staring at the screen. This is the #1 remaining lifecycle gap (documented in `docs/lifecycle-map.md` item #6).

**Goal:** Notify the user when Claude finishes a turn — on both mobile and desktop — so they can walk away during long operations and come back when it matters.

---

## Architecture Summary

```
Mobile/Desktop browser  ←—WebSocket—→  Node.js bridge (:3001)  ←—stdio—→  claude -p
```

- Bridge already tracks turn state (`session.turnInProgress`) and emits a `result` event when Claude finishes
- Frontend has a `ClaudeCodeAgent` that fires `agent_end` when processing completes
- WebSocket reconnects automatically; bridge buffers missed messages
- No service worker, no manifest, no push subscription infrastructure exists today

---

## What Needs Researching

### 1. Notification API vs Push API — Which, When, Both?

**Web Notification API** (`new Notification(...)` / `Notification.requestPermission()`):
- Works when the page is open (foreground or background tab)
- No server component needed
- Simplest to implement — could be done in an afternoon
- **Limitation:** Does NOT work when the tab is closed or the browser is quit

**Push API** (service worker + `PushManager` + server-side push via web-push/VAPID):
- Works even when the browser is closed (on desktop) or the PWA is backgrounded (on mobile)
- Requires: service worker, VAPID key pair, push subscription storage on the bridge, web-push library
- Significantly more infrastructure

**Research questions:**
- For Guéridon's usage pattern (user sends prompt, switches away for 30s–5min, comes back), is the Notification API sufficient? Or do we need Push for the "phone in pocket on the train" scenario?
- What's the realistic behaviour of background tabs + Notification API on iOS Safari (standalone mode) vs desktop Chrome/Firefox?
- Is there a pragmatic middle ground: Notification API first, Push API later?

### 2. iOS Safari / Standalone Mode Constraints

This is the critical platform. Guéridon is primarily used from iOS "Add to Home Screen."

**Research questions:**
- iOS 16.4+ added Web Push for home screen web apps. What are the **actual** requirements? (manifest, service worker, user gesture for permission, HTTPS or localhost exceptions?)
- Does Guéridon's Tailscale access (typically `http://kube:3001` or `http://100.x.x.x:3001`) count as a "secure context" for Push/Notification APIs? Tailscale IPs are private but not HTTPS. Does this block everything?
- If HTTPS is required, what's the lightest way to get it? (Tailscale HTTPS certs via `tailscale cert`? Self-signed + trust profile? Caddy reverse proxy with Let's Encrypt on a Tailscale domain?)
- What's the notification UX on iOS standalone mode — do they appear as banners? Do they survive the app being suspended by iOS?
- Is there an `applicationServerKey` / VAPID requirement for iOS web push specifically?

### 3. Service Worker Scope and Lifecycle

Guéridon currently has no service worker. Adding one affects more than just notifications.

**Research questions:**
- What's the minimal service worker for push notifications? (Just `push` + `notificationclick` event handlers?)
- Should the service worker also handle offline caching, or keep it notification-only to avoid complexity?
- Vite has `vite-plugin-pwa` (uses Workbox). Is it worth pulling in, or is a hand-rolled 30-line SW simpler for this use case?
- Service worker update lifecycle — how do we avoid the "stale service worker" problem where users get stuck on an old version? (Especially relevant since Guéridon deploys via git pull + restart.)
- What scope should the SW register at? (`/` is fine since Guéridon owns the whole origin.)

### 4. PWA Manifest Requirements

No manifest exists. One is likely needed for iOS web push.

**Research questions:**
- What's the **minimum viable manifest** for iOS web push to work? (`name`, `start_url`, `display: standalone`, `icons`?)
- Does the manifest need specific icon sizes for iOS? (Apple historically ignores manifest icons in favour of `apple-touch-icon` link tags.)
- Any gotchas with `display: standalone` and the existing `apple-mobile-web-app-capable` meta tag?

### 5. Server-Side Push Infrastructure

If Push API is needed (not just Notification API):

**Research questions:**
- `web-push` npm package — is it still the standard? Any lighter alternatives?
- VAPID key management — generate once, store where? (Bridge config file? Environment variable?)
- Push subscription storage — the bridge needs to remember each client's `PushSubscription`. Where? (In-memory map keyed by device? JSON file? This is a single-user app, so the storage can be trivial.)
- Push payload — can we include the notification title/body in the push payload, or does the SW always construct it?
- Subscription refresh — push subscriptions expire. How often? What's the re-subscription flow?

### 6. Notification Content and UX Design

**Research questions:**
- What should the notification say? Candidates:
  - "Claude finished" (minimal)
  - "Claude finished in {folder}" (useful if multiple sessions)
  - "Claude needs input" (for AskUserQuestion prompts — different trigger)
  - Include a preview of the last message?
- Should tapping the notification focus the existing tab or open a new one? (`notificationclick` + `clients.openWindow` vs `clients.matchAll` + `focus`)
- Should there be a sound? Vibration pattern? (Mobile UX consideration)
- Rate limiting — if Claude finishes 5 tool calls in rapid succession, should each one notify? (Probably not — only notify on `result` event, which is once per turn.)
- User preference — should there be a toggle to enable/disable notifications in the Guéridon UI? Where?

### 7. The "Page Title" Low-Hanging Fruit

The lifecycle map mentions "page title update" as an alternative to push notifications.

**Research questions:**
- Updating `document.title` to e.g. "(Done) Guéridon" when Claude finishes — does this show in the tab on desktop browsers?
- Does this provide any signal on iOS standalone mode? (Probably not — no tab bar.)
- Favicon badge (`<link rel="icon">` swap to a version with a dot) — supported where?
- This could be implemented immediately as a complement to proper notifications.

---

## Proposed Investigation Order

1. **Quick win: page title + favicon badge** — zero infrastructure, helps desktop users immediately
2. **Notification API (foreground/background tab)** — test on target platforms (iOS standalone, desktop Chrome), understand secure context requirements with Tailscale
3. **HTTPS for Tailscale** — likely a prerequisite; investigate `tailscale cert` and Caddy
4. **Minimal PWA manifest + service worker** — just enough for push
5. **Push API with VAPID** — the full "phone in pocket" solution
6. **AskUserQuestion notifications** — extend the system to notify when Claude is waiting for user input (not just when it's done)

---

## Existing Code Touchpoints

These are the places where notification triggers would be wired in:

| Signal | Where it's detected | What it means |
|--------|-------------------|---------------|
| `result` event | `ClaudeCodeAgent.handleResult()` in `src/claude-code-agent.ts` | Claude finished a turn |
| `agent_end` event | Subscriber in `src/gueridon-interface.ts` | UI knows streaming stopped |
| `turnInProgress` flag | `bridge.ts` session state | Bridge knows Claude is idle |
| `AskUserQuestion` tool use | `src/ask-user-overlay.ts` | Claude is waiting for user input |

For **Notification API** (client-side only): hook into `agent_end` in the frontend.
For **Push API** (server-sent): hook into the `result` event handler in `bridge.ts` and push to stored subscriptions.

---

## Constraints

- **Single-user app** — no multi-tenant concerns, subscription storage can be trivial
- **Self-hosted on Tailscale** — no public internet exposure, but this may complicate HTTPS/push
- **Deployed via systemd on Linux** — VAPID keys and subscriptions need to survive restarts
- **No build-time framework changes desired** — prefer minimal additions over pulling in large PWA toolkits
- **Must work on iOS Safari standalone mode** — this is the primary mobile platform

---

## Implementation Status (2026-02-15)

### Done
1. **Page title + favicon badge** — document.title shows ✓/⏳/❓, SVG favicon with colored dot. Window focus resets.
2. **Service worker + manifest + Notification API** — SW registered, manifest with display:standalone, notifications fire on agent_end and AskUserQuestion. Permission requested from user gesture (send button tap). Replay suppressed.
3. **SW lifecycle** — skipWaiting + clients.claim for instant activation. notificationclick focuses existing tab.

3. **HTTPS via `tailscale serve`** (gdn-jahaku) — TLS termination by Tailscale daemon, zero code in bridge. Certs auto-renew, no restart needed. See `docs/deploy.md`.
4. **Push API with VAPID** (gdn-beceto) — `server/push.ts` module, `web-push` npm package. Bridge pushes when `clients.size === 0` on result and AskUserQuestion events. Client subscribes via `PushManager` on first prompt (user gesture). Subscriptions persisted to `~/.config/gueridon/push-subscriptions.json`.
5. **iOS device testing** — verified on iOS Safari standalone mode (Add to Home Screen). Permission dialog appears, push notifications delivered to lock screen with vibration.

### Remaining
6. **Push test script** — `scripts/send-test-push.ts` for end-to-end verification without waiting for a real CC turn
