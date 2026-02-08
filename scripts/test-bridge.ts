/**
 * Integration test: connect to bridge, send a prompt, verify CC events flow back.
 * Tests: lazy spawn, promptReceived ack, full event flow, multi-turn, reconnect.
 * Run: npx tsx scripts/test-bridge.ts
 * Requires: bridge running on :3001 (npm run bridge)
 */

import WebSocket from "ws";

const BRIDGE_URL = "ws://localhost:3001";

let sessionId: string | null = null;

// --- Test 1: Basic prompt/response with lazy spawn ---

async function testBasicFlow(): Promise<void> {
  console.log("\n=== Test 1: Basic flow (lazy spawn + promptReceived) ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    let gotPromptReceived = false;
    let gotCCEvent = false;
    let eventCount = 0;

    ws.on("open", () => console.log("[t1] connected"));

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.source === "bridge") {
        if (msg.type === "connected") {
          sessionId = msg.sessionId;
          console.log(`[t1] session=${sessionId} resumed=${msg.resumed}`);
          // Lazy spawn: send prompt immediately, CC spawns on demand
          console.log('[t1] sending prompt: "Say exactly: hello gueridon"');
          ws.send(
            JSON.stringify({
              type: "prompt",
              text: "Say exactly: hello gueridon",
            })
          );
        }
        if (msg.type === "promptReceived") {
          gotPromptReceived = true;
          console.log("[t1] promptReceived ack");
        }
        if (msg.type === "error") {
          console.error(`[t1] error: ${msg.error}`);
        }
      } else if (msg.source === "cc") {
        if (!gotCCEvent) {
          gotCCEvent = true;
          console.log("[t1] first CC event (CC is alive)");
        }
        eventCount++;
        const evt = msg.event;
        if (evt.type === "result") {
          const text =
            typeof evt.result === "string"
              ? evt.result
              : JSON.stringify(evt.result).slice(0, 200);
          console.log(`[t1] result: ${text}`);
          console.log(
            `[t1] PASS — ${eventCount} events, promptReceived=${gotPromptReceived}`
          );
          ws.close();
        }
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t1 timeout")), 60_000);
  });
}

// --- Test 2: Multi-turn (second message on same session) ---

async function testMultiTurn(): Promise<void> {
  console.log("\n=== Test 2: Multi-turn (second message, same process) ===");

  return new Promise((resolve, reject) => {
    // Reconnect to same session — process should still be running
    const ws = new WebSocket(`${BRIDGE_URL}?session=${sessionId}`);
    let turnCount = 0;

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.source === "bridge" && msg.type === "connected") {
        console.log(`[t2] reconnected, resumed=${msg.resumed}`);
        ws.send(
          JSON.stringify({
            type: "prompt",
            text: "Say exactly: turn two",
          })
        );
      }

      if (msg.source === "cc" && msg.event?.type === "result") {
        turnCount++;
        const text =
          typeof msg.event.result === "string"
            ? msg.event.result
            : JSON.stringify(msg.event.result).slice(0, 200);
        console.log(`[t2] result: ${text}`);
        console.log(`[t2] PASS — multi-turn works`);
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t2 timeout")), 60_000);
  });
}

// --- Test 3: Reconnect after disconnect ---

async function testReconnect(): Promise<void> {
  console.log(
    "\n=== Test 3: Reconnect (disconnect + reconnect to same session) ==="
  );

  return new Promise((resolve, reject) => {
    // Connect, then immediately disconnect, then reconnect and send prompt
    const ws1 = new WebSocket(`${BRIDGE_URL}?session=${sessionId}`);

    ws1.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.source === "bridge" && msg.type === "connected") {
        console.log("[t3] connected, disconnecting immediately...");
        ws1.close();
      }
    });

    ws1.on("close", () => {
      // Brief pause then reconnect
      setTimeout(() => {
        const ws2 = new WebSocket(`${BRIDGE_URL}?session=${sessionId}`);

        ws2.on("message", (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.source === "bridge" && msg.type === "connected") {
            console.log(`[t3] reconnected, resumed=${msg.resumed}`);
            ws2.send(
              JSON.stringify({
                type: "prompt",
                text: "Say exactly: reconnected",
              })
            );
          }

          if (msg.source === "cc" && msg.event?.type === "result") {
            const text =
              typeof msg.event.result === "string"
                ? msg.event.result
                : JSON.stringify(msg.event.result).slice(0, 200);
            console.log(`[t3] result: ${text}`);
            console.log("[t3] PASS — reconnect works");
            ws2.close();
          }
        });

        ws2.on("close", () => resolve());
        ws2.on("error", (err) => reject(err));
        setTimeout(() => reject(new Error("t3 reconnect timeout")), 60_000);
      }, 500);
    });

    ws1.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t3 timeout")), 60_000);
  });
}

// --- Run all tests ---

async function main() {
  try {
    await testBasicFlow();
    await testMultiTurn();
    await testReconnect();
    console.log("\n=== ALL TESTS PASSED ===");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===", err);
    process.exit(1);
  }
}

main();
