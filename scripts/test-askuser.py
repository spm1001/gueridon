#!/usr/bin/env python3
"""Test AskUserQuestion behavior with --allowed-tools.

Spawns CC with ONLY AskUserQuestion allowed and a natural prompt
that should trigger the tool. Captures every stream-json event raw.

Usage:
    python3 scripts/test-askuser.py
"""
import subprocess, json, sys, threading, queue, uuid, time

SESSION_ID = str(uuid.uuid4())

# Natural prompt — should trigger AskUserQuestion
PROMPT = (
    "I need help choosing a database for my project. "
    "Can you ask me about my requirements before recommending one? "
    "Use AskUserQuestion to find out what matters most to me."
)

# Only allow AskUserQuestion — keeps CC from going on tool adventures
ALLOWED_TOOLS = "AskUserQuestion"

proc = subprocess.Popen(
    ["claude", "-p", "--verbose",
     "--input-format", "stream-json",
     "--output-format", "stream-json",
     "--session-id", SESSION_ID,
     "--allowed-tools", ALLOWED_TOOLS,
     "--permission-mode", "default",
     ],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1
)

q = queue.Queue()
stderr_lines = []

def read_stdout():
    for l in proc.stdout:
        q.put(l.rstrip())
    q.put(None)

def read_stderr():
    for l in proc.stderr:
        stderr_lines.append(l.rstrip())

threading.Thread(target=read_stdout, daemon=True).start()
threading.Thread(target=read_stderr, daemon=True).start()

print(f"Session: {SESSION_ID}")
print(f"Allowed: {ALLOWED_TOOLS}")
print()

# Send prompt
msg = json.dumps({"type": "user", "message": {"role": "user", "content": PROMPT}})
proc.stdin.write(msg + "\n")
proc.stdin.flush()

start = time.time()
saw_askuser = False

while True:
    try:
        line = q.get(timeout=90)
    except queue.Empty:
        print("\n[TIMEOUT] 90s")
        break
    if line is None:
        break

    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        print(f"[unparseable] {line[:120]}")
        continue

    tp = obj.get("type", "?")
    sub = obj.get("subtype", "")

    # Skip hooks
    if tp == "system" and sub.startswith("hook"):
        continue

    if tp == "system" and sub == "init":
        tools = obj.get("tools", [])
        tool_names = [str(t) for t in tools]
        print(f"[init] tools={tool_names}")
        continue

    if tp == "stream_event":
        evt = obj["event"]
        etype = evt["type"]
        if etype == "content_block_start":
            cb = evt.get("content_block", {})
            if cb.get("type") == "tool_use":
                name = cb.get("name")
                print(f"\n>>> TOOL_USE_START: {name} (id={cb.get('id')})")
                if name == "AskUserQuestion":
                    saw_askuser = True
        elif etype == "content_block_delta":
            delta = evt["delta"]
            if delta.get("type") == "text_delta":
                print(delta["text"], end="", flush=True)
            elif delta.get("type") == "input_json_delta":
                print(delta.get("partial_json", ""), end="", flush=True)
        elif etype == "message_stop":
            print()
        continue

    if tp == "assistant":
        msg_obj = obj.get("message", {})
        for block in msg_obj.get("content", []):
            if block.get("type") == "tool_use":
                print(f"\n>>> FULL TOOL_USE: {json.dumps(block, indent=2)}")
        continue

    if tp == "user":
        msg_obj = obj.get("message", {})
        content = msg_obj.get("content", "")
        if isinstance(content, list):
            for item in content:
                if item.get("type") == "tool_result":
                    print(f"\n>>> TOOL_RESULT: is_error={item.get('is_error')} content={json.dumps(item.get('content', ''))[:300]}")
        continue

    if tp == "result":
        print(f"\n>>> RESULT:")
        print(f"  is_error={obj.get('is_error')}")
        print(f"  num_turns={obj.get('num_turns')}")
        denials = obj.get("permission_denials", [])
        print(f"  permission_denials ({len(denials)}):")
        for d in denials:
            print(f"    tool={d.get('tool_name')} input={json.dumps(d.get('tool_input', {}))[:200]}")
        print(f"  result={str(obj.get('result', ''))[:300]}")
        break

elapsed = time.time() - start
print(f"\nElapsed: {elapsed:.1f}s")
print(f"AskUserQuestion attempted: {saw_askuser}")

if stderr_lines:
    print(f"\nStderr:")
    for l in stderr_lines[-5:]:
        print(f"  {l[:200]}")

proc.stdin.close()
proc.wait()
print(f"Exit code: {proc.returncode}")
