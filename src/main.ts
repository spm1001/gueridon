import { html, render } from "lit";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import { WSTransport, type ConnectionState } from "./ws-transport.js";
import type { FolderInfo } from "./ws-transport.js";
import { FolderSelector } from "./folder-selector.js";
import { showAskUserOverlay, dismissAskUserOverlay } from "./ask-user-overlay.js";
import { GueridonInterface } from "./gueridon-interface.js";
import { initial, transition, type FolderEvent, type FolderEffect } from "./folder-lifecycle.js";
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

// --- Configuration ---

const BRIDGE_URL =
  location.hostname === "localhost"
    ? `ws://localhost:3001`
    : `wss://${location.host}/ws`;

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
const statusColors: Record<ConnectionState, string> = {
  connecting: "bg-yellow-500",
  lobby: "bg-blue-500",
  connected: "bg-green-500",
  disconnected: "bg-yellow-500",
  error: "bg-red-500",
};

function updateStatus(state: ConnectionState) {
  gi.updateConnectionStatus(statusLabels[state], statusColors[state]);
}

// --- Folder lifecycle state machine ---

let lifecycle = initial();
let folderDialog: FolderSelector | null = null;
let cachedFolders: FolderInfo[] = [];

// Dispatch queue — effects can trigger callbacks that dispatch new events.
// Without a queue, the inner dispatch would run mid-iteration of the outer
// dispatch's effect loop. The queue ensures each dispatch completes fully
// before the next event is processed.
let dispatching = false;
const eventQueue: FolderEvent[] = [];

function dispatch(event: FolderEvent) {
  eventQueue.push(event);
  if (dispatching) return;
  dispatching = true;
  while (eventQueue.length > 0) {
    const ev = eventQueue.shift()!;
    const result = transition(lifecycle, ev);
    lifecycle = result.state;
    for (const effect of result.effects) {
      executeEffect(effect);
    }
  }
  dispatching = false;
}

function executeEffect(effect: FolderEffect) {
  switch (effect.type) {
    case "open_dialog":
      cachedFolders = effect.folders;
      if (!folderDialog) {
        folderDialog = FolderSelector.show(
          effect.folders,
          (folder) => {
            dispatch({
              type: "folder_selected",
              path: folder.path,
              name: folder.name,
              inSession: transport.state === "connected",
            });
          },
          () => {
            folderDialog = null;
            dispatch({ type: "dialog_cancelled" });
          },
        );
      }
      break;
    case "update_dialog":
      cachedFolders = effect.folders;
      folderDialog?.updateFolders(effect.folders);
      break;
    case "close_dialog": {
      // Null ref before close — close() triggers onCloseCallback which
      // dispatches dialog_cancelled. With ref nulled, that's a harmless
      // no-op (idle + dialog_cancelled → no effects).
      const d = folderDialog;
      folderDialog = null;
      d?.close();
      break;
    }
    case "list_folders":
      transport.listFolders();
      break;
    case "connect_folder":
      transport.connectFolder(effect.path);
      break;
    case "return_to_lobby":
      transport.returnToLobby();
      break;
    case "reset_agent":
      agent.reset();
      break;
    case "set_cwd":
      gi.setCwd(effect.name);
      break;
    case "focus_input":
      gi.focusInput();
      break;
    case "show_error":
      gi.showToast(effect.message);
      break;
    case "store_folder":
      storeFolder(effect.path, effect.name);
      break;
    case "clear_stored_folder":
      localStorage.removeItem(STORAGE_KEY);
      break;
    case "start_timeout":
      clearConnectTimeout();
      connectTimeout = setTimeout(() => {
        dispatch({ type: "connection_failed", reason: "Connection timed out" });
      }, effect.ms);
      break;
    case "clear_timeout":
      clearConnectTimeout();
      break;
  }
}

// --- Connect timeout ---

let connectTimeout: ReturnType<typeof setTimeout> | null = null;

function clearConnectTimeout() {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
}

// --- Transport ---

const transport = new WSTransport({
  url: BRIDGE_URL,
  onStateChange: updateStatus,
  onSessionId: (id) => dispatch({ type: "session_started", sessionId: id }),
  onBridgeError: (err) => {
    console.error(`[guéridon] bridge error: ${err}`);
    dispatch({ type: "connection_failed", reason: err });
  },
  onLobbyConnected: () => {
    const stored = getStoredFolder();
    if (stored) {
      dispatch({ type: "auto_connect", path: stored.path, name: stored.name });
    } else {
      dispatch({ type: "lobby_entered" });
    }
  },
  onFolderList: (folders) => dispatch({ type: "folder_list", folders }),
  onHistoryStart: () => agent.startReplay(),
  onHistoryEnd: () => {
    agent.endReplay();
    gi.setContextPercent(agent.contextPercent);
  },
  onProcessExit: (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    dispatch({ type: "connection_failed", reason: `Claude process exited (${detail})` });
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
  if (event.type === "agent_start") dismissAskUserOverlay();
  if (event.type === "agent_end") gi.setContextPercent(agent.contextPercent);
});

gi.onFolderSelect = () => dispatch({ type: "open_requested", cachedFolders });

// --- Connect and render ---

transport.connect();

const app = document.getElementById("app");
if (!app) throw new Error("App container not found");

render(
  html`<div class="w-full h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
    ${gi}
  </div>`,
  app,
);

updateStatus(transport.state);
