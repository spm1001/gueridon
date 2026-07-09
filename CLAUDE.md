# Guéridon

Mobile web UI for Claude Code — a phone **launcher** that points a full-freedom session at any repo. No framework, no build step.

## Architecture — two billing lanes

The launcher (`launch.html`) is the front door. Bare `/` redirects to it. Pick a repo, then pick a **billing lane** (two buttons, `gdn-deloce`):

```
                       ┌─ Vertex → claude -p (stream-json)       → Guéridon's own UI at /#<repo>
phone → launcher (/) ──┤
                       └─ Teams  → claude --remote-control (pty) → claude.ai native UI
```

- **Vertex lane** — the streaming path: one `claude -p` process per repo (`--session-id` per session, `--resume` after a process kill), SSE for live events, POST for commands, rendered by Guéridon's own conversation page (`index.html`). Billed to **Vertex** (estate daily-driver) because the systemd unit sources `vertex.env`. This is the *only* route to a Vertex-billed mobile session — which is why it stays.
- **Teams lane** — `claude --remote-control` in a pty; the phone gets a `claude.ai/code/session_…` link and claude.ai's native UI does the driving. Billed to **Teams/MAX**. Gated on `GUERIDON_ENABLE_RC=1` (LIVE in prod since 2026-06-29).

**Route by billing intent BEFORE spawning — never detect-and-fallback.** A Vertex `--remote-control` spawn comes up *silently inert* (no attach URL, no error), so "spawn RC, fall back to streaming" would only ever hang. The launcher's two buttons make the choice explicit per launch. Mechanism + the matched-pair spike that proved it: `.bon/understanding.md` → **Billing lanes**.

The Vertex/streaming lane is in **maintenance mode** — nips and tucks fine (e.g. `gdn-hodoco`, `gdn-muluwo`), but no major new feature-building on the drift-prone stream-json layer; retire it only on felt pain (a CC version breaks the parser, or Vertex-on-mobile stops mattering). The bridge protocol is deliberately client-agnostic — rendering is the client's problem (see `docs/kube-brain-mac-body.md`).

## Running

```bash
npm start                    # Start bridge on port 3001
BRIDGE_PORT=3002 npm start   # Override port
npm test                     # Run all tests (~741 tests, ~6s)
npm run test:watch           # Watch mode
```

Phone URL: `https://<your-tailscale-hostname>/` (Tailscale HTTPS termination). Set `TAILSCALE_HOSTNAME` env var. Bare `/` redirects to the launcher (`launch.html`); a deep-link `/#<owner/repo>` (raw, slash intact) opens that repo's Vertex/streaming session directly.

## Deployment

Runs on a Debian Linux server via Tailscale. Single systemd service.

**Two directories:**
- **`/opt/gueridon`** — production checkout. The systemd service runs from here.
- **`~/repos/spm1001/gueridon`** — development. Edit, test, commit, push here.

**Deploy workflow (all three steps, in order):**
```bash
# 1. Commit and push from dev
git add <files> && git commit -m "..." && git push

# 2. Pull into production and restart
cd /opt/gueridon && git pull && npm install && sudo systemctl restart gueridon
```

**GitHub merge strategy:** Rebase merge only (squash and merge commit disabled). After PR merge, `git pull` syncs local — no `git reset --hard` needed.

Production serves from `/opt/gueridon`, not `~/repos/spm1001/gueridon`. Changes that aren't committed and pushed won't appear in production — `git pull` in `/opt` has nothing to pull.

**Service management:**
```bash
sudo systemctl restart gueridon    # Restart bridge
sudo systemctl status gueridon     # Check health
journalctl -u gueridon -f          # Tail logs
```

- **Two `EnvironmentFile`s.** `/opt/gueridon/.env` holds `TAILSCALE_HOSTNAME`, `VAPID_SUBJECT`, `ENABLE_CLAUDEAI_MCP_SERVERS`, and `CC_MODEL` (not in the unit file; `.env.example` has placeholders; `.env` is gitignored). The unit **also** sources `/etc/claude-code/vertex.env` — the shared dotfiles Vertex config (`CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, model IDs) — which is what puts the **Vertex lane** (`claude -p`) on Vertex billing. The **Teams lane** spawns strip this set per-spawn (`buildRemoteControlEnv`) so RC comes up on Teams, which is the only billing the claude.ai relay attaches to.
- **`KillMode=control-group`** — on restart, systemd kills everything in the cgroup: tsx launcher, node server, CC processes, and anything CC spawned (chrome via Passe, python http.server, etc.). This frees port 3001 cleanly and prevents orphan accumulation. **CC resume still works** — session state lives in JSONL on disk, not in the process. The previous `KillMode=process` caused `EADDRINUSE` crash loops (orphan node server held the port) and cgroup bloat (1.2GB of chrome renderer trees from past Passe invocations). Note: processes spawned by CC during normal operation still accumulate between restarts; a periodic restart (or any crash) cleans them up.
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
| `state-builder.ts` | Pure state machine translating CC stdout events into the frontend state shape. `handleEventSignal()` → StateSignal (text/structure/status/ask_user). `getCurrentMessage()` exposes in-flight streaming message. |
| `folders.ts` | Folder scanning (two-level: projects + containers), session discovery, handoff reading, RC readiness (`isRcSessionReady`, `hasBonContext`) |
| `sessions.ts` | **Launcher:** `/proc`-scan for live `claude` sessions (`comm=="claude"`) — feeds the launcher's `GET /sessions` roster (gdn-batogo) |
| `deposit.ts` | Multipart/binary upload parsing, file validation, mise-style deposit to disk |
| `orphan.ts` | Orphan CC process reaping, debounced session persistence |
| `push.ts` | Web Push (VAPID) notification delivery, device-based dedup, subscribe-time stale endpoint pruning (MAX_SUBSCRIPTIONS=3) |
| `upload.ts` | Upload validation, MIME detection via magic bytes, manifest building |
| `event-bus.ts` | Typed event emitter decoupling event production from consumption |
| `request-context.ts` | Per-request AsyncLocalStorage — auto-attaches correlation IDs to events |
| `events.ts` | `BridgeEvent` type definitions, severity level mapping |
| `logger.ts` | JSON-lines structured logger subscribed to event bus |
| `status-buffer.ts` | Circular buffer of recent events for the `/status` debug endpoint |
| `content-hash.ts` | Client file hash computation + fs.watch for live stale detection |
| `fun-names.ts` | Alliterative folder name generator for share-sheet uploads |

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve index.html |
| GET | `/events` | SSE stream (hello, folders, state, text, current, ask_user, ping) |
| GET | `/folders` | List available project folders |
| POST | `/folders` | Create new project folder (git-initialised, fun-name if unnamed) |
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
| GET | `/repos` | **Launcher (ungated, read-only):** lean launcher repo list — `listRepos`, git-commit-recency order, reads no sessions. `{repos:[{name,path,lastCommit}]}` |
| POST | `/launch/:folder` | **Teams lane (gated on `GUERIDON_ENABLE_RC=1`, else 404):** spawn a `claude --remote-control` RC session; returns `{status, pid, folder, url, autoOpened, ready}` (the claude.ai attach URL, awaited up to 15s). `handleLaunch` passes `/open` as the initial prompt **only when the repo has `.bon`** (gdn-cumado conditional-`/open` — a context-less repo makes `/open` flail); `autoOpened` reflects that, `ready` is the JSONL-derived orientation status |
| GET | `/rc` | **Teams lane (gated):** live RC sessions Guéridon spawned — `{sessions:[{folder,url,pid,spawnedAt,ready}]}`. `ready` (gdn-cumado) = false while the auto-`/open` turn runs. (The launcher now reads `/sessions`, not this; `/rc` stays for the RC-only contract + tests.) |
| GET | `/sessions` | **Launcher (gated):** the launcher roster — EVERY live `claude` session (gdn-batogo), not just RC ones. `{sessions:[{pid,name,cwd,ageSec,kind,attachable,url,ready}]}`, newest first. Four kinds (gdn-riheri, +gdn-kuhaku): `kind:"rc"` = Guéridon-spawned RC (attachable; Open = claude.ai URL, End = `DELETE /launch`); `kind:"vertex"` = Guéridon's own streaming-lane `-p` session (attachable; Open = RAW `/#folder` — never percent-encoded, End = `POST /exit`); `kind:"vertex-terminal"` = a Vertex-billed session Guéridon did NOT launch (a `claudev`/`claudefv` terminal session — detected from `/proc` environ OR the cmdline `--settings` blob; read-only, shown "vertex · terminal", takeover parked as gdn-kidowe baton-pass); `kind:"local"` = hand-started/foreign non-Vertex (read-only, e.g. a terminal session in `~`). `/proc`-scans `comm=="claude"`, cross-refs `rcSessions` + the `-p` `sessions` map by pid; own-vertex wins over the generic vertex-billed detection |
| DELETE | `/launch/:folder` | **Teams lane (gated):** cleanly end an RC session — `handleRcExit` SIGTERMs it (claude's GracefulShutdown: SessionEnd hooks fire, JSONL flushed, resumable), SIGKILL fallback @ 8s. NOT a literal `/exit` keystroke |

**Key design:**
- **SSE + POST:** EventSource for server→client events, fetch POST for client→server commands. Auto-reconnects, stateless transport.
- **StateBuilder** (`server/state-builder.ts`): See module table above. `handleEventSignal()` returns a `StateSignal` classifying what changed (text/structure/status/ask_user). `getCurrentMessage()` exposes the in-flight streaming message. `handleEvent()` mutates state without returning a value.
- **Delta conflation:** CC's per-token `content_block_delta` events are accumulated on a 250ms timer and flushed as merged deltas to the state builder. This reduces SSE traffic without visible latency. The conflation infrastructure (`isStreamDelta`, `extractDeltaInfo`, `buildMergedDelta`, `PendingDelta`) lives in `bridge-logic.ts`; the timer and flush logic in `bridge.ts`.
- **SSE protocol:** Bridge emits `text` (append strings, gated by conflation timer), `current` (full `CurrentMessage` on structural changes like tool starts/completes), `state` (full snapshot at turn end), and `ask_user` (AskUserQuestion overlay). `shouldSendEvent()` suppresses `text` during mid-turn reconnect (client has authoritative snapshot from state event); `current` passes through (full replacement, safe to send).
- **Static serving:** index.html, style.css, sw.js, manifest.json, marked.js, icons, mockup.html, client modules (render-utils.js, render-chips.js, render-messages.js, render-chrome.js) — no-cache headers, same port as API.
- **Lazy spawn:** CC process starts on first prompt, not on connect.
- **SIGTERM → SIGKILL:** 3s escalation on all process kills.
- **Orphan reaping:** On startup, reads sse-sessions.json, SIGTERMs any live CC processes from the previous bridge instance.
- **Mid-turn message delivery:** When a prompt or upload arrives during an active turn, the bridge writes it directly to CC's stdin (CC buffers and processes it as the next turn). State builder tracks it immediately so the frontend shows the message. No queue, no coalescing — each message becomes a separate CC turn. Both `handlePrompt()` and `handleUpload()` use this path.
- **Mid-turn reconnect suppression:** When an SSE client reconnects during an active turn, `attachToSession` sets `client.suppressText = true`. The state snapshot the client receives is authoritative. `text` events (append-only) are suppressed until the next `state` broadcast (turn end), preventing partial chunks from corrupting the snapshot's complete text. `current` events pass through (full replacement, safe to send). Logic in `shouldSendEvent()` in `bridge-logic.ts`.
- **Upload staging:** `POST /upload/:folder?stage=true` deposits files on disk and returns the manifest without injecting a prompt. The client stages deposits as pills below the textarea; on send, `buildDepositNoteClient()` composes deposit notes + user text as one prompt. Without `?stage=true` (share-sheet flow), upload auto-injects as before.
- **`[guéridon:*]` prefix convention:** Bridge-injected messages use `[guéridon:system]`, `[guéridon:upload]` etc. StateBuilder detects these and marks as `synthetic: true` (rendered as system chips, prefix stripped). **Exception:** staged uploads contain a deposit note followed by user text — StateBuilder checks for text after the deposit suffix and keeps these as real user messages. The client's `renderUserBubble()` parses deposit notes into `📎 filename` references.
- **Deposit note parity:** `buildDepositNoteClient()` in `client/render-utils.cjs` (single source of truth) must exactly match `buildDepositNote()` in `server/upload.ts`. The parity gate test in `upload.test.ts` imports the real client function. `renderUserBubble()` also parses this format — three places coupled to one template.
- **`processAlive` field:** All `state` broadcasts include `processAlive: boolean`. The client uses `processAlive: false` to detect CC process exit (as opposed to idle between turns) — clears messages and returns to the launcher, same as the deliberate `/exit` path. Without this, stale messages lingered after natural CC exit.

### Teams lane — `claude --remote-control` (flag-gated, LIVE in prod)

The **Teams lane** (gated on `GUERIDON_ENABLE_RC=1`; **LIVE in prod** — flag set in
`/opt/.env` 2026-06-29) spawns a claude.ai-attachable session instead of a `claude -p`
pipe. Driving moves to claude.ai's native UI (Desktop via account-sync / iOS / web); Guéridon
keeps only the launch/notify/lifecycle front-half. It lives **alongside** the Vertex/`-p` lane —
both are first-class, chosen at the launcher's two buttons (`gdn-deloce`); `spawnCC` and its
billing modes are untouched. Full framing: `.bon/understanding.md` → **Billing lanes**.
**Built + deployed + proven end-to-end:** the spawn path, URL capture,
push, the **launcher UI** (`launch.html` at `/launch.html`; bare `/` redirects here), the
**two-lane chooser** (`gdn-deloce` — Vertex | Teams buttons), **clean End** (`DELETE /launch` →
SIGTERM graceful shutdown, SessionEnd hooks fire), **conditional auto-`/open`** + readiness
spinner (`gdn-cumado`), the **live-sessions roster** (`gdn-batogo`), launch-notify gating
(`gdn-nagepa`), and **endpoint tests** (`gdn-towiva`). The launcher's top section is a roster
of EVERY live `claude` session (`GET /sessions`) — Guéridon-owned sessions are attachable
(RC: Open/End/orienting; Vertex `-p`: Open = raw `/#folder`, End = `/exit` — gdn-riheri);
hand-started/foreign sessions show read-only ("local · 44m"). The roster auto-refreshes on
tab wake + a 20s visible-only poll (gdn-hevuri). (Share-sheet→RC was CUT at the 2026-07-07
triage — gdn-fuzeba/gdn-gafode close notes have the why; the server-side upload path remains
built if it ever revives.)

| Piece | Where | What |
|------|-------|------|
| `spawnRemoteControl(folder, initialPrompt?, pushOnReady?)` | `bridge.ts` | Spawns `claude --remote-control <folder> [prompt]` in a **node-pty** (interactive TUI needs a real terminal). Reads the pty only to buffer output — never to render. `initialPrompt` (e.g. `/open`) sets `autoPrompted`; `pushOnReady` (default false) gates the URL push. |
| `buildRemoteControlEnv()` | `bridge-logic.ts` | Strips the full `VERTEX_ENV_VARS` set + CC-internal markers → the session comes up on **Teams** (which the claude.ai relay attaches to; the `-p` path's `max` mode reuses this var list). Unit-tested. |
| `extractClaudeAiUrl(buffer)` | `bridge-logic.ts` | ANSI-strips + matches the `claude.ai/code/session_…` URL (last occurrence). Unit-tested. |
| `isSessionReadyFromTail(tail)` | `bridge-logic.ts` | Readiness from a session JSONL tail (gdn-cumado): last MAIN-thread (`parent_tool_use_id` null) assistant `stop_reason==="end_turn"` (or an AskUserQuestion) → ready. `isRcSessionReady(folder, spawnedAt)` (folders.ts) is the fs glue. Unit-tested. |
| `scanClaudeSessions()` + `buildSessionRoster()` | `sessions.ts` / `bridge-logic.ts` | Roster (gdn-batogo + gdn-riheri): `/proc`-scan `comm=="claude"` for live sessions (pid/cwd/age), then classify rc/vertex/vertex-terminal/local — rc by `rcSessions` pid, vertex by the `-p` `sessions` map pid (exitCode-guarded against pid recycling), vertex-terminal by the `vertexBilled` flag `scanClaudeSessions` reads from `/proc` environ-or-cmdline (gdn-kuhaku). `GET /sessions` feeds the launcher. Pure classifier unit-tested (incl. the raw-`/#folder` %2F scar-guard + the vertexBilled-foreign case). |
| `rcSessions` map + `handleLaunch` | `bridge.ts` | Lightweight registry (separate from the `-p` `sessions` map); `POST /launch` passes `/open` only when `.bon` exists, awaits the URL (≤15s), returns `{…, autoOpened, ready}`. |
| `pushLaunchReady(folder, url)` | `push.ts` | Pushes the attach URL to the phone (sw.js opens it on tap); fires only when `rc.pushOnReady && allClients.size===0`. Launcher launches set `pushOnReady=false` (URL delivered in-page + via the roster) — the push is for phone-in-pocket paths (share-sheet) only (gdn-nagepa). |

- **Main-guard (load-bearing — do not remove):** `bridge.ts`'s `// -- Start --` block (reapOrphans, watcher, `server.listen`) runs only when `IS_ENTRYPOINT` (i.e. `tsx server/bridge.ts`). This lets tests/harnesses **import** `bridge.ts` without booting the server — critically without `reapOrphans()` clobbering the SHARED `~/.config/gueridon` state the live bridge owns. Removing the guard re-breaks import-safety.
- **Folder trust:** *no seeding needed.* CC trust **cascades from the nearest trusted ancestor dir** (empirically verified); `~/repos` is trusted and `SCAN_ROOT=~/repos`, so every launch inherits trust. Precondition for a fresh machine: trust `~/repos` once (a rebuild/setup step, not gueridon's job).
- **Billing tradeoff:** RC sessions are non-Vertex → bill to Teams/MAX (its rate limits).

## CC Process Flags (verified against CC v2.1.195, 2026-06-29; `bridge-logic.ts` is the source of truth)

```bash
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  --allowed-tools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,Task,TaskOutput,TaskStop,Skill,AskUserQuestion,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,ToolSearch,mcp__*" \
  --disallowedTools "WebFetch,TodoWrite,NotebookEdit" \
  --permission-mode default \
  --mcp-config ~/.claude/settings.json \
  --model opus[1m] \                      # optional, from CC_MODEL env var
  --session-id <uuid> \
  --append-system-prompt "The user is on a mobile device using Guéridon. ..."
```

- `--verbose` is mandatory for stream-json mode.
- `--allowed-tools` lists all tools permissively, including `mcp__*` for all MCP tools. Task subagents bypass `--allowed-tools` entirely (CC [#27099](https://github.com/anthropics/claude-code/issues/27099)), so restricting the parent without restricting Task is ineffective. We list explicitly instead of `--dangerously-skip-permissions` for auditability.
- **VertexAI tool restrictions:** When `CLAUDE_CODE_USE_VERTEX` is set, `WebSearch` is automatically moved from `--allowed-tools` to `--disallowedTools`. Vertex blocks WebSearch server-side; hiding it prevents wasted tool calls. The toggle is in `buildBaseFlags()` in `bridge-logic.ts`.
- `--mcp-config` is required because CC in `-p` mode does not auto-load MCP servers from `~/.claude/settings.json`. **The JSON file MUST contain a `"mcpServers"` key** (even `"mcpServers": {}` is fine). If the key is missing, CC v2.1.87 hangs silently during init; CC v2.1.89+ exits with code 1 and `"Does not adhere to MCP server configuration schema"` on stderr.
- **MCP via plugins (corrected 2026-06-29):** `settings.json`'s `mcpServers` is still `{}`, but bridge-spawned CC is **not** MCP-less — installed **plugins** register their own servers regardless of `--mcp-config`. The live session ran **mise** (the batterie plugin's `.claude-plugin/plugin.json` declares `mcpServers.mise`; its `server.py` shows in the process tree). So `-p` sessions get every enabled plugin's MCP servers. (`--mcp-config`'s file still MUST contain a `mcpServers` key or CC hangs/exits — see the bullet above — but that's separate from plugin-provided servers.) `ENABLE_CLAUDEAI_MCP_SERVERS` in `.env` gates the claude.ai-provided servers.
- `--disallowedTools` hides tools from the model entirely: WebFetch (returns AI summaries, use curl instead), TodoWrite (use bon), NotebookEdit (no notebooks).
- `--permission-mode default` respects settings.json allow/deny lists.
- `--model` is optional, set via `CC_MODEL` env var in `.env`. Used for VertexAI billing (live: `CC_MODEL=opus[1m]`).
- `--append-system-prompt` is built dynamically by `buildSystemPrompt()` in `bridge-logic.ts`. Includes: machine context (hostname, "this IS the production server, do not SSH here"), working directory, AskUserQuestion coaching (tool returns error on mobile, user sees tappable buttons), and `~/.claude/` write protection warning (use Bash heredoc, not Write/Edit).
- `--session-id <uuid>` for fresh sessions; `--resume <uuid>` for resuming after process kill. Decided by `resolveSessionForFolder()` in `bridge-logic.ts`.
- **Local commands (`/context`, `/cost`, `/compact`) produce NO stdout.** Bridge reads JSONL tail on empty-result turns to recover output.
- **Input format** (critical): `{"type":"user","message":{"role":"user","content":"..."}}`
- **`~/.claude/` write protection (CC v2.1.87+):** Write and Edit tools are auto-denied for `~/.claude/` paths in `-p` mode — CC returns `is_error: true` with "Claude requested permissions to edit ... which is a sensitive file." The bridge cannot intercept or override this (CC handles it internally). The system prompt coaches the model to use Bash heredoc instead. The denied tool appears in `result.permission_denials[]` but the bridge does not currently surface this to the UI.

### `--include-partial-messages` Emission Pattern

CC emits partial `assistant` events after each `content_block_stop`. Each partial is **incremental** — it contains only the NEW content block, not all blocks so far. Verified from real JSONL (3-agent dispatch):

```
partial 0: content=[thinking]         stop_reason=null
partial 1: content=[text]             stop_reason=null
partial 2: content=[tool_use Agent1]  stop_reason=null
partial 3: content=[tool_use Agent2]  stop_reason=null
partial 4: content=[tool_use Agent3]  stop_reason=tool_use
```

`parseSessionJSONL` merges same-ID partials by concatenating content arrays — correct for incremental emissions. The state builder deduplicates by `msg_id`, processing only the first partial; subsequent tool blocks arrive via `content_block_start/stop` streaming events and patch the committed message.

### CC Init Hang Diagnosis Checklist

If CC spawns but produces zero stdout (init timeout after 30s):

1. **Check the debug log** (`~/.claude/debug/<session-uuid>.txt`). Normal init = 100+ lines through permissions, MCP, setup, skills. If it stops at "Parsed repository" (8 lines), CC is hung during init.
2. **Check `--mcp-config` target** — the JSON file must have `"mcpServers": {}`. Missing key = silent hang.
3. **Check `settings.json` after any config refactor** — if mcpServers was never in the file (or was removed), the bridge-spawned CC will hang even though interactive CC works fine (because interactive CC doesn't use `--mcp-config`).
4. **strace is the definitive tool** — attach to the bridge's Node child process (not the tsx launcher), trigger a session, and look for socket/connect/openat calls. A hung CC will show zero network sockets and zero stdout writes.

### CC Environment Variables

The bridge sets these on spawned CC processes (in `spawnCC()` in `bridge.ts`):

| Variable | Value | Why |
|----------|-------|-----|
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | `1` | Reset CWD after each Bash command — sessions must stay in their project folder |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` | No TTY for background task management |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | `1` | No terminal to update |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `1` | Survey is interactive TUI, can't work through bridge |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | No telemetry/analytics from bridge-spawned processes |
| `CLAUDE_CODE_HIDE_ACCOUNT_INFO` | `1` | Account info is noise in headless mode |

VertexAI env vars (`CLAUDE_CODE_USE_VERTEX`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, model overrides) pass through from `process.env` — set them in `.env` to route CC through GCP billing. `CC_MODEL` sets the `--model` flag (e.g. `CC_MODEL=opus`).

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

All render logic lives in `client/*.cjs` modules. Each file is served by STATIC_FILES as `/filename.js` and loaded via `<script>` tags before the inline script. The inline script retains only mutable state, event wiring, and orchestrator wrappers.

**Load order matters** — classic `<script>` tags execute sequentially:
```
marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → render-overlays.js → state-handlers.js → inline script
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

**Orchestrator wrappers:** The inline script defines thin wrappers (`refreshSendButton`, `refreshPlaceholder`) that read mutable state (e.g., `liveState`, `sseCurrentFolder`, `stagedDeposits`) and pass it as explicit arguments to the extracted module functions. This avoids 5+ callers each computing the same state. Do NOT inline the module calls at each call site — use the wrappers.

| File | Exports |
|------|---------|
| `render-utils.cjs` | `esc`, `trimText`, `trimToolOutput`, `truncateThinking`, `buildDepositNoteClient`, `timeAgo`, `shortModel` |
| `render-chips.cjs` | `renderChip`, `renderThinkingChip`, `renderLocalCommand`, `attachCopyButton` |
| `render-messages.cjs` | `renderUserBubble`, `addCopyButtons`, `renderMessages` |
| `render-chrome.cjs` | `renderStatusBar`, `updatePlaceholder`, `updateSendButton` |
| `render-overlays.cjs` | `showAskUserOverlay`, `hideAskUserOverlay`, `getSlashCommands`, `renderSlashList`, `openSlashSheet`, `showStagedError`, `renderStagedDeposits` |
| `state-handlers.cjs` | `applyStateEvent`, `applyTextEvent`, `applyCurrentEvent` |

**`state-handlers.cjs` — updates + effects pattern:** Unlike render modules (which receive state and write to DOM), state handlers are pure functions that return `{ updates, effects }`. `updates` are partial liveState fields to merge; `effects` are side-effect flags (`clearStreaming`, `goHome`, `fetchFolders`, `pushNotify`, etc.) that the inline script acts on (`goHome` → navigate to the launcher; it replaced the old `openSwitcher` when the in-conversation switcher was retired, gdn-deloce). This separation keeps the branching logic testable while leaving IO (DOM mutation, fetch, location.hash) in the inline script. `handleSSEState`, the `text` listener, and the `current` listener all follow this pattern. `exitSession` reuses `handleSSEState` with a synthetic `{ sessionEnded: true }` event.

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

**CSS shell:** `css-shell.html` is the test page for validating CSS layout changes before production. See `docs/css-shell.md`. `css-empty.html` tests empty-screen layout (input docking, disconnected state). Both served by STATIC_FILES.

**Disconnected state:** `body[data-connection="disconnected"]::after` renders an amber tint overlay (pulsing between 15% and 6% opacity). Input field and buttons dimmed with `pointer-events: none`. Toggle on `/css-empty` via the folder button.

### UI features

- Dark theme only
- Markdown rendering via `marked.parse()` / `marked.parseInline()`, custom table renderer wraps `<table>` in `<div class="table-wrap">` for horizontal scroll on mobile
- Collapsible tool calls (consecutive successful calls coalesce)
- Enter never submits (mobile newlines), submit is the button
- Chunk-level updates (not token-level)
- No in-conversation session switcher (retired in gdn-deloce). The launcher (`launch.html`) is the home/chooser AND the session switchboard (gdn-vagori): repo list by git-recency + a live roster of every `claude` session — Guéridon-owned entries (rc/vertex) are tappable (Open/End), foreign ones read-only; the roster re-fetches on tab wake and polls every 20s while visible. Pick a repo → two lane buttons (Vertex | Teams). The conversation page is single-session; leaving it (folder-lozenge tap, `/exit`, session end, or bare `/`) returns to the launcher. Flick = launcher ⇄ tap-in/tap-out.
- Push notifications via service worker
- Push-to-talk: long-press anywhere on the `.btn-bar` (folder + context lozenges) activates `SpeechRecognition`. Release stops and auto-sends with `[dictated]` prefix. Send button is tap-only. Folder lozenge pulses orange (accent) during dictation. iOS system mic sounds are not suppressible.
- Turn-complete chime: 350Hz sine wave, gain 0.06, 300ms decay. Plays when `data-busy` transitions false. Uses shared `AudioContext` (created on first user gesture for Safari).
- Stale client detection: `content-hash.ts` watches client files via `fs.watch` (inotify on Linux). When files change on disk, it recomputes the SHA-256 hash and the bridge pushes a `content-updated` SSE event to all connected clients. Client also compares `contentHash` in `hello` events on reconnect. Either path sets the textarea to solid orange with "Update available — tap to reload". Frontend changes take effect without bridge restart — files are served fresh from disk, and the watcher notifies clients to reload.
- Upload staging: files deposit as pills below textarea, sent with prompt on send
- `renderUserBubble()` detects `[guéridon:upload]` blocks in user messages and renders as `📎 filename` references (both optimistic bubbles and server-state re-renders). Bare URLs are truncated to `host/…` via `truncateAutolinks()` post-processing.
- Drag-and-drop: document-level handlers with visual overlay (desktop only, mobile Safari doesn't fire drag events)

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/deploy-guide.md` | Deployment guide — systemd, Tailscale, VAPID keys |
| `docs/css-shell.md` | CSS shell test page — layout validation, streaming simulator, iOS checklist |
| `docs/empirical-verification.md` | Verified CC event schemas, edge cases, abort mechanisms |
| `docs/CC-EVENTS.md` | CC event reference for state-builder development |
