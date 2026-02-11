#!/usr/bin/env python3
"""Context profiler for Claude Code stream-json sessions.

Spawns a CC process and tracks per-turn token usage with cache breakdown.
Useful for diagnosing context burn, cache invalidation, and gauge accuracy.

Usage:
    python3 scripts/context-profiler.py                    # Interactive mode
    python3 scripts/context-profiler.py --turns 10         # Auto "Say OK" for N turns
    python3 scripts/context-profiler.py --wait 330         # Insert pause (cache expiry test)
    python3 scripts/context-profiler.py --file path.jsonl  # Analyze existing session JSONL

Examples:
    # Basic per-turn profiling
    python3 scripts/context-profiler.py --turns 5

    # Test cache expiry (5.5 min wait after turn 3)
    python3 scripts/context-profiler.py --turns 3 --wait 330 --turns-after 5

    # Analyze a kube session
    ssh kube cat ~/.claude/projects/.../session.jsonl | python3 scripts/context-profiler.py --file -
"""
import subprocess, json, sys, threading, queue, uuid, time, argparse


def parse_args():
    p = argparse.ArgumentParser(description="Profile CC context usage per turn")
    p.add_argument("--turns", type=int, default=0, help="Auto-send 'Say OK' for N turns")
    p.add_argument("--wait", type=int, default=0, help="Seconds to pause after initial turns")
    p.add_argument("--turns-after", type=int, default=5, help="Turns after the wait")
    p.add_argument("--prompt", type=str, default=None, help="Custom first prompt (e.g. 'Load arc skill')")
    p.add_argument("--file", type=str, default=None, help="Analyze existing JSONL (- for stdin)")
    return p.parse_args()


HEADER = f"{'Turn':>4} {'Total':>9} {'New':>7} {'CCreate':>9} {'CRead':>9} {'Out':>5} {'Delta':>8} | Note"
SEP = "-" * 90


def print_row(turn, total, inp, cc, cr, out, delta, note, flag=""):
    print(f"{turn:>4} {total:>9,} {inp:>7,} {cc:>9,} {cr:>9,} {out:>5} {delta:>+8,} | {note}{flag}", flush=True)


def analyze_jsonl(source):
    """Analyze an existing session JSONL file."""
    print(HEADER)
    print(SEP)
    prev = 0
    turn = 0
    for line in source:
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get("type") != "assistant":
            continue
        msg = obj.get("message", {})
        usage = msg.get("usage", {})
        inp = usage.get("input_tokens", 0)
        cc = usage.get("cache_creation_input_tokens", 0)
        cr = usage.get("cache_read_input_tokens", 0)
        out = usage.get("output_tokens", 0)
        total = inp + cc + cr
        if total == 0:
            continue
        turn += 1
        delta = total - prev
        content = msg.get("content", [])
        note = ""
        for b in content:
            if b.get("type") == "text":
                note = b["text"][:40]
                break
            elif b.get("type") == "tool_use":
                note = f'[{b["name"]}]'
                break
        flag = ""
        if delta > 5000:
            flag = " <<<"
        if delta < -10000:
            flag = " <<< COMPACTION"
        print_row(turn, total, inp, cc, cr, out, delta, note, flag)
        prev = total
    print(f"\nPeak: {prev:,} tokens ({prev * 100 // 200000}% of 200K window)")


def run_live(args):
    """Spawn CC and profile live turns."""
    session_id = str(uuid.uuid4())
    proc = subprocess.Popen(
        [
            "claude", "-p", "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--session-id", session_id,
            "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
        ],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1,
    )

    q: queue.Queue = queue.Queue()
    threading.Thread(
        target=lambda: [q.put(l.rstrip()) for l in proc.stdout] or q.put(None),
        daemon=True,
    ).start()

    def send(text):
        proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
        proc.stdin.flush()

    def wait_for_result():
        last_total = last_inp = last_cc = last_cr = last_out = 0
        while True:
            line = q.get()
            if line is None:
                return last_total, last_inp, last_cc, last_cr, last_out
            obj = json.loads(line)
            if obj.get("type") == "assistant":
                usage = obj.get("message", {}).get("usage", {})
                inp = usage.get("input_tokens", 0)
                cc = usage.get("cache_creation_input_tokens", 0)
                cr = usage.get("cache_read_input_tokens", 0)
                t = inp + cc + cr
                if t > 0:
                    last_total, last_inp, last_cc, last_cr = t, inp, cc, cr
                    last_out = usage.get("output_tokens", 0)
            elif obj.get("type") == "result":
                return last_total, last_inp, last_cc, last_cr, last_out

    print(f"Session: {session_id}")
    print(HEADER)
    print(SEP)

    prev = 0
    turn = 0

    def do_turn(msg, label=""):
        nonlocal prev, turn
        send(msg)
        total, inp, cc, cr, out = wait_for_result()
        turn += 1
        delta = total - prev
        note = label or msg[:40]
        flag = " <<<" if delta > 5000 else ""
        print_row(turn, total, inp, cc, cr, out, delta, note, flag)
        prev = total

    # Custom first prompt
    if args.prompt:
        do_turn(args.prompt, args.prompt[:40])

    # Initial turns
    for _ in range(args.turns):
        do_turn("Say OK.", "auto")

    # Wait phase
    if args.wait > 0:
        print(f"\n--- Waiting {args.wait}s ---", flush=True)
        for remaining in range(args.wait, 0, -30):
            print(f"    {remaining}s remaining...", flush=True)
            time.sleep(min(30, remaining))
        print("--- Wait complete ---\n", flush=True)

        for _ in range(args.turns_after):
            do_turn("Say OK.", "post-wait")

    # Interactive if no auto turns specified
    if args.turns == 0 and not args.prompt:
        print("\nInteractive mode. Type messages (Ctrl-C to stop).")
        try:
            while True:
                msg = input("> ")
                if msg.strip():
                    do_turn(msg)
        except (KeyboardInterrupt, EOFError):
            pass

    proc.stdin.close()
    proc.wait(timeout=5)
    print(f"\nPeak: {prev:,} tokens ({prev * 100 // 200000}% of 200K window)")


if __name__ == "__main__":
    args = parse_args()
    if args.file:
        if args.file == "-":
            analyze_jsonl(sys.stdin)
        else:
            with open(args.file) as f:
                analyze_jsonl(f)
    else:
        run_live(args)
