/**
 * render-chrome.js — UI chrome renderers for the Guéridon frontend.
 *
 * Status bar, placeholder text, and send button state.
 * Depends on render-utils.js (esc, timeAgo, shortModel via window.Gdn).
 *
 * Load order: marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → inline script
 */

(function() {
// Dependencies — loaded by earlier <script> tags (browser) or test setup (Node/jsdom)
const { esc, timeAgo, shortModel } = window.Gdn;

/**
 * Render the status bar (project name, context %, connection/busy state).
 *
 * @param {Object} state - The live state from the bridge
 * @param {Object} els - DOM element references
 * @param {HTMLElement} els.project - Project name label
 * @param {HTMLElement} els.contextPct - Context percentage label
 * @param {HTMLElement} els.contextBtn - Context button (for data-level)
 * @param {HTMLElement} els.body - document.body (for dataset.connection, dataset.busy)
 */
function renderStatusBar(state, els) {
  const sess = state.session || {};
  els.project.textContent = sess.project || '';

  const pct = sess.context_pct;
  if (pct !== undefined && pct !== null) {
    els.contextPct.textContent = pct + '%';
    els.contextBtn.dataset.level = pct >= 85 ? 'critical' : pct >= 70 ? 'low' : '';
  } else if (sess.project) {
    els.contextPct.textContent = '0%';
    els.contextBtn.dataset.level = '';
  } else {
    els.contextPct.textContent = '';
    els.contextBtn.dataset.level = '';
  }

  // Connection state — 'loading' (session switch in progress) shows same amber tint as 'disconnected'
  const showAmber = state.connection === 'disconnected' || state.connection === 'loading';
  els.body.dataset.connection = showAmber ? 'disconnected' : 'connected';

  // Busy state — used by send button and activity chips
  const busy = !showAmber && state.status === 'working';
  els.body.dataset.busy = busy;
}

/**
 * Update textarea placeholder based on connection/activity state.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {Object} opts
 * @param {string|null} opts.currentFolder
 * @param {string} opts.connection
 * @param {string} opts.status
 * @param {string|null} opts.activity
 * @param {string|null} opts.model
 */
function updatePlaceholder(textarea, opts) {
  const { currentFolder, connection, status, activity, model, stale } = opts;
  textarea.dataset.stale = stale ? 'true' : '';
  if (stale) {
    textarea.placeholder = 'Update available \u2014 tap to reload';
  } else if (!currentFolder) {
    textarea.placeholder = 'Choose a folder\u2026';
  } else if (connection === 'loading') {
    textarea.placeholder = 'Resuming\u2026';
  } else if (connection === 'disconnected') {
    textarea.placeholder = 'Reconnecting\u2026';
  } else if (status === 'working') {
    textarea.placeholder = activity === 'writing' ? 'Claude is writing\u2026' :
                           activity === 'tool' ? 'Claude is editing\u2026' :
                           'Claude is thinking\u2026';
  } else {
    // Intentionally NOT shortModel() — strips only date suffix (8 digits), keeps version.
    // "Message sonnet-4-5…" is better than "Message sonnet-4…" for user display.
    const short = model ? model.replace('claude-', '').replace(/-\d{8}$/, '') : '';
    textarea.placeholder = short ? `Message ${short}\u2026` : 'Message Claude\u2026';
  }
}

/**
 * Update send button appearance based on input/connection state.
 *
 * @param {HTMLElement} sendBtn
 * @param {Object} opts
 * @param {boolean} opts.hasText
 * @param {boolean} opts.hasDeposits
 * @param {boolean} opts.isDisconnected
 * @param {boolean} opts.isBusy
 * @param {boolean} opts.isLive - Whether a bridge connection exists
 */
function updateSendButton(sendBtn, opts) {
  const { hasText, hasDeposits, isDisconnected, isBusy, isLive } = opts;
  const hasContent = hasText || hasDeposits;

  if (isDisconnected && !isLive) {
    // File mode disconnected — disable send
    sendBtn.dataset.stop = 'false';
    sendBtn.dataset.active = 'false';
    sendBtn.innerHTML = '&#x2191;';
  } else if (isDisconnected && isLive) {
    // Live mode disconnected — allow send (queued in SSE)
    sendBtn.dataset.stop = 'false';
    sendBtn.dataset.active = hasContent ? 'true' : 'false';
    sendBtn.innerHTML = '&#x2191;';
  } else if (isBusy && !hasContent) {
    sendBtn.dataset.stop = 'true';
    delete sendBtn.dataset.active;
    sendBtn.innerHTML = '&#x25A0;'; // stop
  } else {
    sendBtn.dataset.stop = 'false';
    sendBtn.dataset.active = hasContent ? 'true' : 'false';
    sendBtn.innerHTML = '&#x2191;'; // send
  }
}

// --- Exports ---
const mod = { renderStatusBar, updatePlaceholder, updateSendButton };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
