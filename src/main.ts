import { html, render } from "lit";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import { WSTransport, type ConnectionState } from "./ws-transport.js";
import type { FolderInfo } from "./ws-transport.js";
import { FolderSelector } from "./folder-selector.js";
import { showAskUserOverlay, dismissAskUserOverlay } from "./ask-user-overlay.js";
import { GueridonInterface } from "./gueridon-interface.js";
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

// --- Folder selector dialog ---

let folderDialog: FolderSelector | null = null;
let cachedFolders: FolderInfo[] = [];
let pendingFolderConnect = false; // True after user selects folder, cleared on session connect
let deferredFolderPath: string | null = null; // Set when switching folders mid-session

function openFolderSelector() {
  if (folderDialog) return;
  console.log("[guéridon] opening folder selector");
  folderDialog = FolderSelector.show(
    cachedFolders,
    (folder) => {
      pendingFolderConnect = true;
      gi.setCwd(folder.name);
      // If already in a session, must return to lobby first — bridge rejects
      // connectFolder on active sessions. Defer the connect until lobby mode.
      if (transport.state === "connected") {
        deferredFolderPath = folder.path;
        transport.returnToLobby();
      } else {
        transport.connectFolder(folder.path);
      }
    },
    () => {
      folderDialog = null;
      pendingFolderConnect = false;
      deferredFolderPath = null;
    },
  );
}

// --- Transport ---

const transport = new WSTransport({
  url: BRIDGE_URL,
  onStateChange: updateStatus,
  onSessionId: (id) => {
    console.log(`[guéridon] session: ${id} (folderDialog=${!!folderDialog}, pending=${pendingFolderConnect})`);
    if (folderDialog && pendingFolderConnect) {
      console.log("[guéridon] closing folder dialog due to session connect");
      folderDialog.close();
    } else if (folderDialog) {
      console.warn("[guéridon] onSessionId fired with dialog open but no pending connect — NOT closing (was the flash bug)");
    }
    pendingFolderConnect = false;
    gi.focusInput();
  },
  onBridgeError: (err) => console.error(`[guéridon] bridge error: ${err}`),
  onLobbyConnected: () => {
    // If we returned to lobby to switch folders, connect immediately
    if (deferredFolderPath) {
      const path = deferredFolderPath;
      deferredFolderPath = null;
      transport.connectFolder(path);
      return;
    }
    transport.listFolders();
  },
  onFolderList: (folders) => {
    console.log(`[guéridon] folderList: ${folders.length} folders, state=${transport.state}, dialog=${!!folderDialog}`);
    cachedFolders = folders;
    if (folderDialog) {
      folderDialog.updateFolders(folders);
    } else if (transport.state === "lobby") {
      openFolderSelector();
    }
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

gi.onFolderSelect = () => {
  openFolderSelector();
  transport.listFolders();
};

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
