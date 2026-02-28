# Guéridon

Mobile web UI for Claude Code. No framework, no build step.

## Architecture

```
Phone browser → HTTP → Node.js bridge → claude -p (stream-json) → MAX subscription
```

One HTML file (`index.html`) served by the bridge. SSE for live events, POST for commands. Process-per-session with `--session-id <uuid>`, resume via `--resume` after process kill.

## Running

```bash
npm start                    # Start bridge on port 3001
BRIDGE_PORT=3002 npm start   # Override port
npm test                     # Run all tests (~423 tests, ~7s)
npm run test:watch           # Watch mode
```

Phone URL: `https://tube.atlas-cloud.ts.net/` (Tailscale HTTPS termination).

## Deployment

Runs on **tube** (Debian Linux, Tailscale). Single systemd service.

**Two directories:**
- **`/opt/gueridon`** — production checkout. The systemd service runs from here.
- **`~/Repos/gueridon`** — development. Edit, test, commit, push here.

**Deploy workflow:**
```bash
# After pushing from ~/Repos/gueridon:
cd /opt/gueridon && git pull && npm install && sudo systemctl restart gueridon
```

**Service management:**
```bash
sudo systemctl restart gueridon    # Restart bridge
sudo systemctl status gueridon     # Check health
journalctl -u gueridon -f          # Tail logs
```

- **`KillMode=process`** — bridge restart does NOT kill CC child processes. They become orphaned; the new bridge reaps them on startup (SIGTERM) and the next client connection resumes via `--resume`.
- **HTTPS terminated by `tailscale serve`** — bridge listens on HTTP :3001.
- **VAPID keys** for push notifications live at `~/.config/gueridon/vapid.json`.
- **Session persistence** — `~/.config/gueridon/sse-sessions.json` tracks active CC PIDs so the bridge can reap orphans after restart.

### Self-deployment (working on guéridon from guéridon)

When Claude is running as a CC child of the bridge and you deploy, the bridge restart kills the bridge process, the new bridge reaps the CC process, and the client reconnects with `--resume`. The self-deploy caveats still apply:

1. **Don't announce before restarting.** Sending a text response ("I'll restart now") triggers a bridge→client→CC round-trip. If the bridge restarts during that round-trip, the session resumes and you may loop. Just run the deploy command.
2. **After session resume, the deploy is done.** The `[guéridon:system] The bridge was restarted...` message confirms it. Do NOT restart again — that was the deploy.

See `docs/deploy-guide.md` for VAPID key setup, Tailscale plumbing, and first-time install.

## Bridge Server

The bridge is split across several modules in `server/`:

| File | Responsibility |
|------|---------------|
| `bridge.ts` | HTTP server, SSE transport, process lifecycle |
| `bridge-logic.ts` | Pure functions — session resolution, CC arg construction, delta conflation, path validation |
| `state-builder.ts` | Pure state machine translating CC stdout events into the frontend state shape |
| `folders.ts` | Folder scanning, session discovery, handoff reading |
| `deposit.ts` | Multipart/binary upload parsing, file validation, mise-style deposit to disk |
| `orphan.ts` | Orphan CC process reaping, debounced session persistence |
| `push.ts` | Web Push (VAPID) notification delivery |
| `upload.ts` | Upload validation, MIME detection via magic bytes, manifest building |
| `event-bus.ts` | Typed event emitter decoupling event production from consumption |
| `request-context.ts` | Per-request AsyncLocalStorage — auto-attaches correlation IDs to events |
| `events.ts` | `BridgeEvent` type definitions, severity level mapping |
| `logger.ts` | JSON-lines structured logger subscribed to event bus |
| `status-buffer.ts` | Circular buffer of recent events for the `/status` debug endpoint |
| `fun-names.ts` | Alliterative folder name generator for share-sheet uploads |

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve index.html |
| GET | `/events` | SSE stream (hello, folders, state, delta, ping) |
| GET | `/folders` | List available project folders |
| POST | `/session/:folder` | Connect to a folder's CC session |
| POST | `/prompt/:folder` | Send prompt (or queue if busy) |
| POST | `/abort/:folder` | SIGTERM the CC process |
| POST | `/exit/:folder` | Deliberate session close |
| POST | `/push/subscribe` | Register push subscription |
| POST | `/push/unsubscribe` | Remove push subscription |
| GET | `/status` | Debug endpoint (sessions, memory, recent events) |
| POST | `/client-error` | Mobile error reporting (rate-limited) |
| POST | `/upload` | Share-sheet new-session upload (auto-injects prompt) |
| POST | `/upload/:folder` | Multipart file upload (`?stage=true` for client staging, default auto-injects) |

**Key design:**
- **SSE + POST:** EventSource for server→client events, fetch POST for client→server commands. Auto-reconnects, stateless transport.
- **StateBuilder** (`server/state-builder.ts`): See module table above. Emits SSE deltas during streaming, full state snapshots at turn end.
- **Delta conflation:** Text deltas accumulated and flushed on timer (not per-token). Reduces SSE traffic without visible latency.
- **Static serving:** index.html, style.css, sw.js, manifest.json, marked.js, icons, mockup.html, client modules (render-utils.js, render-chips.js, render-messages.js, render-chrome.js) — no-cache headers, same port as API.
- **Lazy spawn:** CC process starts on first prompt, not on connect.
- **SIGTERM → SIGKILL:** 3s escalation on all process kills.
- **Orphan reaping:** On startup, reads sse-sessions.json, SIGTERMs any live CC processes from the previous bridge instance.
- **Outrider prompt:** When the first queued prompt arrives during an active turn, the bridge injects a steering message into CC's stdin ("The user has sent a follow-up message. Finish your current work..."). CC sees this as a user message and wraps up before processing the queue. These appear in JSONL transcripts as phantom user messages — they are bridge-generated, not user-typed.
- **Upload staging:** `POST /upload/:folder?stage=true` deposits files on disk and returns the manifest without injecting a prompt. The client stages deposits as pills below the textarea; on send, `buildDepositNoteClient()` composes deposit notes + user text as one prompt. Without `?stage=true` (share-sheet flow), upload auto-injects as before.
- **`[guéridon:*]` prefix convention:** Bridge-injected messages use `[guéridon:system]`, `[guéridon:upload]` etc. StateBuilder detects these and marks as `synthetic: true` (rendered as system chips, prefix stripped). **Exception:** staged uploads contain a deposit note followed by user text — StateBuilder checks for text after the deposit suffix and keeps these as real user messages. The client's `renderUserBubble()` parses deposit notes into `📎 filename` references.
- **Deposit note parity:** `buildDepositNoteClient()` in `client/render-utils.cjs` (single source of truth) must exactly match `buildDepositNote()` in `server/upload.ts`. The parity gate test in `upload.test.ts` imports the real client function. `renderUserBubble()` also parses this format — three places coupled to one template.

## CC Process Flags

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --allowed-tools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,Task,TaskOutput,TaskStop,Skill,AskUserQuestion,EnterPlanMode,ExitPlanMode,EnterWorktree,ToolSearch,mcp__*" \
  --disallowedTools "WebFetch,TodoWrite,NotebookEdit" \
  --permission-mode default \
  --mcp-config ~/.claude/settings.json \
  --session-id <uuid> \
  --append-system-prompt "The user is on a mobile device using Guéridon. ..."
```

- `--verbose` is mandatory for stream-json mode.
- `--allowed-tools` lists all tools permissively, including `mcp__*` for all MCP tools. Task subagents bypass `--allowed-tools` entirely (CC [#27099](https://github.com/anthropics/claude-code/issues/27099)), so restricting the parent without restricting Task is ineffective. We list explicitly instead of `--dangerously-skip-permissions` for auditability.
- `--mcp-config` is required because CC in `-p` mode does not auto-load MCP servers from `~/.claude/settings.json`.
- `--disallowedTools` hides tools from the model entirely: WebFetch (returns AI summaries, use curl instead), TodoWrite (use bon), NotebookEdit (no notebooks).
- `--permission-mode default` respects settings.json allow/deny lists.
- `--append-system-prompt` is built dynamically by `buildSystemPrompt()` in `bridge-logic.ts`. Includes: machine context (hostname, "this IS the production server, do not SSH here"), working directory, and AskUserQuestion coaching (tool returns error on mobile, user sees tappable buttons).
- `--session-id <uuid>` for fresh sessions; `--resume <uuid>` for resuming after process kill. Decided by `resolveSessionForFolder()` in `bridge-logic.ts`.
- **Local commands (`/context`, `/cost`, `/compact`) produce NO stdout.** Bridge reads JSONL tail on empty-result turns to recover output.
- **Input format** (critical): `{"type":"user","message":{"role":"user","content":"..."}}`

### CC Environment Variables

The bridge sets these on spawned CC processes (in `spawnCC()` in `bridge.ts`):

| Variable | Value | Why |
|----------|-------|-----|
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | `1` | Reset CWD after each Bash command — sessions must stay in their project folder |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` | No TTY for background task management |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | `1` | No terminal to update |

Other CC environment variables worth knowing about (not currently set):

| Variable | What it does | Notes |
|----------|-------------|-------|
| `CLAUDE_CODE_SIMPLE` | Minimal tools (Bash, Read, Edit only), no MCP/hooks/CLAUDE.md | Too restrictive for bridge, but useful for locked-down mode |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Don't create/load auto memory files | Consider for ephemeral sessions |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | When auto-compaction triggers (default ~95%) | We don't use auto-compaction |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Override max output tokens (default 32K, max 64K) | Could increase for long responses |
| `CLAUDE_CODE_SHELL_PREFIX` | Wrap all Bash commands (e.g. for logging) | Potential for auditing |
| `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` | Auto-exit after idle (ms) | We manage lifecycle ourselves via grace timer |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | Override file read token limit | For reading larger files in full |

Full list: https://code.claude.com/docs/en/settings

## Frontend

`index.html` (HTML + inline JS), `style.css`, and extracted client modules in `client/*.cjs` — no build step. Uses `marked` library (served from node_modules as `/marked.js`).

### Client modules (`client/`)

Pure utility and render functions are being extracted from `index.html` into `client/*.cjs` files. Each file is served by STATIC_FILES as `/filename.js` and loaded via `<script>` tags before the inline script.

**Load order matters** — classic `<script>` tags execute sequentially:
```
marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → inline script
```

**The `.cjs` pattern:** `package.json` has `"type": "module"`, making `.js` files ESM. Client files use `module.exports` (CJS) so they work as both classic browser scripts and vitest imports. The `.cjs` extension forces CJS regardless of the package type setting.

**Importing in tests:**
```typescript
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { esc, trimText } = require("./render-utils.cjs");
```
Dynamic `import()` doesn't work with `.cjs` in an ESM project. `createRequire` is the correct bridge. For TypeScript to accept the path, use `as string` cast: `await import("../client/render-utils.cjs" as string)`.

**Browser export:** Each file sets `window.Gdn = { ...window.Gdn, ...mod }`. The inline script destructures what it needs: `const { esc, trimText } = Gdn;`

**Orchestrator wrappers:** The inline script defines thin wrappers (`refreshSendButton`, `refreshPlaceholder`, `refreshSwitcher`) that read mutable state (e.g., `liveState`, `sseCurrentFolder`, `stagedDeposits`) and pass it as explicit arguments to the extracted module functions. This avoids 5+ callers each computing the same state. Do NOT inline the module calls at each call site — use the wrappers.

| File | Contents | Status |
|------|----------|--------|
| `render-utils.cjs` | `esc`, `trimText`, `trimToolOutput`, `truncateThinking`, `buildDepositNoteClient`, `timeAgo`, `shortModel` | Done |
| `render-chips.cjs` | `renderChip`, `renderThinkingChip`, `renderLocalCommand`, `attachCopyButton` | Done |
| `render-messages.cjs` | `renderUserBubble`, `addCopyButtons`, `renderMessages` | Done |
| `render-chrome.cjs` | `renderStatusBar`, `renderSwitcher`, `updatePlaceholder`, `updateSendButton` | Done |
| `render-overlays.cjs` | AskUser overlay, slash menu, staged deposits | Planned (gdn-sugopa) |

### Layout model — body-scroll

The document body scrolls (not a container element). This enables Safari Full Page screenshots and URL bar shrink-on-scroll.

**CSS primitives (no JS):**
- `body { min-height: 100dvh }` — grows with content, no fixed height
- `.messages { flex: 1 0 auto }` — no `overflow-y: auto`, content flows into document
- `.input-area { position: sticky; bottom: 0; will-change: transform }` — stays at viewport bottom
- `html { scroll-snap-type: y proximity; scroll-padding-bottom: ... }` — auto-follows at bottom, leaves user alone when scrolled up (replaces JS `userScrolledUp` tracking)
- `.snap-anchor { scroll-snap-align: end }` — invisible element appended by `renderMessages` as snap target
- `.input-field { field-sizing: content }` — textarea auto-grows (replaces JS `input` event listener)

**Remaining JS for scroll:** only `window.scrollTo()` on send and textarea focus (force-scroll after deliberate user action).

**CSS shell:** `css-shell.html` is the test page for validating CSS layout changes before production. See `docs/css-shell.md`.

### UI features

- Dark theme only
- Markdown rendering via `marked.parse()` / `marked.parseInline()`
- Collapsible tool calls (consecutive successful calls coalesce)
- Enter never submits (mobile newlines), submit is the button
- Chunk-level updates (not token-level)
- Session switcher: Now (active+paused) / Previous (closed with history) groups, fresh folders hidden unless searching. Per-folder session list with "+ New Session" at top. Swipe-down or tap handle to dismiss.
- Push notifications via service worker
- Upload staging: files deposit as pills below textarea, sent with prompt on send
- `renderUserBubble()` detects `[guéridon:upload]` blocks in user messages and renders as `📎 filename` references (both optimistic bubbles and server-state re-renders)
- Drag-and-drop: document-level handlers with visual overlay (desktop only, mobile Safari doesn't fire drag events)

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/deploy-guide.md` | Deployment guide — systemd, Tailscale, VAPID keys |
| `docs/css-shell.md` | CSS shell test page — layout validation, streaming simulator, iOS checklist |
| `docs/empirical-verification.md` | Verified CC event schemas, edge cases, abort mechanisms |
| `server/CC-EVENTS.md` | CC event reference for state-builder development |
