/**
 * render-messages.js — Message renderers for the Guéridon frontend.
 *
 * renderMessages: the main render loop — takes container, messages, and an
 *   explicit options object. Zero ambient state reads.
 * renderUserBubble: parses deposit notes into 📎 file refs + remaining text.
 * addCopyButtons: injects copy buttons into <pre> blocks (delegates to attachCopyButton).
 *
 * Depends on render-utils.js and render-chips.js (via window.Gdn) and
 * marked.js (globalThis.marked). Both must be loaded before this file.
 *
 * Load order: marked.js → render-utils.js → render-chips.js → render-messages.js → inline script
 */

(function() {
// Dependencies — loaded by earlier <script> tags (browser) or test setup (Node/jsdom)
const { attachCopyButton, renderChip, renderThinkingChip, renderLocalCommand,
        esc, trimText, truncateThinking } = window.Gdn;
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

/**
 * Render the full message list into a container element.
 *
 * @param {HTMLElement} container - The messages container (replaces innerHTML)
 * @param {Array} messages - The messages array from state
 * @param {Object} opts
 * @param {string} opts.status - 'working' | 'idle' | etc.
 * @param {string} opts.connection - 'connected' | 'disconnected' | etc.
 * @param {string|null} opts.activity - '_activity' value: 'thinking' | 'writing' | tool name | null
 * @param {boolean} opts.userScrolledUp - If true, skip auto-scroll
 * @param {Function} [opts.onError] - Optional error reporter (receives string message)
 */
function renderMessages(container, messages, opts) {
  const { status, connection, activity, userScrolledUp, onError } = opts;

  // Dupe tripwire: detect consecutive assistant messages with identical content
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1], cur = messages[i];
    if (prev.role === 'assistant' && cur.role === 'assistant' && prev.content && cur.content && prev.content === cur.content) {
      console.warn('[bb] DUPE TRIPWIRE: consecutive identical assistant messages at index', i, 'of', messages.length);
      if (onError) onError('dupe-tripwire: consecutive identical assistant messages at index ' + i);
    }
  }

  // Snapshot expanded chips before rebuild
  const expandedChips = new Set();
  for (const chip of container.querySelectorAll('.chip.expanded')) {
    if (chip.dataset.toolId) expandedChips.add(chip.dataset.toolId);
  }
  const thinkingExpanded = !!container.querySelector('.chip.thinking-done.expanded, .chip.thinking.expanded');

  container.innerHTML = '';

  // Coalesce consecutive tool-call-only chips into one grid (Tetris packing).
  // Text, user messages, or thinking breaks the run and starts a new grid.
  let currentChipGrid = null;

  for (const msg of messages) {
    // Thinking chip — before content (thinking happened first, keeps visual position)
    const hasThinking = msg.thinking && msg.role === 'assistant';
    if (hasThinking) {
      currentChipGrid = null; // thinking breaks chip run
      const grid = document.createElement('div');
      grid.className = 'chip-grid';
      const chip = renderThinkingChip(msg.thinking);
      if (thinkingExpanded) chip.classList.add('expanded');
      grid.appendChild(chip);
      container.appendChild(grid);
    }

    // Text content — breaks chip run
    if (msg.content !== null && msg.content !== undefined) {
      currentChipGrid = null;
      // Local command output — render as collapsible block
      if (msg.role === 'user' && msg.content.includes('<local-command-stdout>')) {
        const grid = document.createElement('div');
        grid.className = 'chip-grid';
        grid.appendChild(renderLocalCommand(msg.content));
        container.appendChild(grid);
      } else {
        const div = document.createElement('div');
        if (msg.role === 'user' && msg.synthetic) {
          div.className = 'msg-system';
          div.textContent = msg.content;
        } else if (msg.role === 'user') {
          div.className = 'msg-user';
          div.innerHTML = renderUserBubble(msg.content);
          if (msg._msgId) div.dataset.msgId = msg._msgId;
        } else {
          div.className = 'msg-assistant';
          div.innerHTML = _marked.parse(trimText(msg.content));
          addCopyButtons(div);
        }
        container.appendChild(div);
      }
    }

    // Tool calls — coalesce into shared grid when consecutive
    const hasTools = msg.tool_calls && msg.tool_calls.length;
    if (hasTools) {
      // Any expanded chip in this batch breaks the run (needs full width)
      const anyExpanded = msg.tool_calls.some(tc => expandedChips.has(tc.name + '|' + (tc.input || '')));
      if (anyExpanded) currentChipGrid = null;

      if (!currentChipGrid) {
        currentChipGrid = document.createElement('div');
        currentChipGrid.className = 'chip-grid';
        container.appendChild(currentChipGrid);
      }
      for (const tc of msg.tool_calls) {
        const chip = renderChip(tc);
        if (expandedChips.has(chip.dataset.toolId)) chip.classList.add('expanded');
        currentChipGrid.appendChild(chip);
      }
    }
  }

  // Activity chip — pulsing indicator at the end when Claude is working
  if (status === 'working' && connection !== 'disconnected') {
    const activityType = activity || 'thinking';
    // Only show thinking/writing chips — tool activity is shown by the running chip itself
    if (activityType === 'thinking' || activityType === 'writing') {
      const label = activityType === 'thinking' ? 'Thinking…' : 'Writing…';
      const chip = document.createElement('div');
      chip.className = 'chip ' + activityType;

      // During thinking, show accumulated text in expandable detail
      const lastMsg = messages[messages.length - 1];
      const thinkingText = activityType === 'thinking' && lastMsg?.thinking ? lastMsg.thinking : null;
      if (thinkingText) {
        chip.innerHTML = `<span class="c-name">${label}</span>` +
          `<div class="c-detail">${esc(truncateThinking(thinkingText))}</div>`;
        if (thinkingExpanded) chip.classList.add('expanded');
        chip.addEventListener('click', () => chip.classList.toggle('expanded'));
      } else {
        chip.innerHTML = `<span class="c-name">${label}</span>`;
      }

      // Append to last chip-grid if one exists, otherwise create new grid
      const lastGrid = container.querySelector('.chip-grid:last-child');
      if (lastGrid && lastGrid === container.lastElementChild) {
        lastGrid.appendChild(chip);
      } else {
        const grid = document.createElement('div');
        grid.className = 'chip-grid';
        grid.appendChild(chip);
        container.appendChild(grid);
      }
    }
  }

  // Only auto-scroll if user hasn't scrolled up to read earlier content
  if (!userScrolledUp) {
    container.scrollTop = container.scrollHeight;
  }
}

// --- Exports ---
const mod = { addCopyButtons, renderUserBubble, renderMessages };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
