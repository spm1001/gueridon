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
import "./app.css";

// Storage setup (required by ChatPanel internals)
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

// ClaudeCodeAgent adapter — gets events from CC via bridge, not direct LLM
const agent = new ClaudeCodeAgent();

// Create ChatPanel (the batteries-included wrapper)
const chatPanel = new ChatPanel();

async function init() {
  const app = document.getElementById("app");
  if (!app) throw new Error("App container not found");

  // Cast to any — ClaudeCodeAgent satisfies Agent's shape structurally
  // but isn't a subclass (we don't use pi's agentLoop at all)
  await chatPanel.setAgent(agent as any, {
    onApiKeyRequired: async () => false,
  });

  const appHtml = html`
    <div class="w-full h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
      ${chatPanel}
    </div>
  `;

  render(appHtml, app);
}

init();
