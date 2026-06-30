/**
 * render-utils.js — Pure utility functions for the Guéridon frontend.
 *
 * Zero dependencies on globals or DOM state. Loaded before all other
 * client/ modules. Browser: window.Gdn namespace. Node/vitest: exports.
 *
 * Load order: marked.js → render-utils.js → (other client modules) → inline script
 */

(function() {
const THINKING_TRUNCATE = 500;

/** HTML-escape a string. */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/** Strip <local-command-stdout> tags from assistant content. */
function trimText(text) {
  if (!text) return text;
  const stdoutRe = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g;
  text = text.replace(stdoutRe, (_, inner) => inner.trim());
  return text;
}

/** Head/tail truncation of long tool output. */
function trimToolOutput(output, maxLines) {
  if (!output) return output;
  maxLines = maxLines || 30;
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const headCount = Math.ceil(maxLines / 2);
  const tailCount = Math.floor(maxLines / 2);
  const hidden = lines.length - headCount - tailCount;
  return lines.slice(0, headCount).join('\n')
    + `\n… ${hidden} lines hidden …\n`
    + lines.slice(-tailCount).join('\n');
}

/** Truncate thinking text to THINKING_TRUNCATE chars. */
function truncateThinking(text) {
  if (text.length <= THINKING_TRUNCATE) return text;
  return text.slice(0, THINKING_TRUNCATE) + '…';
}

/** Build the deposit note string for staged uploads. Parity with server/upload.ts buildDepositNote. */
function buildDepositNoteClient(folder, manifest) {
  const listing = manifest.files
    .map(f => `  - ${f.deposited_as} (${f.mime_type}, ${f.size_bytes} bytes)`)
    .join('\n');
  const warningLines = manifest.warnings.length > 0
    ? '\n\n\u26A0\uFE0F ' + manifest.warnings.join('\n\u26A0\uFE0F ')
    : '';
  return `[gu\u00E9ridon:upload] Files deposited at ${folder}/\n\n${listing}${warningLines}\n\nmanifest.json has full metadata. Read the files if relevant to our conversation.`;
}

/** Format ISO timestamp as relative time (now, 5m, 3h, 2d). */
function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 0 || mins > 525600) return '';
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
}

/** Abbreviate model name (claude-sonnet-4-5-20250514 → sonnet-4-5). */
function shortModel(model) {
  if (!model) return '';
  return model.replace('claude-', '').replace(/-\d+$/, '');
}

// Resolve a location.hash (sans '#') to a folder from the SSE folders list.
// The hash is the folder routing key — the launcher's Vertex button navigates to
// /#<owner/repo> (gdn-deloce). Tolerant of BOTH the raw name (the convention — slash
// intact) AND a percent-encoded form (e.g. "owner%2Frepo"), so an accidental
// encodeURIComponent on the write side can't strand a launch on the wrong page and
// bounce it home (the bug that shipped + was fixed 2026-06-30). Matches name or path;
// null on no hash / no match. See understanding.md "folderName is a routing contract".
function matchFolderFromHash(rawHash, folders) {
  if (!rawHash || !Array.isArray(folders)) return null;
  const candidates = [rawHash];
  try {
    const decoded = decodeURIComponent(rawHash);
    if (decoded !== rawHash) candidates.push(decoded);
  } catch (_e) { /* malformed % sequence — just use the raw form */ }
  for (const h of candidates) {
    const f = folders.find((x) => x.name === h || x.path === h);
    if (f) return f;
  }
  return null;
}

// --- Exports ---
// Browser: classic <script> sets window.Gdn
// Node/vitest: module.exports (file must be treated as CJS — see package.json "exports" or vitest config)
const mod = { esc, trimText, trimToolOutput, truncateThinking, buildDepositNoteClient, timeAgo, shortModel, matchFolderFromHash, THINKING_TRUNCATE };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
