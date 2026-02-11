/**
 * GueridonInterface — our own chat orchestration component.
 *
 * Replaces pi-web-ui's ChatPanel + AgentInterface + MessageEditor.
 * Consumes only the rendering components (MessageList, StreamingMessageContainer)
 * which are dumb renderers with no upward coupling.
 *
 * Gives us full control over the input area, button placement, and layout
 * without fighting pi-web-ui's abstractions.
 */

import { html, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@mariozechner/pi-agent-core";

// --- Custom element registration (side-effect imports) ---
// No barrel, no alias, no fork. See src/vendor/README.md for provenance.

// Our message components (replaces pi-web-ui's Messages.ts + renderTool chain)
import "./message-components.js";

// Vendored container components (from pi-web-ui, one-time copy)
import "./vendor/MessageList.js";
import "./vendor/StreamingMessageContainer.js";
import "./vendor/ThinkingBlock.js";
import "./vendor/ConsoleBlock.js";

// Leaf elements from mini-lit (npm dist, self-registering)
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";

// Type-only (for @query decorator)
import type { StreamingMessageContainer } from "./vendor/StreamingMessageContainer.js";
import type { ClaudeCodeAgent } from "./claude-code-agent.js";

@customElement("gueridon-interface")
export class GueridonInterface extends LitElement {
  private agent?: ClaudeCodeAgent;
  private unsubscribe?: () => void;

  // --- Reactive state (drives re-renders) ---

  @state() private _messages: AgentMessage[] = [];
  @state() private _tools: AgentTool[] = [];
  @state() private _pendingToolCalls = new Set<string>();
  @state() private _isStreaming = false;
  @state() private _inputText = "";
  @state() private _cwd = "";
  @state() private _cwdShort = "";
  @state() private _contextPercent = 0;
  @state() private _connectionState: string = "";
  @state() private _connectionColor: string = "";

  /** Callback fired when folder button is tapped. Set from main.ts. */
  onFolderSelect?: () => void;

  // --- Child element references ---

  @query("streaming-message-container")
  private _streamingContainer!: StreamingMessageContainer;

  // --- Auto-scroll state ---

  private scrollEl?: HTMLElement;
  private resizeObs?: ResizeObserver;
  private userScrolled = false;

  // --- Lit lifecycle ---

  createRenderRoot() {
    return this; // Light DOM — Tailwind classes work
  }

  connectedCallback() {
    super.connectedCallback();
    // Host element must fill its flex parent — without this, h-full on
    // the inner div resolves to auto and the input bar floats to the top.
    this.classList.add("flex-1", "min-h-0");
  }

  firstUpdated() {
    this.scrollEl = this.querySelector(".gdn-scroll") as HTMLElement;
    if (!this.scrollEl) return;

    this.scrollEl.addEventListener("scroll", () => {
      const el = this.scrollEl!;
      this.userScrolled =
        el.scrollHeight - el.scrollTop - el.clientHeight > 50;
    });

    const inner = this.scrollEl.querySelector(".gdn-scroll-inner");
    if (inner) {
      this.resizeObs = new ResizeObserver(() => {
        if (!this.userScrolled) {
          this.scrollEl!.scrollTop = this.scrollEl!.scrollHeight;
        }
      });
      this.resizeObs.observe(inner);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
    this.unsubscribe?.();
  }

  // --- Public API ---

  setAgent(agent: ClaudeCodeAgent) {
    this.agent = agent;
    this.setupSubscription();
  }

  focusInput() {
    requestAnimationFrame(() => {
      const ta = this.querySelector(".gdn-textarea") as HTMLTextAreaElement;
      ta?.focus();
    });
  }

  setCwd(cwd: string) {
    this._cwd = cwd;
    this._cwdShort = cwd.split("/").filter(Boolean).pop() || cwd;
  }

  setContextPercent(pct: number) {
    this._contextPercent = Math.max(0, Math.min(100, pct));
  }

  updateConnectionStatus(label: string, color: string) {
    this._connectionState = label;
    this._connectionColor = color;
    // Auto-hide "Connected" after 2s
    if (label === "Connected") {
      setTimeout(() => {
        if (this._connectionState === "Connected") {
          this._connectionState = "";
        }
      }, 2000);
    }
  }

  notifyCompaction(fromTokens: number, toTokens: number) {
    const fromK = Math.round(fromTokens / 1000);
    const toK = Math.round(toTokens / 1000);
    this.showToast(`Context compacted: ${fromK}k → ${toK}k`);
  }

  showToast(text: string) {
    // Lazy-create toast element
    if (!this._toast) {
      this._toast = document.createElement("div");
      Object.assign(this._toast.style, {
        position: "fixed",
        bottom: "80px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "4px 12px",
        borderRadius: "9999px",
        fontSize: "11px",
        fontWeight: "500",
        color: "#fff",
        backgroundColor: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(4px)",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.3s ease",
        whiteSpace: "nowrap",
        zIndex: "50",
      });
      document.body.appendChild(this._toast);
    }
    this._toast.textContent = text;
    this._toast.style.opacity = "1";
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast!.style.opacity = "0";
      this._toastTimer = null;
    }, 4000);
  }

  private _toast: HTMLElement | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Event translation loop ---
  // This is the critical bridge between ClaudeCodeAgent events and
  // the rendering components. ~20 lines that replace AgentInterface's
  // setupSessionSubscription.

  private setupSubscription() {
    if (this.unsubscribe) this.unsubscribe();
    if (!this.agent) return;

    this.unsubscribe = this.agent.subscribe((ev: AgentEvent) => {
      switch (ev.type) {
        case "message_start":
        case "turn_start":
        case "turn_end":
        case "agent_start":
          this.syncState();
          break;

        case "message_end":
          this._streamingContainer?.setMessage(null, true);
          this.syncState();
          break;

        case "agent_end":
          if (this._streamingContainer) {
            this._streamingContainer.isStreaming = false;
            this._streamingContainer.setMessage(null, true);
          }
          this.syncState();
          break;

        case "message_update":
          if (this._streamingContainer) {
            this._streamingContainer.isStreaming =
              this.agent!.state.isStreaming;
            this._streamingContainer.setMessage(
              (ev as any).message,
              !this.agent!.state.isStreaming,
            );
          }
          this.syncState();
          break;

        case "tool_execution_start":
        case "tool_execution_end":
          this.syncState();
          break;
      }
    });
  }

  private syncState() {
    if (!this.agent) return;
    const s = this.agent.state;
    this._messages = s.messages;
    this._tools = s.tools;
    this._pendingToolCalls = s.pendingToolCalls;
    this._isStreaming = s.isStreaming;

  }

  /** Build toolResultsById map for StreamingMessageContainer */
  private get toolResultsById(): Map<string, AgentMessage> {
    const map = new Map<string, AgentMessage>();
    for (const msg of this._messages) {
      if (msg.role === "toolResult") {
        map.set((msg as any).toolCallId, msg);
      }
    }
    return map;
  }

  // --- Input handling ---

  private handleSend() {
    const text = this._inputText.trim();
    if (!text || !this.agent) return;
    this._inputText = "";
    // Reset textarea height
    const ta = this.querySelector(".gdn-textarea") as HTMLTextAreaElement;
    if (ta) ta.style.height = "auto";
    this.agent.prompt(text);
  }

  private handleAbort() {
    this.agent?.abort();
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    this._inputText = ta.value;
    // Auto-resize: collapse to content height, cap at 8rem
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 128) + "px";
  }

  // --- Gauge helpers ---

  private get remaining(): number {
    return Math.max(0, Math.round(100 - this._contextPercent));
  }

  private get gaugeColor(): string {
    const r = this.remaining;
    if (r <= 10) return "text-red-500";
    if (r <= 20) return "text-amber-500";
    return "text-muted-foreground";
  }

  // --- Render ---

  render() {
    return html`
      <div class="flex flex-col h-full bg-background text-foreground">
        <!-- Messages -->
        <div class="flex-1 overflow-y-auto overscroll-contain gdn-scroll">
          <div class="max-w-3xl mx-auto p-4 pb-0 gdn-scroll-inner">
            <message-list
              .messages=${this._messages}
              .tools=${this._tools}
              .pendingToolCalls=${this._pendingToolCalls}
              .isStreaming=${this._isStreaming}
            ></message-list>
            <streaming-message-container
              .tools=${this._tools}
              .isStreaming=${this._isStreaming}
              .pendingToolCalls=${this._pendingToolCalls}
              .toolResultsById=${this.toolResultsById}
            ></streaming-message-container>
          </div>
        </div>

        <!-- Input area -->
        <div class="shrink-0">
          <div
            class="max-w-3xl mx-auto px-2"
            style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0.5rem))"
          >
            <div class="rounded-2xl border border-border bg-secondary/50 p-2">
              <!-- Textarea (full width) -->
              <textarea
                class="gdn-textarea w-full resize-none bg-transparent text-foreground
                       text-base outline-none px-2 py-1.5 max-h-32"
                rows="1"
                placeholder="Message Claude…"
                .value=${this._inputText}
                @input=${this.handleInput}
                @keydown=${this.handleKeydown}
              ></textarea>

              <!-- Button row -->
              <div class="flex items-center gap-1 mt-1">
                <!-- Paperclip (image upload) -->
                <button
                  class="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center
                         text-muted-foreground hover:text-foreground hover:bg-secondary
                         transition-colors"
                  title="Attach image"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round">
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>

                <!-- Folder selector (doubles as CWD display + connection status) -->
                <button
                  class="shrink-0 h-10 px-2 rounded-lg flex items-center gap-1.5
                         text-xs text-muted-foreground hover:text-foreground
                         hover:bg-secondary transition-colors truncate"
                  style="max-width: 45%"
                  title=${this._cwd || "Choose folder"}
                  @click=${() => this.onFolderSelect?.()}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                  </svg>
                  <span class="truncate">
                    ${this._cwdShort || "Choose folder"}
                  </span>
                  <span class="inline-block w-1.5 h-1.5 rounded-full shrink-0 ${this._connectionColor}"
                        style="opacity: ${this._connectionState ? 1 : 0}; transition: opacity 0.3s ease"></span>
                </button>

                <!-- Spacer -->
                <div class="flex-1"></div>

                <!-- Context gauge % -->
                ${this._contextPercent > 0
                  ? html`<span
                      class="text-xs font-medium shrink-0 ${this.gaugeColor}"
                    >${this.remaining}%</span>`
                  : ""}

                <!-- Send / Abort -->
                ${this._isStreaming
                  ? html`<button
                      class="shrink-0 w-10 h-10 rounded-full bg-red-500 text-white
                             flex items-center justify-center"
                      @click=${this.handleAbort}
                      title="Stop"
                    >■</button>`
                  : html`<button
                      class="shrink-0 w-10 h-10 rounded-full bg-primary
                             text-primary-foreground flex items-center
                             justify-center disabled:opacity-50"
                      @click=${this.handleSend}
                      ?disabled=${!this._inputText.trim()}
                      title="Send"
                    >↑</button>`}
              </div>
            </div>

          </div>
        </div>
      </div>
    `;
  }
}
