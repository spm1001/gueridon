/**
 * render-chrome.js — UI chrome renderers for the Guéridon frontend.
 *
 * Status bar, session switcher, placeholder text, and send button state.
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
 * @param {HTMLElement} els.connectionDot - Switcher connection dot
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

  // Connection state
  const connected = state.connection !== 'disconnected';
  els.body.dataset.connection = connected ? 'connected' : 'disconnected';
  els.connectionDot.dataset.state = connected ? 'connected' : 'disconnected';

  // Busy state — used by send button and activity chips
  const busy = connected && state.status === 'working';
  els.body.dataset.busy = busy;
}

/**
 * Render the session switcher panel.
 *
 * @param {Object} state - The live state (needs state.switcher, state.session)
 * @param {Object} opts
 * @param {boolean} opts.switcherOpen - Whether the switcher panel is open
 * @param {string|null} opts.currentFolder - Currently connected folder name
 * @param {string|null} opts.expandedFolder - Folder with expanded session list
 * @param {string} opts.filter - Search filter string (empty = no filter)
 * @param {Object} opts.els - DOM element references
 * @param {HTMLElement} opts.els.switcher - Switcher panel element
 * @param {HTMLElement} opts.els.list - Switcher list container
 * @param {HTMLElement} opts.els.backdrop - Backdrop overlay
 * @param {HTMLElement} opts.els.body - document.body
 * @param {Function} opts.onConnect - (folder, sessionId?) => void — connect to a folder/session
 * @param {Function} opts.onExpand - (folderName|null) => void — expand/collapse a folder's session list
 * @param {Function} [opts.onCreate] - (name: string) => void — create a new folder
 */
function renderSwitcher(state, opts) {
  const { switcherOpen, currentFolder, expandedFolder, filter,
          els, onConnect, onExpand, onCreate } = opts;

  if (!state.switcher || !switcherOpen) {
    els.switcher.dataset.open = 'false';
    els.backdrop.dataset.open = 'false';
    return;
  }

  els.backdrop.dataset.open = 'true';
  els.switcher.dataset.open = 'true';
  els.body.dataset.switcherOpen = '';
  els.list.innerHTML = '';

  const currentId = state.session ? state.session.id : null;
  const sessions = state.switcher.sessions || [];

  // Group: current pinned, then Recent (active/paused/touched within 72h),
  // Previous (older with history), fresh hidden unless searching
  const RECENT_MS = 72 * 60 * 60 * 1000;
  const recentCutoff = Date.now() - RECENT_MS;
  const recent = [];
  const previous = [];
  const freshPool = [];
  let top = null; // current session or most recently ended

  for (const s of sessions) {
    if (filter && !s.project.toLowerCase().includes(filter)) continue;
    if (s.project === currentFolder) { top = s; continue; }
    if (s.status === 'ended' && !top) { top = s; continue; }
    // Fresh = never had a human session
    if (s.humanSessionCount === 0 && s.backendState !== 'active' && s.backendState !== 'paused') {
      freshPool.push(s);
      continue;
    }
    // Recent = active/paused OR last activity within 72h
    const lastActive = s.updated ? new Date(s.updated).getTime() : 0;
    if (s.backendState === 'active' || s.backendState === 'paused' || lastActive > recentCutoff) {
      recent.push(s);
    } else {
      previous.push(s);
    }
  }

  function makeItem(s, isCurrent) {
    const pct = s.context_pct;
    const level = pct >= 85 ? 'critical' : pct >= 70 ? 'low' : '';
    const hasSessions = s.sessions && s.sessions.length > 1;
    const isExpanded = expandedFolder === s.project;
    const item = document.createElement('div');
    item.className = 'switcher-item';
    item.dataset.status = s.backendState || s.status;
    if (isCurrent) item.dataset.current = 'true';

    // Main row: body (clickable → connect) + chevron (clickable → expand)
    const row = document.createElement('div');
    row.className = 'switcher-item-row';

    const body = document.createElement('div');
    body.className = 'switcher-item-body';
    body.innerHTML = `
      <span class="switcher-dot" data-status="${s.backendState || s.status}"></span>
      <div class="switcher-info">
        <div class="switcher-project">${esc(s.project)}</div>
        <div class="switcher-last-msg">${esc(s.last_message || '')}</div>
      </div>
      <div class="switcher-meta">
        <div class="switcher-context" data-level="${level}">${pct ? pct + '%' : ''}</div>
        <div class="switcher-time">${timeAgo(s.updated)}</div>
      </div>
    `;
    body.addEventListener('click', () => {
      onConnect({ name: s.project, path: s.id });
    });
    row.appendChild(body);

    if (hasSessions) {
      const humanCount = s.sessions.filter(sess => sess.humanInteraction !== false).length;
      const countBadge = document.createElement('span');
      countBadge.className = 'switcher-session-count';
      countBadge.textContent = humanCount;
      row.appendChild(countBadge);

      const chevron = document.createElement('div');
      chevron.className = 'switcher-chevron';
      chevron.dataset.expanded = isExpanded ? 'true' : 'false';
      chevron.textContent = '\u203A'; // ›
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        onExpand(isExpanded ? null : s.project);
      });
      row.appendChild(chevron);
    }

    item.appendChild(row);

    // Expanded session list
    if (hasSessions && isExpanded) {
      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'switcher-sessions';

      // New Session button — top of list
      const newRow = document.createElement('div');
      newRow.className = 'switcher-new-session';
      newRow.innerHTML = '+ New Session';
      newRow.addEventListener('click', (e) => {
        e.stopPropagation();
        onConnect({ name: s.project, path: s.id }, 'new');
      });
      sessionsDiv.appendChild(newRow);

      // Filter to human-interactive sessions only (hide subagent spam)
      const humanSessions = s.sessions.filter(sess => sess.humanInteraction !== false);
      const hiddenCount = s.sessions.length - humanSessions.length;

      for (const sess of humanSessions) {
        const sessionPct = sess.contextPct;
        const sessionLevel = sessionPct >= 85 ? 'critical' : sessionPct >= 70 ? 'low' : '';
        const sessionRow = document.createElement('div');
        sessionRow.className = 'switcher-session-row';
        sessionRow.innerHTML = `
          <span class="switcher-dot" data-status="${sess.closed ? 'closed' : 'paused'}"></span>
          <span class="switcher-session-id">${esc(sess.id.slice(0, 8))}</span>
          <span class="switcher-session-model">${esc(shortModel(sess.model))}</span>
          <span class="switcher-context" data-level="${sessionLevel}">${sessionPct ? sessionPct + '%' : ''}</span>
          <span class="switcher-time">${timeAgo(sess.lastActive)}</span>
        `;
        sessionRow.addEventListener('click', (e) => {
          e.stopPropagation();
          onConnect({ name: s.project, path: s.id }, sess.id);
        });
        sessionsDiv.appendChild(sessionRow);
      }

      if (hiddenCount > 0) {
        const hidden = document.createElement('div');
        hidden.style.cssText = 'font-size: 0.65rem; color: var(--text-dim); padding: 4px 10px;';
        hidden.textContent = `${hiddenCount} subagent session${hiddenCount > 1 ? 's' : ''} hidden`;
        sessionsDiv.appendChild(hidden);
      }

      item.appendChild(sessionsDiv);
    }

    return item;
  }

  // New Project button — shown at top when no filter, calls onCreate with no name
  if (onCreate && !filter) {
    const btn = document.createElement('div');
    btn.className = 'switcher-create';
    btn.innerHTML = '<span class="switcher-create-icon">+</span> New Project';
    btn.addEventListener('click', () => onCreate(''));
    els.list.appendChild(btn);
  }

  if (top) els.list.appendChild(makeItem(top, true));

  if (recent.length) {
    const label = document.createElement('div');
    label.className = 'switcher-section';
    label.textContent = 'Recent';
    els.list.appendChild(label);
    for (const s of recent) els.list.appendChild(makeItem(s, false));
  }

  if (previous.length) {
    const label = document.createElement('div');
    label.className = 'switcher-section';
    label.textContent = 'Previous';
    els.list.appendChild(label);
    for (const s of previous) els.list.appendChild(makeItem(s, false));
  }

  // Fresh pool: only show when filtering or when nothing else exists
  const showFresh = freshPool.length && (filter || (!recent.length && !previous.length && !top));
  if (showFresh) {
    const label = document.createElement('div');
    label.className = 'switcher-section';
    label.textContent = filter ? 'Other' : 'All Projects';
    els.list.appendChild(label);
    for (const s of freshPool) els.list.appendChild(makeItem(s, false));
  }

  // Create folder: show when filter is a valid name with no exact match
  if (onCreate && filter) {
    const exactMatch = sessions.some(s => s.project.toLowerCase() === filter);
    const validName = /^[a-z0-9][a-z0-9-]*$/.test(filter) && filter.length <= 64;
    if (!exactMatch && validName) {
      const row = document.createElement('div');
      row.className = 'switcher-create';
      row.innerHTML = `<span class="switcher-create-icon">+</span> Create <strong>${esc(filter)}</strong>`;
      row.addEventListener('click', () => onCreate(filter));
      els.list.appendChild(row);
    }
  }
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
  const { currentFolder, connection, status, activity, model } = opts;
  if (!currentFolder) {
    textarea.placeholder = 'Choose a folder\u2026';
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
const mod = { renderStatusBar, renderSwitcher, updatePlaceholder, updateSendButton };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
