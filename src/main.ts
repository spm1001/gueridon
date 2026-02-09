import { html, render } from "lit";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import { WSTransport, type ConnectionState } from "./ws-transport.js";
import { FolderSelector } from "./folder-selector.js";
import { showAskUserOverlay, dismissAskUserOverlay } from "./ask-user-overlay.js";
import { GueridonInterface } from "./gueridon-interface.js";
import { initial, transition, type FolderEvent, type FolderEffect } from "./folder-lifecycle.js";
import "./app.css";

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

function dispatch(event: FolderEvent) {
  const result = transition(lifecycle, event);
  lifecycle = result.state;
  for (const effect of result.effects) {
    executeEffect(effect);
  }
}

function executeEffect(effect: FolderEffect) {
  switch (effect.type) {
    case "open_dialog":
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
  }
}

// --- Transport ---

const transport = new WSTransport({
  url: BRIDGE_URL,
  onStateChange: updateStatus,
  onSessionId: (id) => dispatch({ type: "session_started", sessionId: id }),
  onBridgeError: (err) => console.error(`[guéridon] bridge error: ${err}`),
  onLobbyConnected: () => dispatch({ type: "lobby_entered" }),
  onFolderList: (folders) => dispatch({ type: "folder_list", folders }),
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

gi.onFolderSelect = () => dispatch({ type: "open_requested" });

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
