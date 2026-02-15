import { html, render } from "lit";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import { WSTransport, type ConnectionState, type FolderInfo } from "./ws-transport.js";
import { FolderSelector } from "./folder-selector.js";
import { showAskUserOverlay, dismissAskUserOverlay } from "./ask-user-overlay.js";
import { GueridonInterface } from "./gueridon-interface.js";
import "./app.css";

// --- Persistent folder (survives page refresh) ---

const STORAGE_KEY = "gueridon:lastFolder";

function getStoredFolder(): { path: string; name: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storeFolder(path: string, name: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ path, name }));
}

function clearStoredFolder(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function pathToName(path: string): string {
  return path.split("/").pop() || path;
}

// --- Configuration ---

// Dev: Vite on :5173, bridge on :3001 — need explicit bridge URL
// Prod: bridge serves everything — same-origin works
const BRIDGE_URL = import.meta.env.DEV
  ? `ws://${location.hostname}:3001`
  : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

// --- Core objects (created first, wired below) ---

const agent = new ClaudeCodeAgent();
const gi = new GueridonInterface();
gi.setAgent(agent);

// --- Connection status ---

const statusLabels: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  lobby: "Choose folder…",
  connected: "Connected",
  disconnected: "Reconnecting…",
  error: "Connection error",
};
function updateStatus(state: ConnectionState) {
  gi.updateConnectionStatus(statusLabels[state]);
}

// --- Folder picker state ---
// Two concerns: (1) is the picker open? (2) which folder is connecting?
// No state machine — transport owns connection mechanics, UI is just booleans.

let folderDialog: FolderSelector | null = null;
let cachedFolders: FolderInfo[] = [];
let connectingFromDialog: string | null = null;

function openFolderDialog(folders: FolderInfo[]) {
  if (folderDialog) return; // prevent double-open
  cachedFolders = folders;
  folderDialog = FolderSelector.show(
    folders,
    (folder) => {
      // User selected a folder
      connectingFromDialog = folder.path;
      agent.reset();
      gi.setCwd(folder.name);
      transport.connectToFolder(folder.path);
    },
    () => {
      // Dialog dismissed (escape, backdrop click)
      folderDialog = null;
      connectingFromDialog = null;
    },
    () => {
      // New folder requested
      transport.createFolder();
    },
    (folder) => {
      // Delete folder requested (swipe-to-delete)
      transport.deleteFolder(folder.path);
    },
  );
}

function closeFolderDialog() {
  // Null ref before close — close() triggers onCloseCallback.
  // With ref nulled, the callback's `folderDialog = null` is redundant but harmless.
  const d = folderDialog;
  folderDialog = null;
  d?.close();
}

// --- Transport ---

const transport = new WSTransport({
  url: BRIDGE_URL,
  onStateChange: updateStatus,

  onLobbyConnected: () => {
    const stored = getStoredFolder();
    if (stored) {
      // Auto-connect to last folder (no dialog involvement)
      gi.setCwd(stored.name);
      transport.connectToFolder(stored.path);
    } else {
      // No stored folder — request list to open picker
      transport.listFolders();
    }
  },

  onFolderList: (folders) => {
    cachedFolders = folders;
    if (folderDialog) {
      folderDialog.updateFolders(folders);
    } else {
      openFolderDialog(folders);
    }
  },

  onFolderCreated: (folder) => {
    // New folder created by bridge — connect to it automatically
    connectingFromDialog = folder.path;
    folderDialog?.folderCreated(folder.path);
    agent.reset();
    gi.setCwd(folder.name);
    transport.connectToFolder(folder.path);
  },

  onFolderConnected: (sessionId, path) => {
    const name = pathToName(path);
    storeFolder(path, name);
    gi.setCwd(name);
    gi.dismissError();
    // Close dialog only if this connect was user-initiated from the picker.
    // Auto-connects (page reload) don't touch the dialog. This prevents
    // the flash bug: stale session_started can't close a dialog the user
    // is actively browsing, because the callback split is structural.
    if (connectingFromDialog === path && folderDialog) {
      closeFolderDialog();
    }
    connectingFromDialog = null;
    gi.focusInput();
  },

  onFolderConnectFailed: (reason, _path) => {
    connectingFromDialog = null;
    gi.showError(reason, {
      action: "Switch folder",
      onAction: () => {
        gi.dismissError();
        transport.listFolders();
      },
    });
    clearStoredFolder();
    // Show folder picker so user can try a different folder
    transport.listFolders();
  },

  onSessionId: (_id) => {
    // Transparent reconnect (WS dropped while in session). No UI action needed —
    // placeholder text already updated via onStateChange.
  },

  onBridgeError: (err) => {
    console.error(`[guéridon] bridge error: ${err}`);
    // Reset folder creation state so user can retry.
    folderDialog?.resetCreating();
    // Transport suppresses onBridgeError during connect ops (retries handled
    // by onFolderConnectFailed). This only fires for session-mode errors.
    gi.showError(err);
  },

  onHistoryStart: () => agent.startReplay(),
  onHistoryEnd: () => {
    agent.endReplay();
    gi.setContextPercent(agent.contextPercent);
  },

  onProcessExit: (code, signal) => {
    // CC process died. The adapter gets a synthetic result event from the transport.
    // Connect failures during connectToFolder handled by onFolderConnectFailed.
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    console.warn(`[guéridon] CC process exited (${detail})`);
    // Show persistent banner — user needs to know Claude stopped.
    // Next prompt will respawn CC (lazy spawn), so no action button needed.
    gi.showError(`Claude process exited (${detail}) — next message will restart it`, { autoDismiss: true });
  },
  onSessionClosed: () => {
    clearStoredFolder();
    agent.reset();
    transport.returnToLobby();
  },

  onPromptQueued: (position) => {
    gi.showToast(`Message queued (#${position}) — will send when Claude finishes`);
  },

  onFolderDeleted: (path) => {
    // Remove from cached list and update dialog
    cachedFolders = cachedFolders.filter((f) => f.path !== path);
    if (folderDialog) folderDialog.updateFolders(cachedFolders);
    gi.showToast("Folder deleted");
  },
});

agent.connectTransport(transport);

// --- Callbacks ---

agent.onAskUser = (data) => {
  showAskUserOverlay(
    data,
    (answer) => agent.prompt(answer),
    () => {},
  );
};

agent.onCwdChange = (cwd) => gi.setCwd(cwd);
agent.onCompaction = (from, to) => gi.notifyCompaction(from, to);

agent.subscribe((event) => {
  if (event.type === "agent_start") {
    dismissAskUserOverlay();
    gi.dismissError(true); // Clear auto-dismissable errors (e.g. process exit) when CC responds
  }
  if (event.type === "agent_end") gi.setContextPercent(agent.contextPercent);
});

gi.onFolderSelect = () => {
  if (folderDialog) return; // prevent double-open
  openFolderDialog(cachedFolders);
  transport.listFolders();
};

// --- Connect and render ---

transport.connect();

const app = document.getElementById("app");
if (!app) throw new Error("App container not found");

render(
  html`<div class="w-full bg-background text-foreground">
    ${gi}
  </div>`,
  app,
);

updateStatus(transport.state);
