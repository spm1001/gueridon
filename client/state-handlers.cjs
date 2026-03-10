/**
 * state-handlers.js — SSE event processing for the Gueridon frontend.
 *
 * Pure functions that compute state updates and side-effect flags from incoming
 * SSE events (state, current, text). No DOM access, no mutable globals —
 * fully testable.
 *
 * Load order: ...render-overlays.js → state-handlers.js → inline script
 */

(function() {

/**
 * Process an SSE state event and return state updates + side-effect flags.
 *
 * @param {Object} data - SSE state event payload from bridge
 * @param {Object} ctx - Current client context
 * @param {string|null} ctx.currentFolder - Currently connected folder name
 * @param {Object} ctx.session - Current liveState.session
 * @returns {{ updates: Object, effects: Object }}
 *
 * updates: partial liveState fields to merge (only present keys should be applied)
 * effects: side-effect flags for the inline script to act on
 */
function applyStateEvent(data, ctx) {
  const updates = {
    connection: 'connected',
  };
  const effects = {
    clearStreaming: true,
    openSwitcher: false,
    clearFolder: false,
    clearHash: false,
    fetchFolders: false,
    pushNotify: null,
    resetPushTag: false,
  };

  // Apply snapshot fields
  if (data.messages) {
    updates.messages = data.messages;
  }
  if (data.session && typeof data.session === 'object') {
    updates.session = { ...ctx.session, ...data.session };
  }
  if (data.status) updates.status = data.status;
  if (data.slashCommands !== undefined) updates.slashCommands = data.slashCommands;

  // Working → allow next idle notification
  if (data.status === 'working') {
    effects.resetPushTag = true;
  }

  // Idle → clear activity + push notification
  if (data.status === 'idle') {
    updates.activity = null;
    const folder = ctx.currentFolder || '';
    effects.pushNotify = {
      title: `Claude finished in ${folder}`,
      opts: { tag: `gueridon-done-${folder}`, folder },
    };
  }

  // Session deliberately closed (/exit) — full nuke
  if (data.sessionEnded && ctx.currentFolder) {
    updates.session = {};
    updates.messages = [];
    updates.status = 'idle';
    updates.activity = null;
    updates.slashCommands = null;
    effects.clearFolder = true;
    effects.clearHash = true;
    effects.openSwitcher = true;
    effects.fetchFolders = true;
  }

  // CC process exited (crash/kill/restart) but session persists — keep folder
  if (data.processAlive === false && !data.sessionEnded && ctx.currentFolder) {
    updates.status = 'idle';
    updates.activity = null;
  }

  return { updates, effects };
}

/**
 * Process an SSE text (append) event.
 *
 * @param {Object} data - SSE text event payload { folder, append }
 * @returns {{ updates: Object, effects: Object }}
 */
function applyTextEvent(data) {
  return {
    updates: {
      status: 'working',
    },
    effects: {
      appendText: data.append || '',
    },
  };
}

/**
 * Process an SSE current-message event.
 *
 * Pure replacement — server sends committed messages + streaming overlay.
 * Client never decides when messages are committed; server tells it.
 *
 * @param {Object} data - SSE current event payload (CurrentMessage + messages + folder)
 * @returns {{ updates: Object, effects: Object }}
 */
function applyCurrentEvent(data) {
  const updates = {
    status: 'working',
    activity: data.activity || null,
  };

  // Server sends authoritative committed messages alongside the streaming overlay
  if (data.messages) {
    updates.messages = data.messages;
  }

  return {
    updates,
    effects: {
      newCurrentMessage: data,
      newStreamingText: data.text || '',
    },
  };
}

// --- Exports ---
const mod = { applyStateEvent, applyTextEvent, applyCurrentEvent };
if (typeof window !== 'undefined') window.Gdn = { ...window.Gdn, ...mod };
if (typeof module !== 'undefined') module.exports = mod;
})();
