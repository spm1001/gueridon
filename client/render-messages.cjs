/**
 * render-messages.js — Message renderers for the Guéridon frontend.
 *
 * renderUserBubble: parses deposit notes into 📎 file refs + remaining text.
 * addCopyButtons: injects copy buttons into <pre> blocks (delegates to attachCopyButton).
 *
 * Depends on render-chips.js (attachCopyButton via window.Gdn) and
 * marked.js (globalThis.marked). Both must be loaded before this file.
 *
 * Load order: marked.js → render-utils.js → render-chips.js → render-messages.js → inline script
 */

// Dependencies — loaded by earlier <script> tags (browser) or test setup (Node/jsdom)
const { attachCopyButton } = window.Gdn;
const _marked = globalThis.marked;

/** Inject copy buttons into all <pre> blocks inside a container. */
function addCopyButtons(container) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.code-copy-btn')) continue;
    const code = pre.querySelector('code');
    attachCopyButton(pre, (code || pre).textContent);
  }
}

/**
 * Parse deposit notes out of user message content.
 * Returns HTML: 📎 file refs (if any) + remaining text rendered via marked.parseInline.
 */
function renderUserBubble(content) {
  const DEPOSIT_END = 'manifest.json has full metadata. Read the files if relevant to our conversation.';
  let remaining = content;
  const fileNames = [];

  while (remaining.includes('[gu\u00E9ridon:upload]')) {
    const start = remaining.indexOf('[gu\u00E9ridon:upload]');
    const endIdx = remaining.indexOf(DEPOSIT_END, start);
    if (endIdx === -1) break;

    const block = remaining.slice(start, endIdx + DEPOSIT_END.length);
    const filePattern = /  - (\S+) \(/g;
    let m;
    while ((m = filePattern.exec(block)) !== null) fileNames.push(m[1]);

    remaining = remaining.slice(0, start) + remaining.slice(endIdx + DEPOSIT_END.length);
  }

  remaining = remaining.replace(/^\n+/, '').replace(/\n+$/, '');
  let html = '';
  if (fileNames.length > 0) html += `<div class="msg-files">\u{1F4CE} ${fileNames.join(', ')}</div>`;
  if (remaining) html += _marked.parseInline(remaining);
  return html;
}

// --- Exports ---
const mod = { addCopyButtons, renderUserBubble };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
