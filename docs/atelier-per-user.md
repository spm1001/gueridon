# Guéridon per person on the atelier

*Design note for gdn-codowe (the Guéridon half) and at-vozuva (the atelier half), 2026-09-11.*

## The shape

The atelier is MIT's shared Linux box. Its browser front door is a Cloud Run service with IAP switched on, forwarding to a verifying hop on the box, which maps the signed-in Google account to the person's OS Login username and connects to `/run/atelier/frontdoor/<user>/http.sock`. Every request that reaches that socket has been verified twice and carries `X-Atelier-User` (the Unix username) and `X-Atelier-Email`. Nothing but the door can reach the socket: the directory is `0750 <user>:frontdoor`, and only the door runs as group `frontdoor`.

Guéridon answers on that socket, one instance per person, as a **systemd user service** under their linger. That single choice settles three of the card's original questions at once:

| Question in the original brief | Answer under this shape |
|---|---|
| One multi-tenant bridge, or one per user? | One per user. The bridge never changes identity; `claude -p` runs as whoever owns the service. |
| How does the bridge verify the IAP JWT and map email to uid? | It does not. The door does both, and the socket directory is the permission boundary. Guéridon only checks that the door's verified username is its own. |
| How is the spawn privilege-separated? | It is not separated because it never has privilege: the process is the person's, inside their slice and memory cap, under `loginctl` linger. A system template unit with `User=%i` (the demo `atelier-hello@`) would escape the slice, so it is not the shape for a real service. |

What is left for Guéridon itself is small and generic, and this note lists it so the Ansible side can be read against it.

## What changes in Guéridon

**Listen on a Unix socket.** In order of precedence: systemd socket activation (`LISTEN_FDS` set, the socket on fd 3), then `BRIDGE_SOCKET=<path>`, then `BRIDGE_PORT` as today. Socket activation is preferred on the atelier because systemd owns the socket file (mode, stale-file cleanup) and Guéridon starts on the first request through the door, so eight people cost nothing while idle. For a hand-run `BRIDGE_SOCKET`, the bridge unlinks a stale file and chmods the new one `0666`: the 0750 directory is the wall, and a user process cannot `chgrp` a socket to `frontdoor` without being in that group. Putting people in the `frontdoor` group would be wrong twice over: it would let each of them traverse every other person's socket directory, and it would make the door's group a people group.

**Identity guard.** When `GUERIDON_REQUIRE_USER=<name>` is set, every request must carry `X-Atelier-User` exactly equal to it; anything else (a different name, or no header at all) is a 403 with a `request:rejected` event, `reason: identity-mismatch` or `identity-missing`. Deny by default: an edge that stopped forwarding the header would take Guéridon offline for everyone rather than open it to anyone. The header name is `GUERIDON_USER_HEADER`, default `X-Atelier-User`. Unset `GUERIDON_REQUIRE_USER` means the guard is off, which is today's localhost and Tailscale behaviour.

**CORS origin.** `PUBLIC_ORIGIN=https://<door host>` joins `https://$TAILSCALE_HOSTNAME` in the allowed set. Browsers send `Origin` on POSTs from the door's page, and the door forwards headers unchanged, so the bridge sees the door's origin.

**Roster without the Teams lane.** `GUERIDON_ENABLE_ROSTER=1` opens `GET /sessions`, `GET /recent` and `DELETE /session/:pid` on their own. `GUERIDON_ENABLE_RC=1` still opens them too, plus `/launch` and `/rc`. On the atelier every session is Vertex-billed by managed settings, and `claude --remote-control` hard-refuses under Vertex, so the Teams lane is never right there; the launcher hides its Teams button when `GET /rc` answers 404.

**No uid filter in the process scan, on purpose.** `scanClaudeSessions` finds candidate pids by `/proc/<pid>/comm`, which is world-readable, then needs `readlink /proc/<pid>/cwd` and `exe`, which the kernel refuses for another uid's process (ptrace access mode). Foreign sessions therefore already fall out of the roster, and `DELETE /session/:pid` fails its `isLiveClaudePid` check the same way before it ever signals. That is a property of the kernel, not of this code, so it is measured on the atelier (a `comm=claude` process under a second user stays out of the first user's roster) rather than re-implemented here.

## What the atelier provides (mit-atelier, role `gueridon`)

- `nodejs`, `npm`, `build-essential` (node-pty compiles from source on Linux), a root-owned checkout at `/opt/gueridon` pinned to a ref, `npm ci`.
- `/etc/systemd/user/gueridon.socket` (`ListenStream=/run/atelier/frontdoor/%u/http.sock`, `SocketMode=0666`, `ConditionPathIsDirectory=/run/atelier/frontdoor/%u`) and `/etc/systemd/user/gueridon.service` (`GUERIDON_REQUIRE_USER=%u`, `GUERIDON_ENABLE_ROSTER=1`, `SCAN_ROOT=%h/repos`, `PUBLIC_ORIGIN`, `EnvironmentFile=-%h/.config/gueridon/env` for a person's own overrides), enabled with `systemctl --global enable gueridon.socket` so no home is written. People not in `atelier_people` have no socket directory, so the condition skips the unit for them.
- Per-person state stays where Guéridon already puts it: `~/.config/gueridon/` (VAPID keys when they generate them, session persistence, shutdown marker). Push notifications are off until a person has `vapid.json`; that is a first-login nicety, not part of this change.

## Checks that count

- `curl --unix-socket /run/atelier/frontdoor/<user>/http.sock -H 'X-Atelier-User: <user>' http://x/` answers (a redirect to the launcher); the same with no header, or another name, is 403. Run as root, which can traverse the directory; the play asserts it on every run.
- From a signed-in browser, the door shows the launcher; a prompt in a repo spawns `claude` and `ps -o user= -C claude` on the box names the person.
- Two people, two rosters: the second identity (mit.kg@itv.com's first login) is the outstanding leg and is tracked on the atelier board (at-sidonu, at-magima step 7).
