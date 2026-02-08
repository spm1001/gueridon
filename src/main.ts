import {
  AppStorage,
  ChatPanel,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  CustomProvidersStore,
  setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import { WSTransport, type ConnectionState } from "./ws-transport.js";
import { showAskUserOverlay, dismissAskUserOverlay } from "./ask-user-overlay.js";
import "./app.css";

// --- Configuration ---

// Bridge URL: use same host as page in production, localhost in dev
const BRIDGE_URL =
  location.hostname === "localhost"
    ? `ws://localhost:3001`
    : `wss://${location.host}/ws`;

// --- Storage setup (required by ChatPanel internals) ---

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
  settings.getConfig(),
  SessionsStore.getMetadataConfig(),
  providerKeys.getConfig(),
  customProviders.getConfig(),
  sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
  dbName: "gueridon",
  version: 1,
  stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// --- Agent + Transport ---

const agent = new ClaudeCodeAgent();

// Connection status indicator
let statusEl: HTMLElement | null = null;

function updateStatus(state: ConnectionState, detail?: string) {
  if (!statusEl) return;
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Reconnecting…",
    error: "Connection error",
  };
  const colors: Record<ConnectionState, string> = {
    connecting: "bg-yellow-500",
    connected: "bg-green-500",
    disconnected: "bg-yellow-500",
    error: "bg-red-500",
  };
  statusEl.innerHTML = `
    <span class="inline-block w-2 h-2 rounded-full ${colors[state]}"></span>
    <span class="text-xs text-muted-foreground">${labels[state]}</span>
  `;
  // Auto-hide "Connected" after 2s, keep others visible
  if (state === "connected") {
    setTimeout(() => {
      if (statusEl) statusEl.style.opacity = "0";
    }, 2000);
  } else {
    statusEl.style.opacity = "1";
  }
}

const transport = new WSTransport({
  url: BRIDGE_URL,
  onStateChange: updateStatus,
  onSessionId: (id) => console.log(`[guéridon] session: ${id}`),
  onBridgeError: (err) => console.error(`[guéridon] bridge error: ${err}`),
});

agent.connectTransport(transport);

// AskUserQuestion interception — render as tappable buttons, send answer as next prompt
agent.onAskUser = (data) => {
  showAskUserOverlay(
    data,
    (answer) => {
      // User tapped an option — send as next prompt
      agent.prompt(answer);
    },
    () => {
      // User dismissed — they'll type a custom answer in the chat input
    },
  );
};

// Dismiss overlay when a new turn starts (user sent something via chat input)
agent.subscribe((event) => {
  if (event.type === "agent_start") {
    dismissAskUserOverlay();
  }
});

transport.connect();

// --- Render ---

const chatPanel = new ChatPanel();

async function init() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App container not found");

  // Cast to any — ClaudeCodeAgent satisfies Agent's shape structurally
  // but isn't a subclass (we don't use pi's agentLoop at all)
  await chatPanel.setAgent(agent as any, {
    // AgentInterface.sendMessage() silently aborts if this returns false.
    // We never need a key — CC authenticates via MAX subscription server-side.
    // Returning true tells the guard "proceed, auth is handled elsewhere."
    onApiKeyRequired: async () => true,
  });

  const appHtml = html`
    <div class="w-full h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      <div id="connection-status"
           class="fixed top-2 right-2 z-50 flex items-center gap-1.5 px-2 py-1 rounded-full bg-background/80 backdrop-blur-sm transition-opacity duration-300"
           style="opacity: 1">
      </div>
      ${chatPanel}
    </div>
  `;

  render(appHtml, app);
  statusEl = document.getElementById("connection-status");
  // Trigger initial state render
  updateStatus(transport.state);
}

init();
