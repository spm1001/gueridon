/**
 * render-overlays.js — Overlay and sheet renderers for the Guéridon frontend.
 *
 * AskUserQuestion overlay, slash command sheet, staged deposit pills.
 * Depends on render-utils.js (esc via window.Gdn).
 *
 * Load order: marked.js → render-utils.js → render-chips.js → render-messages.js → render-chrome.js → render-overlays.js → inline script
 */

(function() {
const { esc } = window.Gdn;

// -- AskUserQuestion overlay --

/**
 * Show the AskUserQuestion overlay with tappable options.
 *
 * @param {Array} questions - Questions from the AskUser tool call
 * @param {string} toolCallId - The tool call ID (passed through to onAnswer)
 * @param {Object} opts
 * @param {Object} opts.els - DOM element references
 * @param {HTMLElement} opts.els.backdrop - Ask backdrop overlay
 * @param {HTMLElement} opts.els.sheet - Ask sheet container
 * @param {HTMLElement} opts.els.content - Ask content container
 * @param {Function} opts.onAnswer - (answer: string) => void
 * @param {Function} opts.onDismiss - () => void
 */
function showAskUserOverlay(questions, toolCallId, opts) {
  const { els, onAnswer, onDismiss } = opts;

  let html = '';
  const isSingleImmediate = questions.length === 1 && !questions[0].multiSelect;

  questions.forEach((q, qi) => {
    html += `<div class="ask-header">${esc(q.header)}</div>`;
    html += `<div class="ask-question">${esc(q.question)}</div>`;
    html += `<div class="ask-options" data-qi="${qi}" data-multi="${q.multiSelect}">`;
    q.options.forEach((opt, oi) => {
      html += `<div class="ask-option" data-qi="${qi}" data-oi="${oi}" data-label="${esc(opt.label)}">`;
      if (q.multiSelect) {
        html += `<span class="ask-option-check">&#x2713;</span>`;
      }
      html += `<div>`;
      html += `<div class="ask-option-label">${esc(opt.label)}</div>`;
      if (opt.description) {
        html += `<div class="ask-option-desc">${esc(opt.description)}</div>`;
      }
      html += `</div></div>`;
    });
    html += `</div>`;
  });

  if (!isSingleImmediate) {
    html += `<button class="ask-confirm" data-visible="true">Send answers</button>`;
  }
  html += `<div class="ask-custom">Type a custom answer instead</div>`;

  els.content.innerHTML = html;
  els.backdrop.dataset.open = 'true';
  els.sheet.dataset.open = 'true';

  function collectAnswer() {
    if (questions.length === 1) {
      const selected = els.content.querySelectorAll('.ask-option[data-selected="true"]');
      return Array.from(selected).map(s => s.dataset.label).join(', ');
    }
    const parts = [];
    questions.forEach((q, qi) => {
      const selected = els.content.querySelectorAll(`.ask-option[data-qi="${qi}"][data-selected="true"]`);
      const labels = Array.from(selected).map(s => s.dataset.label);
      if (labels.length > 0) {
        parts.push(`${q.header}: ${labels.join(', ')}`);
      }
    });
    return parts.join('\n');
  }

  function sendAnswer() {
    const answer = collectAnswer();
    hideAskUserOverlay(els);
    if (answer) onAnswer(answer);
  }

  // Option tap handlers
  els.content.querySelectorAll('.ask-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const container = opt.closest('.ask-options');
      const isMulti = container.dataset.multi === 'true';

      if (isMulti) {
        opt.dataset.selected = opt.dataset.selected === 'true' ? 'false' : 'true';
      } else {
        container.querySelectorAll('.ask-option').forEach(s => s.dataset.selected = 'false');
        opt.dataset.selected = 'true';
        if (isSingleImmediate) sendAnswer();
      }
    });
  });

  // Confirm button (multi-select or multi-question)
  const confirmBtn = els.content.querySelector('.ask-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => sendAnswer());
  }

  // Custom answer — dismiss overlay
  els.content.querySelector('.ask-custom').addEventListener('click', () => {
    hideAskUserOverlay(els);
    onDismiss();
  });

  // Backdrop tap dismisses
  els.backdrop.addEventListener('click', () => {
    hideAskUserOverlay(els);
    onDismiss();
  });
}

/**
 * Hide the AskUserQuestion overlay.
 * @param {Object} els - { backdrop, sheet }
 */
function hideAskUserOverlay(els) {
  els.backdrop.dataset.open = 'false';
  els.sheet.dataset.open = 'false';
}

// -- Slash command sheet --

// Bridge-level commands — always present, never reported by CC
// (state-builder.ts LOCAL_CMDS is the separate set for tagging CC-reported locals)
const BRIDGE_COMMANDS = [
  { name: 'abort', description: 'Kill hung Claude process', local: true },
  { name: 'exit', description: 'End session and return to lobby', local: true },
];

// Shown before CC spawns (CC will send its own list including these + help, clear, skills)
const FALLBACK_LOCAL_COMMANDS = [
  { name: 'compact', description: 'Compact conversation history', local: true },
  { name: 'context', description: 'Show context window usage', local: true },
  { name: 'cost', description: 'Show session cost', local: true },
];

/**
 * Merge bridge commands + CC commands (or fallback), sorted: locals first, then alpha.
 * @param {Array|null} ccCommands - Commands reported by CC (liveState.slashCommands)
 * @returns {Array} Merged sorted command list
 */
function getSlashCommands(ccCommands) {
  const source = ccCommands?.length ? ccCommands : FALLBACK_LOCAL_COMMANDS;
  const bridgeNames = new Set(BRIDGE_COMMANDS.map(c => c.name));
  const merged = [...BRIDGE_COMMANDS, ...source.filter(c => !bridgeNames.has(c.name))];
  merged.sort((a, b) => {
    if (a.local && !b.local) return -1;
    if (!a.local && b.local) return 1;
    return a.name.localeCompare(b.name);
  });
  return merged;
}

/**
 * Render the slash command list into the sheet.
 *
 * @param {string} filter - Search filter string
 * @param {Object} opts
 * @param {Array|null} opts.ccCommands - CC-reported slash commands
 * @param {Object} opts.els - DOM element references
 * @param {HTMLElement} opts.els.list - Slash list container
 * @param {HTMLElement} opts.els.sheet - Slash sheet overlay (for closing)
 * @param {Function} opts.onSelect - (cmd: {name, local, description}) => void
 */
function renderSlashList(filter, opts) {
  const { ccCommands, els, onSelect } = opts;
  const all = getSlashCommands(ccCommands);
  const q = (filter || '').toLowerCase();
  const cmds = q ? all.filter(c => c.name.includes(q) || (c.description || '').toLowerCase().includes(q)) : all;

  els.list.innerHTML = '';
  for (const cmd of cmds) {
    const row = document.createElement('div');
    row.className = 'slash-cmd';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-cmd-name';
    nameEl.textContent = cmd.name;
    row.appendChild(nameEl);

    if (cmd.description) {
      const descEl = document.createElement('span');
      descEl.className = 'slash-cmd-desc';
      descEl.textContent = cmd.description;
      row.appendChild(descEl);
    }
    if (cmd.local) {
      const badge = document.createElement('span');
      badge.className = 'slash-cmd-local';
      badge.textContent = 'local';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => {
      els.sheet.classList.remove('open');
      onSelect(cmd);
    });
    els.list.appendChild(row);
  }
}

/**
 * Open the slash command sheet.
 *
 * @param {Object} opts
 * @param {Array|null} opts.ccCommands - CC-reported slash commands
 * @param {Object} opts.els - DOM element references
 * @param {HTMLElement} opts.els.list - Slash list container
 * @param {HTMLElement} opts.els.sheet - Slash sheet overlay
 * @param {HTMLElement} opts.els.searchInput - Slash search input
 * @param {Function} opts.onSelect - (cmd) => void
 */
function openSlashSheet(opts) {
  const { ccCommands, els, onSelect } = opts;
  if (!getSlashCommands(ccCommands).length) return;
  els.searchInput.value = '';
  renderSlashList('', { ccCommands, els, onSelect });
  els.sheet.classList.add('open');
  requestAnimationFrame(() => els.searchInput.focus());
}

// -- Staged deposit pills --

/**
 * Show a temporary error message in the staged deposits area.
 *
 * @param {string} msg - Error message
 * @param {HTMLElement} container - The staged deposits container
 */
function showStagedError(msg, container) {
  const el = document.createElement('div');
  el.className = 'staged-error';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/**
 * Render staged deposit pills.
 *
 * @param {Array} deposits - Array of deposit objects with manifest.files
 * @param {Object} opts
 * @param {HTMLElement} opts.container - The staged deposits container
 * @param {Function} opts.onRemove - (index: number) => void
 */
function renderStagedDeposits(deposits, opts) {
  const { container, onRemove } = opts;
  // Preserve live error toasts across re-renders
  const errors = [...container.querySelectorAll('.staged-error')];
  container.innerHTML = '';
  errors.forEach(e => container.appendChild(e));

  deposits.forEach((dep, i) => {
    const pill = document.createElement('span');
    pill.className = 'staged-pill';
    const files = dep.manifest.files;
    const label = files.length === 1
      ? files[0].deposited_as
      : `${files[0].deposited_as} +${files.length - 1}`;
    pill.innerHTML = `<span class="staged-name">${label}</span><button class="staged-x" aria-label="Remove">\u00D7</button>`;
    pill.querySelector('.staged-x').addEventListener('click', () => {
      onRemove(i);
    });
    container.appendChild(pill);
  });
}

// --- Exports ---
const mod = {
  showAskUserOverlay, hideAskUserOverlay,
  getSlashCommands, renderSlashList, openSlashSheet,
  showStagedError, renderStagedDeposits,
};
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
