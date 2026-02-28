/**
 * render-chips.js — Chip renderers for the Guéridon frontend.
 *
 * Tool-call chips, thinking chips, local-command chips, and the shared
 * copy-button helper. Depends on render-utils.js (window.Gdn) and
 * marked.js (globalThis.marked). Both must be loaded before this file.
 *
 * Load order: marked.js → render-utils.js → render-chips.js → inline script
 */

(function() {
// Dependencies — loaded by earlier <script> tags (browser) or test setup (Node/jsdom)
const { esc, trimToolOutput, truncateThinking, THINKING_TRUNCATE } = window.Gdn;
const _marked = globalThis.marked;

/**
 * Create a copy-to-clipboard button and append it to parent.
 * Returns the button element (callers may need the reference).
 */
function attachCopyButton(parent, text) {
  const btn = document.createElement('button');
  btn.className = 'code-copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
  parent.appendChild(btn);
  return btn;
}

/** Render a local command (/context, /cost, /compact) as a chip. */
function renderLocalCommand(content) {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  const inner = match ? match[1].trim() : content;

  let summary = '';
  const lines = inner.split('\n');
  const tokensLine = lines.find(l => /\*\*Tokens:\*\*/.test(l));
  if (tokensLine) {
    summary = tokensLine.replace(/\*\*/g, '').trim();
  } else if (inner.length < 100) {
    summary = inner.replace(/\n/g, ' ').trim();
  } else {
    summary = lines.find(l => l.trim() && !l.startsWith('#')) || lines[0] || 'Command output';
    summary = summary.replace(/\*\*/g, '').trim();
  }

  const chip = document.createElement('div');
  chip.className = 'chip local-cmd-chip';

  chip.innerHTML =
    `<span class="c-status done">&#x2713;</span>` +
    `<span class="c-name">local</span>` +
    `<span class="c-path">${esc(summary)}</span>` +
    `<div class="c-detail local-cmd-detail">${_marked.parse(inner)}</div>`;

  attachCopyButton(chip.querySelector('.c-detail'), inner);

  chip.addEventListener('click', () => {
    chip.classList.toggle('expanded');
  });

  return chip;
}

/** Render a completed thinking block as a chip. */
function renderThinkingChip(thinkingText) {
  const chip = document.createElement('div');
  chip.className = 'chip thinking-done';
  const truncated = truncateThinking(thinkingText);
  const needsMore = thinkingText.length > THINKING_TRUNCATE;

  chip.innerHTML =
    `<span class="c-status done" style="color:var(--accent)">&#x2726;</span>` +
    `<span class="c-name" style="color:var(--accent)">Thought</span>` +
    `<div class="c-detail">${esc(truncated)}` +
    (needsMore ? `<span class="thinking-more" style="color:var(--accent);cursor:pointer;display:block;margin-top:4px;font-size:0.55rem">Show full thinking</span>` : '') +
    `</div>`;

  const copyBtn = attachCopyButton(chip.querySelector('.c-detail'), thinkingText);

  chip.addEventListener('click', (e) => {
    if (e.target.classList.contains('thinking-more')) {
      const detail = chip.querySelector('.c-detail');
      detail.textContent = thinkingText;
      detail.appendChild(copyBtn);
      return;
    }
    chip.classList.toggle('expanded');
  });

  return chip;
}

/** Render a tool-call chip (completed, running, or error). */
function renderChip(tc) {
  const statusClass = tc.status === 'completed' ? 'done' : tc.status === 'running' ? 'run' : 'err';
  const statusIcon = tc.status === 'completed' ? '&#x2713;' :
                     tc.status === 'running' ? '&#x25cf;' : '&#x2717;';
  const chipClass = 'chip' + (tc.status === 'error' ? ' error' : '') + (tc.status === 'running' ? ' running' : '');

  const chip = document.createElement('div');
  chip.className = chipClass;
  chip.dataset.toolId = tc.name + '|' + (tc.input || '');

  const detail = tc.input + (tc.output ? '\n' + trimToolOutput(tc.output) : '');

  chip.innerHTML =
    `<span class="c-status ${statusClass}">${statusIcon}</span>` +
    `<span class="c-name">${esc(tc.name)}</span>` +
    (tc.input ? `<span class="c-path">${esc(tc.input)}</span>` : '') +
    `<div class="c-detail">${esc(detail)}</div>`;

  attachCopyButton(chip.querySelector('.c-detail'), detail);

  chip.addEventListener('click', () => {
    chip.classList.toggle('expanded');
  });

  return chip;
}

// --- Exports ---
const mod = { attachCopyButton, renderLocalCommand, renderThinkingChip, renderChip };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
