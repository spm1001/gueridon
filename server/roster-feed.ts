/**
 * Roster feed (gdn-jojino) — the session registry's third sink: a doorbell for the launcher.
 *
 * The launcher's session list used to learn about a change on its 20 s poll (gdn-hevuri), so
 * a dialog that put a session into `waiting` could sit unseen on the phone for up to 20 s
 * while GET /sessions already knew within ~250 ms (gdn-fusijo). This feed closes the gap the
 * way the chat view hears about its turns: an SSE stream, GET /sessions/events (Sameer,
 * 2026-09-27: "SSE because same"). It carries a nudge, not the roster —
 * `sessions-changed {pids}` — and the page refetches GET /sessions, so the /proc scan and the
 * classifier stay the one source of what a row says.
 *
 * Fed by RegistryWatcher's `upsert`/`remove` (the watcher is written once; this subscribes
 * beside the ledger), filtered to changes the roster would actually render (`rosterChanged`,
 * bound to buildSessionRoster by a test so the two cannot drift), and coalesced so a burst —
 * several records written at once, a reconcile pass — becomes one nudge. The window is a
 * throttle, not a debounce: the first change arms it and it always fires, so a steady run of
 * writes can never starve the page.
 *
 * What the registry does not carry — a row's age ticking over, an RC session's `ready` flip,
 * a process with no record — the page still picks up on its (now slower) poll.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RegistryRecord } from "./registry-watch.js";
import { sseFrame, SSE_HEADERS } from "./bridge-logic.js";

/**
 * Would this registry change alter what GET /sessions renders? Compares exactly the fields
 * buildSessionRoster reads from a record (LiveRosterInfo): the chip (`state`, not the raw
 * status — `shell` and `idle` draw the same chip), its age stamp, the tmux pane, the
 * transcript uuid and the seat. A write that only moves `updatedAt` is not a change.
 */
export function rosterChanged(prev: RegistryRecord | null, next: RegistryRecord): boolean {
  if (!prev) return true;
  return prev.state !== next.state
    || prev.statusUpdatedAt !== next.statusUpdatedAt
    || prev.tmuxPane !== next.tmuxPane
    || prev.sessionId !== next.sessionId
    || prev.configDir !== next.configDir;
}

interface Subscriber {
  res: ServerResponse;
  seq: number; // per-stream event id, like SSEClient.eventSeq
}

export interface RosterFeedOptions {
  /** Coalescing window. Default 100 ms — far below anything a person sees, enough to fold a burst. */
  coalesceMs?: number;
}

/**
 * Events:
 *  - `changed` ({ pids: number[] }) — one per coalesced burst, after every stream was written
 *  - `clients` (count: number) — a stream opened or closed
 */
export class RosterFeed extends EventEmitter {
  private readonly coalesceMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private readonly pendingPids = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;

  constructor(opts: RosterFeedOptions = {}) {
    super();
    this.coalesceMs = opts.coalesceMs ?? 100;
  }

  /** Subscribe to a RegistryWatcher (or anything emitting its `upsert`/`remove`). */
  attach(watcher: EventEmitter): void {
    const onUpsert = (rec: RegistryRecord, prev: RegistryRecord | null) => {
      if (rosterChanged(prev, rec)) this.note(rec.pid);
    };
    const onRemove = (rec: RegistryRecord) => this.note(rec.pid);
    watcher.on("upsert", onUpsert);
    watcher.on("remove", onRemove);
    this.detach = () => {
      watcher.off("upsert", onUpsert);
      watcher.off("remove", onRemove);
    };
  }

  get clientCount(): number {
    return this.subscribers.size;
  }

  /** Serve one launcher's stream. `hello` goes first so a buffering proxy flushes the headers. */
  subscribe(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, SSE_HEADERS);
    res.socket?.setKeepAlive(true, 10_000);
    const sub: Subscriber = { res, seq: 0 };
    this.subscribers.add(sub);
    res.on("close", () => {
      if (this.subscribers.delete(sub)) this.emit("clients", this.subscribers.size);
    });
    this.emit("clients", this.subscribers.size);
    this.send(sub, "hello", { version: 1 });
  }

  /** Keep-alive, driven by the bridge's shared 30 s ping loop. */
  ping(): void {
    for (const sub of this.subscribers) this.send(sub, "ping", {});
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pendingPids.clear();
    for (const sub of this.subscribers) sub.res.end();
    this.subscribers.clear();
  }

  private note(pid: number): void {
    this.pendingPids.add(pid);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  private flush(): void {
    this.timer = null;
    const pids = [...this.pendingPids];
    this.pendingPids.clear();
    for (const sub of this.subscribers) this.send(sub, "sessions-changed", { pids });
    this.emit("changed", { pids });
  }

  private send(sub: Subscriber, event: string, data: unknown): void {
    try {
      sub.seq++;
      sub.res.write(sseFrame(sub.seq, event, data));
    } catch {
      // A socket torn down under us; its `close` handler may not have run yet.
      if (this.subscribers.delete(sub)) this.emit("clients", this.subscribers.size);
    }
  }
}
