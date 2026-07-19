# Gueridon — Understanding

## What this is

Mobile web UI for Claude Code: phone → Node bridge (SSE+POST) → `claude -p`
stream-json, one CC process per folder. Born 2026-02-08 in a 278-commit
February sprint (lineage: claude-go → tmux scraping rejected → `claude -p`),
matured through March, parked healthy since April. The bridge protocol is
deliberately client-agnostic — no client-type negotiation, rendering is the
client's problem (see docs/kube-brain-mac-body.md).

## Portfolio status (2026-06-29 audit)

Parked-but-useful per Sameer; deployed and healthy — **moved hezza → tube
2026-07-06** (iw-numeho estate migration; phone URL now
`https://tube.atlas-cloud.ts.net`). **Deploy wrinkle found 2026-07-07:**
`/opt/gueridon` on tube is a plain rsync'd copy, NOT a git checkout — content
matches dev @ 1097d3e, but CLAUDE.md's deploy step 2 (`git pull` in /opt)
cannot work until /opt is re-cloned. The 07-06 cutover restart also killed a
live phone session (KillMode=control-group) → gdn-bumido filed. **2026-07-07 board triage (Sameer + Claude, full-brief re-read): 13 open → 9,
all bite.** CUT with recorded close-notes (read them before re-filing anything
similar): gdn-vigifo (permission card — lockdown posture abandoned), gdn-jevico
(warn-before-deploy — folded into deploy discipline + bumido note), gdn-mupito
(idle reaping — motivations self-eroded), the whole share-sheet cluster
gdn-gafode/gdn-fuzeba/gdn-sureje (revealed preference: Shortcut broken since
Feb, unmissed; Sameer's own page→markdown iOS Shortcut covers the need),
gdn-howibu/gdn-fadeti (mockup outcome closed achieved-in-substance, snapshot
tests veiled), gdn-bumido (KillMode stays control-group; deploy discipline =
enumerate live sessions before restart; /opt re-clone extracted to gdn-pawoso).
**Same night, the switchboard half SHIPPED (deployed @ 0f91793, phone-verified
live on spm1001/jeton):** gdn-riheri ✓ (roster is three-kind rc/vertex/local —
own `-p` sessions attachable, Open = RAW `/#folder`, End = `/exit`) and
gdn-hevuri ✓ (wake-refetch + 20s visible-only poll; Sameer's phone poll observed
beating in /status recentEvents). gdn-pawoso ✓ (/opt re-cloned from GitHub —
`git pull` deploys work again). OPEN under **gdn-vagori**: gdn-heroso
(resumable-but-idle conversations in the roster — verify-first fork, armed now
that riheri+hevuri are live; only build if the missing-feeling persists) and
gdn-pefipi (extract the launcher's inline roster row-builder to a tested client
module — the raw-hash blind-spot class, now three branches deep). Standalone:
gdn-harili (.env template — verified gap: live .env 6 keys, .env.example 3),
gdn-muluwo (AskUser chips), gdn-hodoco (1M gauge), gdn-lometu (MCP probe — the
live error text is in its brief now; per-server globs confirmed valid).

**2026-07-07 same night: bridge restarted for the new LLM creds** — dotfiles
c185f9a repointed Vertex billing; the 04:00-booted bridge still carried the old
project. Restart verified: bridge env now `ANTHROPIC_VERTEX_PROJECT_ID=
itv-mit-llm-sameer`. (Restart was checked safe first: /status showed zero
sessions/clients, and this CC session confirmed itself a terminal child, not a
bridge child.)

**2026-07-09 — three tickles from a live phone-screenshot session (all shipped +
deployed + live-verified).** Root cause of all of it: Guéridon assumes it *owns*
every session it renders; the moment it renders one it doesn't own — a **Vertex
`claudefv` terminal session** sharing the folder+JSONL — the view goes stale
(one-time `replayFromJSONL` at attach, no watcher, while the terminal keeps
writing) and the roster mis-classifies it (`local`, because its pid isn't in the
`-p` `sessions` map). Ships:
- **gdn-kariru** — Guéridon's catch-all `window.onerror` was painting a red
  "Guéridon JS error" banner for a **StopTheMadness Safari-extension** error
  (`webkit-masked-url://`). `__gdnIsForeignError` (index.html) filters extension
  schemes / no-same-origin-frame stacks from both the banner and `/client-error`.
  The banner keeps its real dead-module job (gdn-lemega).
- **gdn-kuhaku** — the roster's **4th kind `vertex-terminal`** (was three:
  rc/vertex/local). `scanClaudeSessions` reads `/proc/<pid>/environ` OR the
  cmdline `--settings` blob for `CLAUDE_CODE_USE_VERTEX` (the wrappers put it in
  **cmdline**, systemd/`-p` in **environ** — must check both). A foreign
  Vertex-billed proc → `vertex-terminal` (read-only, "vertex · terminal · 1h");
  own `-p` vertex still wins as attachable.
- **gdn-wuvujo** — the launcher's repo list now **hides repos that have a live
  session** (client-side: `liveSessionNames` Set, filtered before the search
  query). De-dups the roster AND enforces one-driver-per-folder by not offering a
  live repo for a 2nd launch. Re-runs each poll → a repo reappears when its
  session ends. Seam verified live: session.name == repo.name (both
  SCAN_ROOT-relative owner/repo).
- **PARKED — gdn-kidowe (baton-pass takeover):** the real "toggle terminal ⇄
  phone". A *simultaneous* mirror is impossible (two drivers, one JSONL), but a
  clean baton-pass is not: tap a `vertex-terminal` row → SIGTERM the foreign pid
  (graceful, resumable — same mechanism as RC End) → resume as Guéridon `-p`.
  SEAM TO SOLVE: a graceful exit may write a handoff, and `resolveSessionForFolder`
  treats "handoff matches latest session → start FRESH" — takeover must
  force-resume the specific id. Sameer tempted but deferred (maintenance mode).

**Deploy trap found 2026-07-09:** the first `/opt` `git pull` **aborted** —
`/opt/gueridon` had uncommitted edits to `sw.js`+`launch.html` (a past deploy
hot-edited `/opt` directly instead of commit→pull; the edits were byte-identical
to the already-committed gdn-jafebe change). Resolution: verify the local edits
against `origin/main` (`git diff origin/main -- <files>`), and if identical,
`git checkout --` them and ff-pull — the content returns via history. **Never
hot-edit `/opt`; if a pull aborts on local changes, they're almost always a past
hot-edit — don't blind-`reset`, diff against origin first.**

**2026-07-12 — End a foreign session (gdn-racuca), built + pushed @018d7e8, deploy
HELD.** Sameer hit the pincer live: a Claude Desktop-app `batterie-de-savoir` agent
(Teams-billed, shown `local · 2h`) he could neither End (owner-only `handleRcExit`)
nor relaunch over (gdn-wuvujo hides live-session repos). Fix: `DELETE /session/:pid`
→ SIGTERM by pid (see the End-able≠attachable structural lesson below). Verified
server-side (5 unit + 3 HTTP integration tests, real process killed end-to-end) and
client-side (self-render: End button on every foreign row). **NOT deployed** — the
restart ends every RC session in the bridge cgroup (incl. the self-deploying driver;
no auto-resume), and Sameer's other live sessions were alive, so gdn-racuca is parked
`waiting`. Ship with `cd /opt/gueridon && git pull && npm install && sudo systemctl
restart gueridon`, then tap-test End on a foreign row. (The original batterie-de-savoir
process self-exited before the SIGTERM test could run — desktop-app agents are ephemeral.)
Also filed **gdn-botife**: `folders.test.ts` fails 16/39 on clean `main` (pre-existing,
`scanFolders` returns `[]`; NOT from this session) — so `npm test` isn't fully green.

**2026-07-19 — gueridon now runs on node 22 (restart done + verified live).** The
prior (abandoned) session `15d19952` upgraded tube's system node Debian-20 →
NodeSource **v22.23.1** and rebuilt gueridon's `pty.node` in BOTH `/opt` and dev
against node 22 (N-API): the on-disk `pty.node` now links **no `libnode.so.115`**
(Debian node's shared lib that NodeSource's *static* node doesn't ship) — un-rebuilt,
the next 04:00 reboot would have crashed the whole bridge, since node-pty is a
top-level import. The live bridge kept running node 20 **in-memory** (inode retention)
until this session. **This session (Sameer's ask):** restarted gueridon → bridge now
on node v22.23.1 (both processes), single clean start, :3001 listening, `/repos`
responds, `pty.node` import proven (the bridge booted). No code change — pure
node-swap; `/opt` stayed at `bd6f7c5` so gdn-racuca stays HELD. Node runbook lives in
infra (`machines/tube/README.md` + OPERATIONS `libnode.so.115` gotcha, commit
`bdae9c2`); tube auto-patches 22.x via its `origin=*` unattended policy. The restart's
live-session cost surfaced the **salvage** gap (recovering + `--resume`-ing the 5 live
cgroup sessions into login shells before the restart) — captured as gdn-cepalu's third
lifecycle verb; the one-driver invariant applies to a terminal `--resume` too (end the
bridge's copy first).

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
  - **Second instance (gdn-deloce, 2026-06-30) — the hash is part of the contract,
    and it's RAW.** The launcher's Vertex button navigates to `/#<owner/repo>`; the
    conversation page matches `location.hash.slice(1)` directly against `folder.name`
    (and `sseConnectFolder` sets `location.hash = name` raw, slash intact). The button
    shipped with `encodeURIComponent(selected)`, turning the `/` into `%2F`; raw-vs-encoded
    failed to match → `handleSSEFolders` `goHome()`'d, bouncing EVERY Vertex launch straight
    back to the launcher (a glimpse of the conversation, then a bounce). Every repo is
    `owner/repo` (always a slash), so it hit 100% of launches. Fix: `"/#" + selected` (raw).
    Lesson: anything that writes `location.hash` must use the raw folder name — the slash is
    load-bearing, do not `encodeURIComponent` it. Caught by Sameer's live test, not by the
    suite (the launcher's inline JS isn't unit-tested).

- **ONE live driver per session JSONL is the invariant everything hangs off (2026-07-09).**
  Two `claude` processes resuming the same session-id both append to one JSONL → interleave and
  corrupt. The invariant forbids a second live *driver*; it says nothing against *removing* one —
  which is why **ending a foreign session is safe but attaching to it is not** (gdn-racuca, 2026-07-12):
  End is subtraction (SIGTERM by pid removes a driver — graceful, resumable, no pty needed), whereas
  attach/resume is addition (a second driver on a JSONL the first is writing = the collision). This
  single fact shapes the whole session-joining story: (a) a foreign session (`vertex-terminal` OR
  `local`) is **End-able but NOT attachable** — Guéridon can SIGTERM it by pid (`DELETE /session/:pid`,
  gdn-racuca) but has no pty to *drive* it, and attaching would collide; (b) the launcher **hides repos
  with a live session** (gdn-wuvujo) so a 2nd launch can't resume the JSONL the first is writing; (c) the
  parked baton-pass (gdn-kidowe) is a *hand-off* (SIGTERM the old, then resume), never a *simultaneous
  mirror* — precisely because two drivers can't coexist. When adding any "attach / join / resume"
  affordance, first ask: could this put a second live process on a JSONL another process is writing?
  If yes, it must hand off, not share. (Ending never triggers this — it's the safe subtraction.)
  The corollary bug it explains: Guéridon rendering a session it doesn't own shows a **frozen
  snapshot** (`replayFromJSONL` fires once at attach, no watcher) — live-tailing a foreign session
  would need a watcher+SSE path (deliberately NOT built; streaming lane is maintenance-mode).

- **Roster is FOUR-kind (rc/vertex/vertex-terminal/local) as of gdn-kuhaku.** The contract note
  stands and grew a member: anything touching the roster must move together — the classifier
  (`buildSessionRoster` in bridge-logic + the `vertexBilled` read in `sessions.ts`), the
  `launch.html` render, and CLAUDE.md's `/sessions` row. `vertex-terminal` detection reads
  `/proc` environ OR cmdline (`--settings`) — the wrappers hide Vertex in cmdline, so an
  environ-only check silently mislabels every wrapper session as `local`.
  - **The `local` bucket is HETEROGENEOUS (2026-07-12, gdn-racuca).** It's not just "hand-started
    terminal sessions" — it holds at least three distinct things that look identical in the roster:
    (1) **Claude Desktop-app agents** (the desktop app over RDP on tube — identifiable by the
    `--plugin-dir …/local-agent-mode-sessions/…` + `mcp__ccd_session__*` + `--permission-prompt-tool
    stdio` + `--replay-user-messages` cmdline signature; these are ephemeral — they come and go with
    the app), (2) **plain terminal `claude` sessions** (a human at a TUI — ending one yanks their rug),
    and (3) **RC sessions orphaned by a bridge restart** (the in-memory `rcSessions` map is lost on
    restart, so a previously-Guéridon-owned RC session demotes to `local` — this is common, fires on
    every deploy / the 04:00 reboot). All are now End-able by pid; none are attachable.
  - **End-able ≠ attachable (gdn-racuca).** Foreign rows (`local`/`vertex-terminal`) get an **End**
    button → `DELETE /session/:pid` → `handleSessionEnd` (SIGTERM by pid, `isLiveClaudePid` comm-guard,
    SIGKILL fallback @8s). No pty needed — it's the SIGTERM-by-pid primitive. Client `endSession`
    branches: owned rc → `DELETE /launch/:folder`, owned vertex → `POST /exit/:folder`, foreign →
    `DELETE /session/:pid` (with a two-tap "Sure?" arm — native `confirm()` is unreliable in iOS
    standalone). So the move-together set grew a fifth member: the End-by-pid path.

- **KillMode=control-group makes shutdown a race.** systemd SIGTERMs every
  process in the cgroup simultaneously — CC children may exit and fire their
  exit handlers (clearing process/turnInProgress) before the bridge's own
  shutdown handler runs. Anything you need to persist about child state must
  be snapshotted as the *first line* of shutdown(), then passed to the persist
  function — never read from the (racing) session objects. Applies to any
  future "what was CC doing when we died" feature.

- **Observe CC from outside via structured substrate, never the TUI.** When the
  bridge needs to know what a `claude` session is doing without driving it, read
  a structured signal, not the rendered view. Three primitives the launcher rests
  on, each reliable and testable where view-scraping is fragile:
  1. **SIGTERM = a faithful `/exit`** for a `claude` process — fires its
     `process.on("SIGTERM")` GracefulShutdown (SessionEnd hooks run, JSONL
     flushes, session stays `--resume`-able). NOT SIGHUP (survived), NOT typing
     `/exit` into the pty (swallowed by menus / mid-turn).
  2. **`stop_reason:"end_turn"` on the latest MAIN-thread assistant message**
     (filter `parent_tool_use_id` null so a finished subagent can't false-signal)
     = "turn done / ready for input". Read from the session JSONL tail; the bridge
     locates the JSONL from the folder alone (newest `*.jsonl` with
     `mtime ≥ spawnedAt`). Caveat: `/open` latency is UNBOUNDED — always pair with
     a timeout.
  3. **`/proc` `comm=="claude"`** = discover every live session, even ones Guéridon
     didn't spawn. But discovery ≠ control: with no pty handle we can *see* a
     foreign/terminal session, not drive or kill it (why the roster is read-only
     for `kind:"local"`).

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
    non-Vertex for the claude.ai relay to attach — CONFIRMED both directions
    2026-06-30 (matched-pair spike, see Billing lanes below): Teams attaches,
    Vertex is silently inert. De-Vertexing the Guéridon spawns is the gating
    change for the *Teams* lane.

## Substrate watch — 2026-07-19 update: `claude agents` closed the roster gap

The 2026-06-10 read (above) predicted Anthropic's stack would overtake gueridon's
process-plumbing back-half piece by piece. As of 2026-07-19 that has largely
happened for **session management** — verified live this session:

- **`claude agents` is now a full session manager**, not a daemon-only list. Its
  `--json` and TUI enumerate EVERY live `claude` session — interactive, background,
  AND headless `claude -p` (proven: a faithful bridge-style `-p` spawn made the count
  go 8→9). The TUI shows rich per-session status (`aiTitle`, last-message preview,
  state `awaiting/working/completed`, age) and offers **return / reply / delete +
  the `claude --resume <uuid>` command** for each. It even titles + surfaces this
  very session.
- **What `claude agents` does NOT do** (gueridon's durable residual):
  1. **Billing lane** — it labels everything `kind:interactive`, no Vertex/Teams tag.
  2. **Release a bridge-OWNED process** — a live `-p`/RC session's stdin is held by
     the bridge; `claude agents` resuming it live would collide on the one-driver
     invariant. Only gueridon can gracefully release its own grip (SIGTERM, resumable
     — the gdn-racuca End-by-pid primitive shipped 2026-07-19).
  3. **Launch from a phone** — the moat, unchanged.

**Consequence for the roadmap:** do NOT build a gdn session-enumerator (`gdn ls`)
or the salvage UUID-archaeology — `claude agents` is richer AND is a surface Sameer
already lives in (building our own would ADD a Claude surface, violating his core
"don't make me accumulate surfaces" constraint, and `--json` hands you the uuid the
archaeology used to dig for). Gueridon's job narrows to: **launch (moat) → release
for adopt → label its own launches so they're findable in `claude agents`.**

## Plan frame — session graduation (2026-07-19, gdn-cepalu descoped)

Sameer's driving scenario: launch a repo session from the **phone** (in bed / on a
train, off a link), let it **percolate**, then at the **desk** graduate it into a
first-class **terminal** session alongside his ~10 tmux claudes — WITHOUT opening
gueridon-in-a-browser (which would be yet another surface). Gueridon is the igniter;
the terminal (via `claude agents`) is where the work lives.

The Field Report's **three-axis model** is the conceptual frame for the residual
lifecycle bugs (each surviving piece maps to one axis):
- **navigation** (lobby ↔ in-session) — Symptom 2 lives here.
- **billing** (a launch PARAMETER, never a navigation mutator) — the `--name` labelling.
- **session-kind** (gdn-owned/adoptable ↔ foreign/observe-only) — adopt.

**Scope boundaries — NOT building** (substrate owns them, or over-engineering):
- `gdn ls` / bespoke enumerator — `claude agents` is richer + an existing surface.
- salvage UUID-archaeology — `claude agents --json` gives the sessionId directly.
- a full state-machine REFACTOR — the substrate removed most symptoms (Symptom 1 →
  gdn-racuca done; salvage/enumeration → `claude agents`); targeted fixes suffice.
  Keep the three-axis model as the *frame*, not as a mandate to rewrite.

**Key seams (verified this session):**
- **Symptom 2** — `launch.html` `launchVertex()` does `location.href = "/#"+selected`,
  carrying NO fresh-vs-resume intent; the conversation page → `resolveSessionForFolder`
  then resolves to *resume* whatever that folder last had. Billing-selection IS a bare
  navigation with no way to say "new." Fix = carry explicit "new" intent through the
  hash → session resolution (do NOT rebuild a state machine; thread the one bit).
- **Adopt** — `End` (SIGTERM, graceful, resumable — shipped gdn-racuca) → the session
  should appear in `claude agents` with its resume command → `return`. PROVEN for
  *terminal* sessions (the screenshot shows ended ones with `resume with: claude
  --resume …`); the load-bearing UNVERIFIED seam is whether a **bridge-owned `-p`/RC**
  session ended via gdn's SIGTERM lands there the same way. Test with ONE real
  gueridon session before building on it.
- **Labelling** — `claude -n/--name "<marker> owner/repo"` sets the display name
  (picker + terminal title); overrides the auto `aiTitle` (JSONL first-line keys:
  `aiTitle,sessionId,type`). RC already names via the `--remote-control` positional
  (currently bare `folderName`) — prefix it. Marker encodes billing (📱vertex / 📱teams),
  giving billing-visibility inside `claude agents` for gdn-launched sessions. VERIFY a
  `-p` session actually shows the `--name` in the agents view (untested for headless).

## Billing lanes — Vertex vs Teams (verified 2026-06-30)

**Vertex and RC are mutually exclusive, and that makes the streaming back-half
permanently valuable — not dead weight.** A matched-pair spike (two identical
`claude --remote-control .` spawns differing only in the Vertex env vars):

- **Vertex on** → banner `Google Vertex AI`, footer `Vertex`, **no
  `/remote-control is active`, no `claude.ai/code/session_…` URL, no `/rc`
  affordance.** RC comes up *inert*.
- **Vertex stripped (→ Teams)** → footer `Teams … /rc`, and
  `/remote-control is active · … https://claude.ai/code/session_…` prints.

**Mechanism:** claude.ai's relay binds a web/Desktop UI to a *claude.ai
first-party identity*. A Vertex session authenticates to GCP and has no claude.ai
identity, so the relay has nothing to register — there is no remote session for
the phone to attach to. This is structural, not a config we haven't found.

**Critical build rule — it degrades SILENTLY, it does not error.** A Vertex
`--remote-control` spawn just sits at a normal prompt with no URL. So you can
NEVER do "spawn RC, fall back if it doesn't attach" — a Vertex RC spawn would
hang any URL await to its timeout. **Route by billing intent BEFORE the spawn.**
(`buildRemoteControlEnv` already strips Vertex, so today's Teams lane is correct;
a two-lane launcher must *route*, never *detect-and-fallback*.)

**Two lanes, both LIVE today, decision 2026-06-30 (Sameer's call):**

| Lane | Path | UI | Billing |
|------|------|-----|---------|
| **Vertex** | `claude -p` streaming | Guéridon's own UI at `/` | Vertex (estate daily-driver) |
| **Teams** | `claude --remote-control` | claude.ai native | Teams/MAX quota |

So the streaming `-p`+render stack is the **only** path to a Vertex-billed mobile
session — it IS the Vertex lane. **gdn-mezofu/gdn-deloce/gdn-wimera reframed from
"retire the back-half" to a two-lane model:**
- **Keep the streaming lane in MAINTENANCE mode** — nips and tucks fine (so
  **gdn-kuciku and gdn-hodoco are NOT moot** — they're live Vertex-lane fixes),
  but no major new feature-building on the drift-prone stream-json layer.
- **Retire the Vertex lane ONLY on felt pain** — a future CC version breaks the
  stream-json parser, or Vertex-on-mobile stops mattering. "~100 CC versions
  adrift" = "haven't adopted new features," not "broken" (works at v2.1.196).
- **End state (gdn-deloce — SHIPPED + deployed 2026-06-30):** the launcher is the single
  entry point and offers **"Vertex"** (→ streaming lane, navigates `/#<owner/repo>`) and
  **"Teams"** (→ RC lane, `POST /launch`) buttons; the user picks billing per launch. The
  same change RETIRED the in-conversation session switcher — the launcher is now the only
  chooser; leaving a session (folder-lozenge tap, `/exit`, session end, bare `/`) returns
  to it. Net −1008/+72 (mostly deletion). CLAUDE.md rewritten for two-lane (gdn-wimera).

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
- `gdn-cumado` DONE (built+deployed+live-verified) — **conditional auto-`/open`** (`handleLaunch`
  passes `/open` only when the repo has `.bon`; else bare spawn, ready immediately) + **readiness
  spinner**. Readiness = last MAIN-thread (`parent_tool_use_id` null) assistant `stop_reason:
  end_turn` (or an AskUserQuestion) in the session JSONL — `isSessionReadyFromTail` (pure) +
  `isRcSessionReady` (fs glue, newest JSONL with mtime ≥ spawnedAt so a stale prior session can't
  false-ready). `/launch`+`/rc` carry `ready`/`autoOpened`; launcher spins "Orienting…" with a
  4-min TIMEOUT fallback (`/open` latency unbounded). Live: glaneur flipped ready at 72s.
- `gdn-nagepa` DONE — **launch-push gating** via `RCSession.pushOnReady` (default false). Launcher
  launches no longer double/triple-notify (the URL is delivered in-page + via the roster);
  `pushLaunchReady` fires only `pushOnReady && allClients.size===0`. Share-sheet (`gdn-fuzeba`)
  will opt in with `pushOnReady=true`. (Gueridon can only suppress its OWN push; the native
  claude.ai ping is outside our control — this is 3→2, removing the redundancy we own.)
- `gdn-towiva` DONE — launcher endpoint tests. `server/bridge-rc.test.ts` (node-pty + push.js
  mocked, **imports `bridge.ts` under its main-guard** — first test to do so) covers
  spawnRemoteControl/handleLaunch/handleRcExit; integration tests cover `/repos` recency-order,
  `/rc`+`/sessions` gating+shape, `/launch` traversal-400. 757 tests total.
- `gdn-batogo` DONE (built+deployed+live-verified) — **the live-sessions roster.** The launcher's
  top section now lists EVERY live `claude` session (`GET /sessions`), not just RC ones. Born when
  Sameer noticed a hand-started session in `~` was invisible. `server/sessions.ts` `/proc`-scans
  `comm=="claude"` (catches RC, `-p`, and terminal sessions; excludes node/bash/in-process
  subagents); pure `buildSessionRoster` classifies rc (attachable: Open/End) vs local (read-only,
  "local · 44m"). READ-ONLY by Sameer's pick — no kill/attach on foreign sessions (gueridon has no
  pty handle; the `~/.claude/remote` roster daemon only knows daemonized agents, not terminals).
  Live-verified: the `~` session showed `local`, a bare spawn showed `rc attachable`.

**Proven in prod 2026-06-29:** Sameer launched real sessions (glaneur, infra) from his phone;
the loop POST `/launch` → real Teams session + claude.ai URL → RUNNING → End (clean SIGTERM)
all verified end-to-end through `/opt`. Native surface: launched sessions appear in Claude
**Desktop** (account sync) and open on **iOS** (the Open link worked); web-vs-native is parked
(the native apps notify session-alive, so it doesn't matter — and the AASA/Universal-Link
route can't be forced from JS anyway; see below). The **streaming UI still serves at `/`**
— and per the 2026-06-30 two-lane decision (see Billing lanes above) it STAYS, as the
**Vertex lane**. `gdn-deloce` (the Vertex/Teams chooser + switcher retirement) SHIPPED +
deployed 2026-06-30; `gdn-wimera` (the CLAUDE.md two-lane rewrite) followed.

**Native-app deep-link — investigated + closed (2026-06-29):** you CANNOT force a hezza RC
session into a native Claude app from a web page. Universal Links (`claude.ai/code/session_*`)
are unforceable from JS by design AND the installed Mac app (`com.anthropic.claudefordesktop`)
has no `applinks` entitlement (the AASA names `…claudenestfordesktop`, which isn't installed).
The forceable custom scheme `claude-cli://open?cwd&repo&q` launches a NEW LOCAL session — it
has no session-id input, so it can't attach to a remote session. Net: web/Desktop-account-sync
is the driving surface; native-attach is gated on Anthropic shipping an entitled handler.

**Open launcher follow-ups** (cumado/towiva/nagepa/batogo all shipped 2026-06-29):
- `gdn-fuzeba` (share-sheet → RC path) — **PAUSED** mid-step-1 (pivoted to the roster). When
  resumed: re-point `handleShareUpload` to `spawnRemoteControl(folderPath, depositNote, true)` —
  the deposit note as the initial prompt, **`pushOnReady=true`** (the phone-in-pocket push the
  gdn-nagepa flag was built for); keep a `-p` fallback when RC is off (migrate-don't-big-bang).
- `gdn-mupito` (idle reaping) — **process hygiene, NOT a quota-saver, and largely ERODED.** The
  2026-06-29 "infra is idle-burning Teams quota" claim was WRONG and is retracted: an idle session
  burns ZERO tokens — cost tracks *turns* only, no passive bleed (verified: an "idle" session sits
  at flat CPU + static JSONL). Its other motivations also eroded under parallel work: invisibility
  is covered by the RUNNING list / roster (gdn-rilope/gdn-batogo), and relaunch-collision can't
  happen for RC (spawnRemoteControl is idempotent per folder). Residual case = orphan PIDs +
  ~440MB RSS per forgotten `-p` session, and that path retires with gdn-deloce. Low priority.
- `gdn-deloce` — **SHIPPED + deployed 2026-06-30.** The launcher's Vertex/Teams chooser; the
  same change RETIRED the in-conversation switcher (launcher is the sole chooser; −1008/+72 net).
  One post-ship fix: the Vertex button must write the RAW hash, not `encodeURIComponent` — the
  `%2F` broke the hash↔folder-name match and bounced every Vertex launch home (structural lesson
  #1, second instance). `gdn-wimera` — CLAUDE.md two-lane rewrite, DONE. `gdn-kuciku` — CLOSED
  (phantom: the ask_user folder key was already injected centrally by `broadcastToSession` since
  Feb; the 06-29 audit misread the call site). gdn-towiva's tests still guard
  `/repos`,`/rc`,`/sessions`,`/launch`.

Everything below is the original plan framing.

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
- **One spawn mode or two — SUPERSEDED 2026-06-30: there ARE two (see Billing
  lanes above).** Original resolution (mode (a)): because injection works, ALL
  launches unify under `--remote-control` and the `claude -p` path dies. The
  two-lane decision REVERSES this — the Vertex lane needs the `claude -p` streaming
  path (RC can't bill to Vertex), so both spawn modes survive and the launcher
  routes by billing intent. (The injection finding itself still holds: an RC spawn
  CAN take an initial prompt — used by the Teams lane's share-sheet path.)
- **What dies vs survives — SUPERSEDED 2026-06-30 by the two-lane decision (see
  Billing lanes above).** The original plan had the whole streaming stack DIE (SSE
  transport, state-builder.ts, delta conflation, client render layer, content-hash
  watcher, AskUser overlay, context gauge) once driving moved to claude.ai. That is
  now OFF: the streaming stack is the **Vertex lane** and STAYS (maintenance mode),
  so gdn-kuciku/gdn-hodoco are NOT retired — they're live Vertex-lane fixes.
  Teams-lane launches still hand driving to claude.ai; the moat claude.ai lacks
  (folder picker `/folders`, share-sheet ingest `/upload`, push, spawn lifecycle +
  orphan reaping) is unchanged across both lanes.
- **Migrate, don't big-bang.** Build the `--remote-control` path alongside the
  live bridge (parallel endpoint/flag); the deletion lands LAST, only after the
  RC path proves out in daily use. Risk to accept: Guéridon becomes a thin shim
  Anthropic could obviate if they ship remote-launch — fine; thin shims are cheap
  to keep, easy to retire.
