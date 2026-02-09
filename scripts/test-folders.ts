#!/usr/bin/env npx tsx
/**
 * Standalone test for server/folders.ts
 * Run: npx tsx scripts/test-folders.ts
 */
import { scanFolders, getLatestSession, getLatestHandoff, encodePath } from "../server/folders.js";

async function main() {
  // Test encodePath
  console.log("--- encodePath ---");
  console.log(encodePath("/Users/modha/Repos/gueridon"));
  // Should be: -Users-modha-Repos-gueridon

  // Test getLatestSession for a known folder
  console.log("\n--- getLatestSession (gueridon) ---");
  const session = await getLatestSession("/Users/modha/Repos/gueridon");
  console.log(session ? `id: ${session.id}, lastActive: ${session.lastActive.toISOString()}` : "null");

  // Test getLatestHandoff for a known folder
  console.log("\n--- getLatestHandoff (gueridon) ---");
  const handoff = await getLatestHandoff("/Users/modha/Repos/gueridon");
  console.log(handoff ? `sessionId: ${handoff.sessionId}, purpose: ${handoff.purpose}` : "null");

  // Test a folder with no sessions (if one exists)
  console.log("\n--- getLatestSession (openclaw — likely fresh) ---");
  const freshSession = await getLatestSession("/Users/modha/Repos/openclaw");
  console.log(freshSession ? `id: ${freshSession.id}` : "null (no sessions)");

  // Full scan — no active processes
  console.log("\n--- scanFolders (no active processes) ---");
  const folders = await scanFolders(new Map());
  console.log(`Found ${folders.length} folders\n`);

  for (const f of folders) {
    const badge: Record<string, string> = { active: "G", paused: "A", closed: "C", fresh: "." };
    const extra = f.handoffPurpose ? ` — ${f.handoffPurpose}` : "";
    const time = f.lastActive ? ` (${f.lastActive.slice(0, 16)})` : "";
    console.log(`[${badge[f.state]}] ${f.state.padEnd(7)} ${f.name}${time}${extra}`);
  }

  // Summary
  const counts = folders.reduce(
    (acc, f) => { acc[f.state] = (acc[f.state] || 0) + 1; return acc; },
    {} as Record<string, number>,
  );
  console.log("\nSummary:", counts);
}

main().catch(console.error);
