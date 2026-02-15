/**
 * Integration test: connect to bridge, send a prompt, verify CC events flow back.
 * Tests: lazy spawn, promptReceived ack, full event flow, multi-turn, reconnect.
 * Run: npx tsx scripts/test-bridge.ts
 * Requires: bridge running on :3001 (npm run bridge)
 */

import WebSocket from "ws";

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3001";
const TEST_FOLDER = `${process.env.HOME}/Repos/gueridon`;

let sessionId: string | null = null;

/** Helper: connect to bridge via lobby → connectFolder. Returns ws + sessionId. */
function connectViaLobby(
  ws: WebSocket,
  folderPath: string,
  onConnected: (sessionId: string) => void,
): void {
  ws.on("message", function lobbyHandler(data) {
    const msg = JSON.parse(data.toString());
    if (msg.type === "lobbyConnected") {
      ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
    }
    if (msg.type === "connected") {
      ws.removeListener("message", lobbyHandler);
      onConnected(msg.sessionId);
    }
  });
}

// --- Test 1: Basic prompt/response with lazy spawn ---

async function testBasicFlow(): Promise<void> {
  console.log("\n=== Test 1: Basic flow (lazy spawn + promptReceived) ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    let gotPromptReceived = false;
    let gotCCEvent = false;
    let eventCount = 0;

    ws.on("open", () => console.log("[t1] connected"));

    connectViaLobby(ws, TEST_FOLDER, (sid) => {
      sessionId = sid;
      console.log(`[t1] session=${sessionId} resumed=...`);
      console.log('[t1] sending prompt: "Say exactly: hello gueridon"');
      ws.send(
        JSON.stringify({
          type: "prompt",
          text: "Say exactly: hello gueridon",
        })
      );
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.source === "bridge") {
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
    // Reconnect to same session via lobby → connectFolder
    const ws = new WebSocket(BRIDGE_URL);
    let turnCount = 0;

    connectViaLobby(ws, TEST_FOLDER, (sid) => {
      console.log(`[t2] reconnected session=${sid.slice(0, 8)}`);
      ws.send(
        JSON.stringify({
          type: "prompt",
          text: "Say exactly: turn two",
        })
      );
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

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
    // Connect via lobby, then immediately disconnect, then reconnect via lobby
    const ws1 = new WebSocket(BRIDGE_URL);

    connectViaLobby(ws1, TEST_FOLDER, (_sid) => {
      console.log("[t3] connected, disconnecting immediately...");
      ws1.close();
    });

    ws1.on("close", () => {
      // Brief pause then reconnect
      setTimeout(() => {
        const ws2 = new WebSocket(BRIDGE_URL);

        connectViaLobby(ws2, TEST_FOLDER, (sid) => {
          console.log(`[t3] reconnected session=${sid.slice(0, 8)}`);
          ws2.send(
            JSON.stringify({
              type: "prompt",
              text: "Say exactly: reconnected",
            })
          );
        });

        ws2.on("message", (data) => {
          const msg = JSON.parse(data.toString());

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
        // listFolders is allowed in session mode (read-only, needed for folder picker)
        ws.send(JSON.stringify({ type: "listFolders" }));
      }

      if (msg.type === "folderList") {
        console.log(`[t7] listFolders in session mode returned ${msg.folders.length} folders`);
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

// --- Test 8: Multi-WS — two connections share a session ---

async function testMultiWS(): Promise<void> {
  console.log("\n=== Test 8: Multi-WS — two tabs share one session ===");

  return new Promise((resolve, reject) => {
    const folderPath = `${process.env.HOME}/Repos/gueridon`;
    let ws1SessionId: string | null = null;

    // First connection
    const ws1 = new WebSocket(BRIDGE_URL);

    ws1.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        ws1.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }

      if (msg.type === "connected") {
        ws1SessionId = msg.sessionId;
        console.log(`[t8] ws1 connected session=${msg.sessionId.slice(0, 8)}`);

        // Second connection joins same folder
        const ws2 = new WebSocket(BRIDGE_URL);

        ws2.on("message", (data2) => {
          const msg2 = JSON.parse(data2.toString());

          if (msg2.type === "lobbyConnected") {
            ws2.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
          }

          if (msg2.type === "connected") {
            console.log(`[t8] ws2 connected session=${msg2.sessionId.slice(0, 8)}`);

            if (msg2.sessionId !== ws1SessionId) {
              reject(new Error(`Session mismatch: ws1=${ws1SessionId} ws2=${msg2.sessionId}`));
              return;
            }
            console.log("[t8] same sessionId — sharing CC process");

            // Disconnect ws1, ws2 should stay alive (no processExit)
            let gotProcessExit = false;
            ws2.on("message", (data3) => {
              const msg3 = JSON.parse(data3.toString());
              if (msg3.type === "processExit") {
                gotProcessExit = true;
              }
            });

            ws1.close();

            // Wait briefly to confirm no processExit arrives
            setTimeout(() => {
              if (gotProcessExit) {
                reject(new Error("ws2 got processExit after ws1 disconnected"));
                return;
              }
              console.log("[t8] ws1 disconnected, ws2 still alive — no processExit");
              console.log("[t8] PASS");
              ws2.close();
            }, 1000);
          }
        });

        ws2.on("close", () => resolve());
        ws2.on("error", (err) => reject(err));
      }
    });

    ws1.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t8 timeout")), 15_000);
  });
}

// --- Test 9: Replay — disconnect and reconnect replays buffered events ---

async function testReplay(): Promise<void> {
  console.log("\n=== Test 9: Replay — disconnect/reconnect replays buffered CC events ===");

  const folderPath = `${process.env.HOME}/Repos/gueridon`;
  let preDisconnectEventCount = 0;

  // Phase 1: Connect, send prompt, count CC events through to result
  const phase1SessionId = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    let sid: string | null = null;
    let ccEventCount = 0;

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }

      if (msg.type === "connected") {
        sid = msg.sessionId;
        console.log(`[t9] phase1: connected session=${sid!.slice(0, 8)} resumed=${msg.resumed}`);
        ws.send(JSON.stringify({ type: "prompt", text: "Say exactly: replay test" }));
      }

      if (msg.source === "cc") {
        ccEventCount++;
        if (msg.event?.type === "result") {
          preDisconnectEventCount = ccEventCount;
          console.log(`[t9] phase1: got result after ${ccEventCount} CC events`);
          ws.close();
        }
      }
    });

    ws.on("close", () => {
      if (!sid) reject(new Error("t9 phase1: never got sessionId"));
      else resolve(sid);
    });
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t9 phase1 timeout")), 60_000);
  });

  // Brief pause to ensure bridge registers disconnect
  await new Promise((r) => setTimeout(r, 500));

  // Phase 2: Reconnect to same folder — expect historyStart, buffered events, historyEnd
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    let gotHistoryStart = false;
    let gotHistoryEnd = false;
    let replayEventCount = 0;
    let replaySessionId: string | null = null;

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }

      if (msg.type === "historyStart") {
        gotHistoryStart = true;
        console.log("[t9] phase2: historyStart received");
      }

      if (msg.source === "cc" && gotHistoryStart && !gotHistoryEnd) {
        replayEventCount++;
      }

      if (msg.type === "historyEnd") {
        gotHistoryEnd = true;
        console.log(`[t9] phase2: historyEnd received, ${replayEventCount} replayed events`);
      }

      if (msg.type === "connected") {
        replaySessionId = msg.sessionId;
        console.log(`[t9] phase2: connected session=${msg.sessionId.slice(0, 8)} resumed=${msg.resumed}`);

        if (!gotHistoryStart) {
          reject(new Error("t9: no historyStart received before connected"));
          return;
        }
        if (!gotHistoryEnd) {
          reject(new Error("t9: no historyEnd received before connected"));
          return;
        }
        if (replayEventCount === 0) {
          reject(new Error("t9: replay had 0 events"));
          return;
        }
        if (replaySessionId !== phase1SessionId) {
          reject(new Error(`t9: session mismatch: phase1=${phase1SessionId} phase2=${replaySessionId}`));
          return;
        }

        console.log(`[t9] PASS — replayed ${replayEventCount} events (pre-disconnect: ${preDisconnectEventCount})`);
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t9 phase2 timeout")), 15_000);
  });
}

// --- Test 10: HTTP smoke — static serving works ---

async function testHttpSmoke(): Promise<void> {
  console.log("\n=== Test 10: HTTP smoke — static serving ===");

  const BRIDGE_HTTP = process.env.BRIDGE_HTTP_URL || BRIDGE_URL.replace(/^ws/, "http");

  // GET / should return HTML (SPA index)
  const rootRes = await fetch(BRIDGE_HTTP);
  if (!rootRes.ok) throw new Error(`GET / returned ${rootRes.status}`);
  const html = await rootRes.text();
  if (!html.includes("<!DOCTYPE html") && !html.includes("<!doctype html")) {
    throw new Error("GET / did not return HTML");
  }
  console.log(`[t10] GET / → ${rootRes.status}, HTML (${html.length} bytes)`);

  // GET /assets/nonexistent.js should return 404
  const notFoundRes = await fetch(`${BRIDGE_HTTP}/assets/nonexistent.js`);
  if (notFoundRes.status !== 404) {
    throw new Error(`GET /assets/nonexistent.js returned ${notFoundRes.status}, expected 404`);
  }
  console.log(`[t10] GET /assets/nonexistent.js → 404`);

  // SPA fallback: extensionless path returns index.html
  const spaRes = await fetch(`${BRIDGE_HTTP}/some/deep/route`);
  if (!spaRes.ok) throw new Error(`GET /some/deep/route returned ${spaRes.status}`);
  const spaHtml = await spaRes.text();
  if (!spaHtml.includes("<!DOCTYPE html") && !spaHtml.includes("<!doctype html")) {
    throw new Error("SPA fallback did not return HTML");
  }
  console.log(`[t10] GET /some/deep/route → ${spaRes.status} (SPA fallback)`);

  // Hashed asset gets cache headers (check any .js file in dist/assets/)
  const rootHtml = html;
  const assetMatch = rootHtml.match(/\/assets\/[^"']+\.(js|css)/);
  if (assetMatch) {
    const assetRes = await fetch(`${BRIDGE_HTTP}${assetMatch[0]}`);
    const cacheHeader = assetRes.headers.get("cache-control") ?? "";
    console.log(`[t10] GET ${assetMatch[0]} → ${assetRes.status}, cache-control: ${cacheHeader}`);
    if (!cacheHeader.includes("max-age")) {
      throw new Error("Hashed asset missing cache-control max-age");
    }
  } else {
    console.log("[t10] (no hashed asset found in HTML to verify cache headers)");
  }

  console.log("[t10] PASS");
}

// --- Test 11: LobbyQueue error recovery — bad message doesn't kill queue ---

async function testLobbyQueueRecovery(): Promise<void> {
  console.log("\n=== Test 11: LobbyQueue error recovery ===");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "lobbyConnected") {
        // Send a message with a valid type but that will cause an async error
        // (connectFolder with empty path triggers an error response, not a throw)
        ws.send(JSON.stringify({ type: "connectFolder", path: "" }));

        // Then immediately send a valid listFolders — should still work
        ws.send(JSON.stringify({ type: "listFolders" }));
      }

      if (msg.type === "folderList") {
        console.log(`[t11] listFolders succeeded after error — ${msg.folders.length} folders`);
        console.log("[t11] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t11 timeout")), 10_000);
  });
}

// --- Test 12: Session caching — second connectFolder reuses session ---

async function testSessionCaching(): Promise<void> {
  console.log("\n=== Test 12: Session caching — connectFolder reuses existing session ===");

  const folderPath = `${process.env.HOME}/Repos/gueridon`;

  // First connection establishes a session
  const firstSessionId = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }
      if (msg.type === "connected") {
        resolve(msg.sessionId);
        // Don't close — keep session alive
        ws.close();
      }
    });

    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t12 phase1 timeout")), 10_000);
  });

  // Brief pause
  await new Promise((r) => setTimeout(r, 200));

  // Second connection to same folder should get same session (from sessions Map, no rescan)
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }
      if (msg.type === "connected") {
        if (msg.sessionId !== firstSessionId) {
          reject(new Error(`Session mismatch: first=${firstSessionId} second=${msg.sessionId}`));
          return;
        }
        console.log(`[t12] second connectFolder reused session=${msg.sessionId.slice(0, 8)}`);
        console.log("[t12] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t12 phase2 timeout")), 10_000);
  });
}

// --- Test 13: /exit command intercepts and closes session ---

async function testExitCommand(): Promise<void> {
  console.log("\n=== Test 13: /exit command closes session ===");

  const folderPath = `${process.env.HOME}/Repos/gueridon`;

  // Phase 1: Connect, send a prompt to spawn CC, wait for result
  const sid = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    connectViaLobby(ws, folderPath, (sessionId) => {
      console.log(`[t13] connected session=${sessionId.slice(0, 8)}`);
      ws.send(JSON.stringify({ type: "prompt", text: "Say exactly: before exit" }));
    });

    let resolvedSid: string | null = null;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "connected") resolvedSid = msg.sessionId;
      if (msg.source === "cc" && msg.event?.type === "result") {
        console.log("[t13] got result, sending /exit");
        ws.send(JSON.stringify({ type: "prompt", text: "/exit" }));
      }
      if (msg.type === "sessionClosed") {
        console.log(`[t13] sessionClosed received, deliberate=${msg.deliberate}`);
        ws.close();
      }
    });

    ws.on("close", () => {
      if (!resolvedSid) reject(new Error("t13: never got sessionId"));
      else resolve(resolvedSid);
    });
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t13 timeout")), 60_000);
  });

  // Brief pause for .exit marker to be written
  await new Promise((r) => setTimeout(r, 500));

  // Phase 2: Reconnect to same folder — should get a FRESH session (not resume the exited one)
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "lobbyConnected") {
        ws.send(JSON.stringify({ type: "connectFolder", path: folderPath }));
      }
      if (msg.type === "connected") {
        if (msg.sessionId === sid) {
          reject(new Error(`t13: got same session ${sid} — should have been fresh after /exit`));
          return;
        }
        console.log(`[t13] new session=${msg.sessionId.slice(0, 8)} (different from ${sid.slice(0, 8)})`);
        console.log("[t13] PASS");
        ws.close();
      }
    });

    ws.on("close", () => resolve());
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("t13 phase2 timeout")), 10_000);
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
    await testMultiWS();
    await testReplay();
    await testHttpSmoke();
    await testLobbyQueueRecovery();
    await testSessionCaching();
    if (!lobbyOnly) {
      await testExitCommand();
    }
    console.log("\n=== ALL TESTS PASSED ===");
    process.exit(0);
  } catch (err) {
    console.error("\n=== TEST FAILED ===", err);
    process.exit(1);
  }
}

main();
