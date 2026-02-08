#!/usr/bin/env python3
"""Minimal Claude Code stream-json test.

Spawns a Claude Code process, sends one message, prints every event.
Use this to verify the environment works before building anything.

Usage:
    python3 scripts/hello-cc.py
    python3 scripts/hello-cc.py "Your prompt here"
"""
import subprocess, json, sys, threading, queue, uuid

SESSION_ID = str(uuid.uuid4())
PROMPT = sys.argv[1] if len(sys.argv) > 1 else "Say hello in exactly 5 words."

proc = subprocess.Popen(
    ["claude", "-p", "--verbose",
     "--input-format", "stream-json",
     "--output-format", "stream-json",
     "--include-partial-messages",
     "--replay-user-messages",
     "--session-id", SESSION_ID,
     "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
     "--tools", ""],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1
)

q = queue.Queue()
threading.Thread(target=lambda: [q.put(l.rstrip()) for l in proc.stdout] or q.put(None), daemon=True).start()

print(f"Session: {SESSION_ID}")
print(f"Prompt:  {PROMPT}\n")

proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": PROMPT}}) + "\n")
proc.stdin.flush()

while True:
    line = q.get()
    if line is None:
        break
    obj = json.loads(line)
    tp = obj.get("type", "?")
    sub = obj.get("subtype", "")

    if tp == "system" and sub.startswith("hook"):
        continue
    elif tp == "system" and sub == "init":
        print(f"[init] model={obj.get('model')} tools={len(obj.get('tools', []))} mcps={[m['name'] for m in obj.get('mcp_servers', [])]}")
    elif tp == "stream_event":
        evt = obj["event"]
        etype = evt["type"]
        if etype == "content_block_delta":
            delta = evt["delta"]
            dtype = delta.get("type", "?")
            if dtype == "text_delta":
                print(delta["text"], end="", flush=True)
            elif dtype == "thinking_delta":
                print(f"[thinking] {delta['thinking'][:60]}", flush=True)
            elif dtype == "input_json_delta":
                pass  # tool input streaming, skip in hello world
        elif etype == "message_start":
            print("[streaming] ", end="", flush=True)
        elif etype == "message_stop":
            print()
    elif tp == "assistant":
        pass  # complete message, already streamed via deltas
    elif tp == "user":
        # Replayed user message or tool result
        msg = obj.get("message", {})
        content = msg.get("content", "")
        if isinstance(content, list) and content and content[0].get("type") == "tool_result":
            print(f"[tool_result] {str(content[0].get('content', ''))[:80]}")
        elif isinstance(content, str):
            print(f"[user_replay] {content[:80]}")
    elif tp == "result":
        print(f"\n[done] turns={obj.get('num_turns')} session={obj.get('session_id', '')[:8]}...")
        break

proc.stdin.close()
proc.wait()
