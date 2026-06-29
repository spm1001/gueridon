# Gueridon — Understanding

## What this is

Mobile web UI for Claude Code: phone → Node bridge (SSE+POST) → `claude -p`
stream-json, one CC process per folder. Born 2026-02-08 in a 278-commit
February sprint (lineage: claude-go → tmux scraping rejected → `claude -p`),
matured through March, parked healthy since April. The bridge protocol is
deliberately client-agnostic — no client-type negotiation, rendering is the
client's problem (see docs/kube-brain-mac-body.md).

## Portfolio status (2026-06-29 audit)

Parked-but-useful per Sameer; deployed and healthy on hezza (systemd service,
6+ days uptime, NRestarts=0, ~4 warn-lines in 6 days). The kube-era Tailscale
actions (popucu, kikowe) were closed in the 2026-06-17 review. Open items:
gdn-cabicu (permission-denied surfacing) + gdn-vigifo (its UI card, blocked on
CC #20264 subagent-permission propagation), gdn-howibu (mockup snapshots, child
fadeti), gdn-muluwo (askuser context, standalone), gdn-jevico (bridge restart
vs other sessions' subagents), gdn-gafode (iOS Shortcut), gdn-rosara (Vertex
contamination — see Substrate watch). **Filed 2026-06-29 from the audit:**
gdn-kuciku (ask_user event missing folder key → cross-session leak), gdn-mupito
(idle clientless sessions never reaped without a restart — the root cause of
the 3.7-day vivid-vale orphan, since reaped via /exit), gdn-hodoco (live gauge
still cold-starts 200k for [1m] models — half of the 06-11 gauge fix),
gdn-higido (refresh CLAUDE.md), gdn-hocede (the /rc strategic spike).

**AskUserQuestion crash fixed 2026-06-29.** The overlay crashed on mobile
(`questions.forEach is not a function`) when the model emitted the tool input
with a non-array `questions`; `state-builder.ts`'s `args.questions || []` only
caught falsy. Guarded with `Array.isArray` at both the source
(`state-builder.ts:528`) and the render site (`render-overlays.cjs`), + the
`q.options` non-array case; regression tests added. The **client** guard
deployed hot (content-hash watcher, no restart — mary-bujournal was live); the
**server** guard is on disk in `/opt` and takes effect on the next bridge
restart.

**Deploy gap (06-10) is CLOSED:** `/opt/gueridon` == dev at the latest code
commit (b03c28f); only the un-deployed dev commit is a handoff `.md`. Deploying
remains the three-step in CLAUDE.md; mind gdn-jevico (a restart kills any live
bridge sessions). Note CLAUDE.md drift the audit found (→ gdn-higido): dev repo
is `~/repos/spm1001/gueridon` (not `~/Repos/`); the unit sources a 2nd
EnvironmentFile `/etc/claude-code/vertex.env` (Vertex ON — `CLAUDE_CODE_USE_VERTEX=1`,
`CC_MODEL=opus[1m]`); "bridge sessions have zero MCP" is **false** — mise loads
via the **batterie plugin's** `mcpServers` block while `settings.json` is still
`{}`; live CC is v2.1.195 (doc says v2.1.89). `npm audit`'s 11 alerts are all
dev-toolchain (vitest/vite/esbuild/jsdom) — none on the production runtime path.

## Structural lessons (from session contributions)

- **folderName is a routing contract, not a display label.** SSE events carry
  it as a key and the client silently discards events whose folder field
  doesn't match local state. Any code that assigns folderName must produce
  exactly what scanFolders returns — the coupling is invisible in the type
  system because both are plain strings. When scanFolders went hierarchical
  ("batterie/gueridon"), session creation still used basename() and events
  vanished. Regression gate: integration test creating a nested folder,
  connecting a session, asserting the SSE event's folder field.

- **KillMode=control-group makes shutdown a race.** systemd SIGTERMs every
  process in the cgroup simultaneously — CC children may exit and fire their
  exit handlers (clearing process/turnInProgress) before the bridge's own
  shutdown handler runs. Anything you need to persist about child state must
  be snapshotted as the *first line* of shutdown(), then passed to the persist
  function — never read from the (racing) session objects. Applies to any
  future "what was CC doing when we died" feature.

## Substrate watch (2026-06-10 read, Fable first-look session)

Gueridon hand-rolled, in February, what Anthropic's stack now provides natively
piece by piece: the Agent SDK (typed stream events, session management, and
`canUseTool` — the exact affordance gdn-cabicu/gdn-vigifo are blocked on),
the `claude agents` roster/supervisor (daemonized bg sessions, respawn,
survives disconnects — overlaps orphan.ts + sse-sessions.json + idle guards),
and /rc remote control (mobile steering of existing sessions). What none of
them do: *launch* — from a phone, point a full-freedom session at any folder,
create folders, share-sheet into a fresh session, push-notify on completion.
That launcher front-half is the moat; the process-plumbing back-half should be
allowed to commoditize. Implication: prefer a substrate evaluation (SDK swap /
roster integration, in the mold of cornichon's bon-nenagu flip) over building
new features — especially permission features — on the hand-rolled stream-json
layer. Cornichon is the architectural sibling (UI shell ↔ dumb pipe ↔
folder-scoped agent host speaking NDJSON over stdio); its 10:1 deletion when
the SDK ate the parsing layer is the precedent.

**The /rc question, settled 2026-06-29 (claude-code-guide agent + the running
`~/.claude/remote/srv` daemon).** `/rc` (Remote Control) is **attach-only, and
only to *interactive TTY* sessions** — it explicitly cannot attach to a headless
`claude -p` process (open feature requests, nothing shipped), and there is **no
remote-LAUNCH capability anywhere** in Anthropic's stack. So the launcher
front-half is *more* durable than "shrink to launcher" implies: `/rc` can't
take a handoff from Guéridon's `claude -p` sessions at all. Two coherent futures, forked by gdn-hocede — **spiked & RESOLVED 2026-06-29 in
favour of B being viable:**
- **A — stays the full mobile client (status quo).** Launches *and* drives.
  Works today; cost is maintaining the hand-rolled stream-json layer (already
  ~100 CC versions adrift).
- **B — launcher that hands off to claude.ai remote control. VALIDATED.**
  `claude --remote-control <name>` is a launch FLAG (CC v2.1.195) that starts an
  interactive session with RC already active — no `/rc` send-keys gymnastics.
  The spike: spawned it headlessly in a detached tmux with Vertex vars stripped
  (`env -u CLAUDE_CODE_USE_VERTEX …`), accepted the folder-trust prompt via
  send-keys; it came up **Teams (non-Vertex)** and printed `/remote-control is
  active · … https://claude.ai/code/session_<id>`. Sameer drove that session
  from his phone via the URL, with no terminal of his own — i.e. *launch from
  mobile*, the exact gap. So Future B = spawn `claude --remote-control`
  (non-Vertex, in a pty) + push the claude.ai URL to the phone; claude.ai's
  native UI replaces the entire back-half (SSE, state-builder, delta conflation,
  render layer).
  - **Not yet spiked (the build's open work):** spawn from node with a real pty
    (tmux proved the mechanism; prod wants node-pty); auto-handle the per-folder
    trust prompt; the URL-push to the phone.
  - **Shrink ≠ delete — UX-parity caveat:** Guéridon does more than *drive* —
    the iOS share-sheet→new-session flow, push-on-turn-complete, and
    deposit/upload are launch/notify features claude.ai's remote UI does NOT
    provide. Future B is a thin launch+share-sheet+push front-end that hands the
    *driving* to claude.ai, not a deletion of Guéridon.
  - **Precondition, now on the critical path (gdn-rosara):** the spawn must be
    non-Vertex for the claude.ai relay to attach (confirmed — the spike was Teams
    and attached fine). De-Vertexing the Guéridon spawns is the gating change for
    any Future-B build.

## Future B — build framing (planned 2026-06-29, post-gdn-hocede)

**Build progress (2026-06-29 — LIVE IN PROD, loop proven end-to-end through the deployed
bridge):** Spawn path shipped earlier (`gdn-difoto` node-pty `--remote-control` Vertex→Teams
+ main-guard; `gdn-senila` URL capture; `gdn-dofuza` push; trust MOOT via `~/repos` cascade).
**Then the launcher itself shipped + DEPLOYED (`GUERIDON_ENABLE_RC=1` in `/opt/.env`, prod
@ 2f10bbd+):**
- `gdn-todidu` DONE — fresh `launch.html` (two-list: RUNNING + searchable repos), `GET /repos`
  (lean: `listRepos`/`collectRepoCandidates`, git-commit recency order, reads NO sessions so
  subagent noise can't appear), flat `.btn-send`-style button. Served at `/launch.html`.
- `gdn-rilope` DONE — RUNNING list (`GET /rc`) + **End = `DELETE /launch/:folder` → SIGTERM**.
  Open reopens the claude.ai URL. **SIGTERM is a faithful `/exit`**: claude's
  `process.on("SIGTERM")` GracefulShutdown fires SessionEnd hooks + flushes the JSONL +
  leaves the session resumable — VERIFIED via `notes-capture.log` archiving the ended glaneur
  session. (NOT SIGHUP — claude survives that; NOT typing `/exit` into the pty — view-state
  fragile, gets swallowed by menus. SIGTERM is out-of-band + reliable.) SIGKILL fallback @ 8s.
- `gdn-cumado` OPEN — auto-`/open` on launch WIRED + verified (a slash-command as the initial
  prompt fires the skill). **Spike (2026-06-29) found two refinements still to do:** (1) the
  readiness signal for "session ready for input" = first `stop_reason: end_turn` in the
  session JSONL after `/open` (clean, structured, no view-sniffing; the bridge can find the
  JSONL from just the folder — proven live). (2) `/open` latency is UNBOUNDED (good run ~1m45s;
  context-less run never finished in 220s), so any "spin until ready" UI needs a TIMEOUT
  fallback, AND auto-`/open` must be CONDITIONAL on the repo having `.bon` — an empty repo
  makes `/open` flail endlessly. So `handleLaunch` should pass `/open` only when `.bon` exists.

**Proven in prod 2026-06-29:** Sameer launched real sessions (glaneur, infra) from his phone;
the loop POST `/launch` → real Teams session + claude.ai URL → RUNNING → End (clean SIGTERM)
all verified end-to-end through `/opt`. Native surface: launched sessions appear in Claude
**Desktop** (account sync) and open on **iOS** (the Open link worked); web-vs-native is parked
(the native apps notify session-alive, so it doesn't matter — and the AASA/Universal-Link
route can't be forced from JS anyway; see below). The **old streaming UI still serves at `/`**
— additive, migrate-don't-big-bang; `gdn-deloce`/`gdn-wimera` (delete back-half + rewrite
CLAUDE.md) stay LAST.

**Native-app deep-link — investigated + closed (2026-06-29):** you CANNOT force a hezza RC
session into a native Claude app from a web page. Universal Links (`claude.ai/code/session_*`)
are unforceable from JS by design AND the installed Mac app (`com.anthropic.claudefordesktop`)
has no `applinks` entitlement (the AASA names `…claudenestfordesktop`, which isn't installed).
The forceable custom scheme `claude-cli://open?cwd&repo&q` launches a NEW LOCAL session — it
has no session-id input, so it can't attach to a remote session. Net: web/Desktop-account-sync
is the driving surface; native-attach is gated on Anthropic shipping an entitled handler.

**Open launcher follow-ups:** `gdn-cumado` (conditional-`/open` + readiness spinner, spike done),
`gdn-fuzeba` (share-sheet → RC path), `gdn-towiva` (tests for the launcher endpoints — verified
live-only so far), `gdn-nagepa` (launcher launches triple-notify; gate the push), `gdn-mupito`
(idle reaping — now LIVE-relevant: the launcher makes lingering sessions easy; `infra` is
idle-burning Teams quota as of this writing). Everything below is the original plan framing.

Shape: replace the `claude -p` + hand-rolled streaming UI with `claude
--remote-control` spawns whose `claude.ai/code` URL is pushed to the phone —
claude.ai's native UI does the driving; Guéridon keeps only the launch/notify
moat. This supersedes the substrate-watch "SDK swap" idea above as the *more
radical* commoditization: it offloads the **UI**, not just the parsing layer.
Cross-cutting decisions:

- **Spawn with a pty, not pipes.** `claude --remote-control` is an interactive
  TUI needing a controlling terminal; today's `spawnCC` (bridge.ts) pipes stdio
  for stream-json. Use node-pty. Read the pty only to extract the claude.ai URL
  and detect lifecycle — never to render.
- **Non-Vertex per spawn = the billing flip (gdn-rosara).** Strip the Vertex
  trio from the spawn env (`env -u CLAUDE_CODE_USE_VERTEX ANTHROPIC_VERTEX_PROJECT_ID
  ANTHROPIC_MODEL CLOUD_ML_REGION ANTHROPIC_DEFAULT_*_MODEL`) — confirmed in the
  spike to yield Teams, which is what the claude.ai relay attaches to. **Tradeoff,
  Sameer's call:** RC sessions bill to Teams/MAX (its rate limits), not Vertex.
  Side effect: satisfies gdn-rosara's contamination concern.
- **Folder trust — CASCADES from a trusted ancestor; no seeding needed (RESOLVED 2026-06-29, gdn-tetepu MOOT, gdn-bekegu DONE).**
  CC's trust is NOT per-path at decision time — it walks up to the nearest trusted ANCESTOR
  directory. Verified empirically (3 spawns): a fresh git folder under `~/repos/spm1001`
  spawned `--remote-control` with NO trust prompt *even though its own*
  `hasTrustDialogAccepted` *was false*; a control folder under untrusted `~` DID prompt and
  block (same code, only location changed). `~/repos` is trusted, the live
  `SCAN_ROOT=/home/modha/repos`, and `resolveFolder` only launches folders UNDER SCAN_ROOT —
  so every gueridon launch inherits trust. **NO per-folder seeding, NO `~/.claude.json` write
  — the earlier "shared-file atomic-write hazard" is GONE. DO NOT rebuild per-folder trust
  seeding; the cascade covers it.** The only precondition is "`~/repos` is trusted", handled
  as a machine-setup/rebuild step (infra runbook + `docs/deploy-guide.md` when Future B ships),
  deliberately NOT gueridon's job — keeps the launcher out of CC's shared config (option A).
  *Method note:* a claude-code-guide agent claimed "no subtree trust" (citing a glob-pattern
  feature request, #23109); the empirical spawn test contradicted it — for behaviour, test > docs agent.
- **Initial-prompt injection — CONFIRMED (2026-06-29, gdn-lohupa).**
  `claude --remote-control <name> "<prompt>"` runs the prompt autonomously AND stays
  remote-control-attachable (spiked: it executed the prompt, printed the result, and
  held the claude.ai URL).
- **One spawn mode or two — RESOLVED → mode (a).** Because injection works, ALL
  launches unify under `--remote-control`: interactive AND autonomous/share-sheet
  (pass the deposit as the initial prompt; the user can still attach via the URL to
  watch/continue). So the full render-layer deletion (O5) is on — no separate
  `claude -p` path needed.
- **What dies vs survives.** DIES (driving moves to claude.ai): SSE transport,
  state-builder.ts, delta conflation, the whole client render layer (render-*.cjs
  + streaming index.html), content-hash watcher, the AskUser overlay, the context
  gauge — which RETIRES several just-filed items (gdn-kuciku, gdn-hodoco, the
  AskUser fix's reason-to-exist). SURVIVES (the moat claude.ai lacks): folder
  picker (scanFolders/`/folders`), share-sheet ingest (deposit.ts/`/upload`),
  push (push.ts), spawn lifecycle + orphan reaping (gdn-mupito still applies — RC
  sessions are processes too).
- **Migrate, don't big-bang.** Build the `--remote-control` path alongside the
  live bridge (parallel endpoint/flag); the deletion lands LAST, only after the
  RC path proves out in daily use. Risk to accept: Guéridon becomes a thin shim
  Anthropic could obviate if they ship remote-launch — fine; thin shims are cheap
  to keep, easy to retire.
