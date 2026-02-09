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

// --- Test 4: Lobby → listFolders ---

async function testLobbyListFolders(): Promise<void> {
  console.log("\n=== Test 4: Lobby → listFolders ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL); // No ?session= → lobby mode

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        console.log("[t4] lobbyConnected");
        ws.send(JSON.stringify({ type: "listFolders" }));
      }

      if (msg.type === "folderList") {
        const states = [...new Set(msg.folders.map((f: any) => f.state))];
        console.log(`[t4] folderList: ${msg.folders.length} folders, states: ${states.join(", ")}`);
        if (msg.folders.length === 0) {
          reject(new Error("folderList returned 0 folders"));
          return;
        }
        // Verify shape of first folder
        const first = msg.folders[0];
        const hasFields = first.name && first.path && first.state;
        console.log(`[t4] sample: ${first.name} (${first.state})`);
        console.log(`[t4] PASS — ${hasFields ? "shape OK" : "MISSING FIELDS"}`);
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t4 timeout")), 10_000);
  });
}

// --- Test 5: Lobby rejects prompt ---

async function testLobbyRejectsPrompt(): Promise<void> {
  console.log("\n=== Test 5: Lobby rejects prompt ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
      }

      if (msg.type === "error" && msg.error.includes("lobby")) {
        console.log(`[t5] correctly rejected: ${msg.error}`);
        console.log("[t5] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t5 timeout")), 5_000);
  });
}

// --- Test 6: Lobby rejects path traversal ---

async function testLobbyPathValidation(): Promise<void> {
  console.log("\n=== Test 6: Lobby rejects path traversal ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: "/etc/passwd" }));
      }

      if (msg.type === "error" && msg.error.includes("scan root")) {
        console.log(`[t6] correctly rejected: ${msg.error}`);
        console.log("[t6] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t6 timeout")), 5_000);
  });
}

// --- Test 7: Lobby → connectFolder → session ---

async function testLobbyConnectFolder(): Promise<void> {
  console.log("\n=== Test 7: Lobby → connectFolder → session transition ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    const events: string[] = [];

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      events.push(msg.type);

      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({
          type: "connectFolder",
          path: `${process.env.HOME}/Repos/gueridon`,
        }));
      }

      if (msg.type === "connected") {
        console.log(`[t7] transitioned to session=${msg.sessionId.slice(0, 8)} resumed=${msg.resumed}`);
        // Now try listFolders — should be rejected in session mode
        ws.send(JSON.stringify({ type: "listFolders" }));
      }

      if (msg.type === "error" && msg.error.includes("active session")) {
        console.log(`[t7] correctly rejected post-transition: ${msg.error}`);
        console.log(`[t7] event sequence: ${events.join(" → ")}`);
        console.log("[t7] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t7 timeout")), 10_000);
  });
}

// --- Run all tests ---

async function main() {
  const args = process.argv.slice(2);
  const lobbyOnly = args.includes("--lobby");

  try {
    if (!lobbyOnly) {
      await testBasicFlow();
      await testMultiTurn();
      await testReconnect();
    }
    await testLobbyListFolders();
    await testLobbyRejectsPrompt();
    await testLobbyPathValidation();
    await testLobbyConnectFolder();
    console.log("\n=== ALL TESTS PASSED ===");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===", err);
    process.exit(1);
  }
}

main();
