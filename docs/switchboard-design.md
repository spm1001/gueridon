# Guéridon switchboard — design pass (gdn-himaba)

**Status: draft for Sameer's review, 2026-08-29.** Written *in medias res*: every claim about the live estate below was measured this morning, on the actual mess this design exists to solve.

## The fixture — tube at 11:10, 2026-08-29

17 live `claude` processes, three wallets, five surfaces. What the current roster makes of them:

| What | Count | Wallet | Roster today shows |
|---|---|---|---|
| `claude-remote@` RC servers (~, repos, notes, bon, gueridon, infra, mise-en-space, sonde) | 8 | sameer@ | correctly hidden (infra) |
| CC daemon + `bg-spare` warm pool | 2 | — | daemon hidden; bg-spare invisible by accident |
| Vertex terminal sessions (mit-kg, gueridon, bon) | 3 | Vertex | "vertex · terminal" ✓ |
| family@ commis terminal session (pid 61402, in ~/.claude, busy) | 1 | **family@** | "local" — wallet invisible |
| `claude agents` TUI (a manager, not a session) | 1 | — | "local", End-able — wrongly offered as a session |
| **Phone-created RC-server children** (notes, ~) | 2 | sameer@ | **invisible — the roster misses them entirely** |
| Cold resumable sessions in the farm (JSONL files touched ≤7d; files, not conversations — upper bound) | ~403 across 71 project dirs | mixed | invisible by design (pid-keyed) |

Score: 4 rows shown, of which one isn't a session; 2 live phone sessions missing; no wallet dimension; none of the cold estate. This is the "I lose sight of the session" failure, photographed.

## Three fresh facts (measured this morning, they reshape the build)

1. **The roster has a live bug: `comm=="claude"` misses RC-server children.** They run under the *versioned binary* (`comm=="2.1.251"`). The durable discriminator is `readlink /proc/<pid>/exe` → `~/.local/share/claude/versions/<v>` — true for every flavour (terminal, server, child, daemon, bg-spare, commis). Fix this regardless of the rest.
2. **`claude agents --json` hands us the pid→uuid join** — sessionId, cwd, busy/idle status, short name, per pid — **but it is per-wallet**: run under sameer@ it cannot see the family@ session, and vice versa (verified both directions this morning; `CLAUDE_CONFIG_DIR=~/.claude-commis claude agents --json` returns exactly the commis session). The `/proc` scan sees all wallets but knows no uuids; the agents registries know uuids but only their own wallet. **The union of the two is the complete live view.** Where neither yields a uuid (rare: unregistered foreign session), fall back to newest-JSONL-in-cwd heuristic, marked ambiguous.
3. **Phone sessions self-identify in /proc**: an RC child's cmdline carries `--sdk-url .../cse_<body>` — the teleport id — and last night's derivation (`uuid5(namespace, ".../cse_<body>")`, trousse `teleport-id.sh`) turns that into the local uuid offline. Exact identity for precisely the lane that used to be nameless.

## The model — three layers

**Layer 1, identity (uuid-keyed, includes the cold estate).** A session-index module scans `~/.claude/projects/*/*.jsonl`: uuid (filename), cwd (from the transcript's `.cwd` — never decoded from the dirname, that mapping is one-way), mtime, entrypoint (`cli` / `sdk-cli` / `claude-desktop`), uuid version (v4 interactive, v5 programmatic). Titles come from three places: `aiTitle` in the JSONL head (cli sessions, ~24/25 have one), the Cowork Desktop sidecar (`~/.config/Claude/claude-code-sessions/…/local_*.json`, `cliSessionId` → farm uuid, human titles, 21/21 resolve), and the RC bridge log's "derived title for session_…" lines (teleport sessions, which carry no aiTitle).

**Layer 2, liveness (an attribute, not the index).** The pid scan (exe-based) ∪ per-wallet `agents --json`. Three states per session:
- **COLD** — JSONL on disk, no holder. The common case. Any surface may pick it up.
- **HELD-LOCAL** — a pid on tube holds it (terminal, Guéridon `-p`, RC-server child). Pickup = baton-pass: SIGTERM (graceful, flushes, resumable) → force-resume the explicit uuid. The kidowe seam applies: `resolveSessionForFolder` treats a matching handoff as "start fresh", so takeover must bypass that guard and force-resume the id (already written up in gdn-kidowe/gdn-merozu — do not re-derive).
- **HELD-REMOTE** — a lease with no local pid (cloud sessions). No SIGTERM available: fork, or archive first (the bridge speaks `POST /v1/sessions/<session_…>/archive`).

The discriminator between the HELD states is simply "can tube signal the holder". One driver per JSONL remains the invariant everything hangs off; End is always the safe subtraction.

**Layer 3, wallet (a property of the run, not the session).** Live: read from /proc (`CLAUDE_CONFIG_DIR` → sameer@/family@, Vertex marker → Vertex — the same dual environ/cmdline read `vertexBilled` already does). Cold: transcripts carry no account identity, so the poll *journals* observed (uuid, wallet, surface, ts) pairs as it sees them; a cold row shows its last-observed wallet, or honestly "unknown". Cross-wallet resume **always** forks (`--fork-session`) — same-id reopen under another wallet shares the JSONL with whatever still holds it.

## UI — the launcher grows one band and two chips

Three bands: **SESSIONS** (live — as today, plus wallet chip, surface glyph, busy/idle from the agents registries, and real titles), **RECENT** (cold sessions, newest ~15, filterable; title · repo · age · last wallet), **REPOS** (launch new — unchanged, including new-folder-for-play, which must work under any wallet).

Pickup flow: tap a RECENT row → wallet sheet (Vertex | Teams·sameer | Teams·family) → the conversation page force-resumes that uuid under that spawn env, forking when the wallet differs from last-observed. This works today for all three wallets because billing is just the spawn env on the `-p` lane (the streaming stack is wallet-agnostic plumbing). Pickup *into the phone-native claude.ai app* needs one spike: does `claude --remote-control --resume <uuid>` exist/work? Unverified — if yes, a cold session can also be sent to the app; if no, app-native pickup stays fork-via-Guéridon only.

**Which-launcher-when (the confusion clause):** the answer the UI states — *iOS app tiles = start new Teams work in a hot repo; Guéridon = everything else* (see everything, resume anything, any wallet, Vertex, new folders). Consequence to adjudicate with gdn-sudacu: Guéridon's own Teams spawn button is now the redundant third launcher — recommend retiring it once you confirm the servers cover the need. Your call, not taken silently.

**Scope guards.** The streaming/stream-json layer stays maintenance-mode: everything here is new modules (session-index, wallet journal) + the launcher page + spawn-env plumbing. Cross-host: v1 is tube-only; index rows carry a `host` field so a Mac federation is additive later, not a redesign. Cede-ground doctrine: each layer is a module Anthropic can eat (if `claude agents` grows wallets or the app grows cross-wallet rosters, we delete ours and keep the launcher).

## The --badly clauses, mapped

| Clause (Sameer, verbatim) | Design answer |
|---|---|
| "I lose good thinking because I lose sight of the session" (root) | The uuid-keyed index makes *existence* independent of liveness: a session that dies stays in RECENT with a title. The two invisible phone sessions in the fixture are the proof case. |
| "falls into disuse because it doesn't nail the use case" | Build order starts with the two felt pains photographed today: invisible phone sessions, invisible wallet. Each ship is independently useful. |
| "mucks up a live session" | One-driver invariant enforced structurally: cold-only resume by default, baton-pass SIGTERMs before resuming, cross-wallet always forks, End remains the only verb on held sessions. |
| "doesn't let me spawn what I need when and where (account terms)" | Wallet sheet on both launch and pickup; family@ becomes a first-class lane (today it's invisible even to `claude agents`). |
| "confuses me when to use which launcher" | The UI states the rule (tiles = new hot-repo Teams; Guéridon = everything else) and we retire our redundant Teams button via gdn-sudacu. |
| "doesn't let me create new folders for play" | REPOS band and `POST /folders` survive untouched; wallet sheet applies to new folders too. |

## Proposed build sequence (each independently shippable)

1. **Roster tells the truth** — exe-based scan; new `remote` kind for RC children (cse→uuid, title from bridge log); exclude `agents` TUI + `bg-spare` as infra; wallet chip on live rows. Fixes the live bug; smallest diff, biggest honesty gain. *(One measurement inside: is SIGTERM on an RC child clean, or is archive-from-phone the only polite end?)*
2. **Cold sessions in view** — session-index module + RECENT band, read-only (no verbs yet). Sameer sees everything; nothing can be mucked up.
3. **Pickup** — wallet sheet + force-resume explicit uuid + fork enforcement + kidowe-seam bypass. This is gdn-merozu's territory — **blocked on your --badly for it**.
4. **Spike**: `--remote-control --resume` — phone-native pickup of a cold session, yes or no.
5. **Wallet journal + health strip** — crude 429/reset recording per lane, last.

## Open with Sameer

1. gdn-merozu needs its `--badly` (blocks build 3).
2. gdn-sudacu adjudication: retire Guéridon's Teams spawn button?
3. Taste on RECENT: how deep (15? 30?), and should subagent/system-spawned v5 sessions be filtered out by default?
