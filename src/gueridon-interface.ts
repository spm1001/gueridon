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
import type { ClaudeCodeAgent, ContentBlock } from "./claude-code-agent.js";
import {
  isAcceptedImageType,
  resizeImage,
  fileToBase64,
  outputMimeType,
  type PendingImage,
} from "./image-utils.js";

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
  @state() private _pendingImages: PendingImage[] = [];
  @state() private _showDropOverlay = false;
  @state() private _isSending = false;

  /** Title badge state — drives document.title prefix */
  private _titleState: "idle" | "working" | "done" | "asking" = "idle";

  /** Callback fired when folder button is tapped. Set from main.ts. */
  onFolderSelect?: () => void;
  /** Callback fired when user sends a prompt (inside user gesture). */
  onPromptSent?: () => void;

  // --- Child element references ---

  @query("streaming-message-container")
  private _streamingContainer!: StreamingMessageContainer;

  // --- Auto-scroll state ---

  private resizeObs?: ResizeObserver;
  private inputBarObs?: ResizeObserver;
  @state() userScrolled = false;
  private _scrollLockUntil = 0;
  /** Temporarily suppress auto-scroll (e.g. during fold/expand toggles) */
  _suppressAutoScroll = false;

  // --- iOS keyboard offset (visualViewport API) ---
  // NOT @state — we apply directly to DOM to avoid Lit re-render flicker during streaming
  private _keyboardOffset = 0;
  private _viewportRaf = 0;

  // --- Lit lifecycle ---

  createRenderRoot() {
    return this; // Light DOM — Tailwind classes work
  }

  connectedCallback() {
    super.connectedCallback();
    // Document-level drag handlers prevent browser's default "open file" behavior.
    // Template-level bindings miss fixed-position children and viewport gaps.
    document.addEventListener("dragenter", this._onDragEnter);
    document.addEventListener("dragover", this._onDragOver);
    document.addEventListener("dragleave", this._onDragLeave);
    document.addEventListener("drop", this._onDrop);
    // Reset title badge when user returns to tab
    window.addEventListener("focus", this._onWindowFocus);
    // iOS Safari: visualViewport shrinks when keyboard opens, but doesn't
    // resize the layout viewport. Fixed-bottom elements get hidden behind
    // the keyboard. Track the offset and apply it as inline bottom style.
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", this._onViewportResize);
      window.visualViewport.addEventListener("scroll", this._onViewportResize);
    }
  }

  private _onWindowFocus = () => {
    if (this._titleState === "done" || this._titleState === "asking") {
      this.setTitleState("idle");
    }
  };

  private _onViewportResize = () => {
    // Coalesce rapid-fire resize events during keyboard animation into
    // a single update per frame — prevents the Cheshire Cat effect.
    cancelAnimationFrame(this._viewportRaf);
    this._viewportRaf = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      if (!vv) return;
      const offset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      if (offset === this._keyboardOffset) return;
      const opening = offset > this._keyboardOffset;
      this._keyboardOffset = offset;
      // Direct DOM manipulation — bypasses Lit render cycle entirely.
      // Using @state would re-render the template on every keyboard animation
      // frame, causing the input bar to flicker during streaming.
      this._applyKeyboardOffset();
      if (opening) this.scrollToBottom();
    });
  };

  /** Apply keyboard offset via CSS custom property on the host element.
   *  Child elements reference var(--kb-offset) — survives Lit re-renders
   *  because the property lives on the host, not the re-rendered children. */
  private _applyKeyboardOffset() {
    this.style.setProperty("--kb-offset", `${this._keyboardOffset}px`);
    // Content padding still needs direct update (not template-driven)
    const bar = this.querySelector(".gdn-input-bar") as HTMLElement;
    const inner = this.querySelector(".gdn-scroll-inner") as HTMLElement;
    if (bar && inner) {
      inner.style.paddingBottom = `${bar.offsetHeight + this._keyboardOffset}px`;
    }
  }

  private _onScroll = () => {
    // Ignore scroll events caused by our own scrollTo or iOS keyboard animation
    if (Date.now() < this._scrollLockUntil) return;
    this.userScrolled =
      document.documentElement.scrollHeight -
        window.scrollY -
        window.innerHeight >
      50;
  };

  /** Scroll to bottom, suppressing the scroll listener briefly to avoid
   *  iOS keyboard scroll events re-setting userScrolled mid-animation. */
  private scrollToBottom(smooth = false) {
    this.userScrolled = false;
    this._scrollLockUntil = Date.now() + 800;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
  }

  firstUpdated() {
    window.addEventListener("scroll", this._onScroll, { passive: true });

    const inner = this.querySelector(".gdn-scroll-inner") as HTMLElement;
    if (inner) {
      this.resizeObs = new ResizeObserver(() => {
        if (!this.userScrolled && !this._suppressAutoScroll) {
          this.scrollToBottom();
        }
      });
      this.resizeObs.observe(inner);
    }

    // Match content padding-bottom to input bar height + keyboard offset
    // so the last message sits exactly above the fixed bar, not behind it.
    const bar = this.querySelector(".gdn-input-bar") as HTMLElement;
    if (bar && inner) {
      this.inputBarObs = new ResizeObserver(() => {
        // _keyboardOffset is added here too — when keyboard is open and bar
        // resizes (e.g. textarea grows), padding must account for both.
        inner.style.paddingBottom = `${bar.offsetHeight + this._keyboardOffset}px`;
      });
      this.inputBarObs.observe(bar);
    }

  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("scroll", this._onScroll);
    window.removeEventListener("focus", this._onWindowFocus);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this._onViewportResize);
      window.visualViewport.removeEventListener("scroll", this._onViewportResize);
    }
    this.resizeObs?.disconnect();
    this.inputBarObs?.disconnect();
    this.unsubscribe?.();
    this._pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    document.removeEventListener("dragenter", this._onDragEnter);
    document.removeEventListener("dragover", this._onDragOver);
    document.removeEventListener("dragleave", this._onDragLeave);
    document.removeEventListener("drop", this._onDrop);
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
    this.updateTitle();
  }

  /** Update title badge state. Drives document.title prefix (✓/⏳/❓). */
  setTitleState(state: "idle" | "working" | "done" | "asking") {
    this._titleState = state;
    this.updateTitle();
  }

  private updateTitle() {
    const base = this._cwdShort
      ? `${this._cwdShort} — Guéridon`
      : "Guéridon";
    const prefixes = { idle: "", working: "⏳ ", done: "✓ ", asking: "❓ " };
    document.title = `${prefixes[this._titleState]}${base}`;
    this.updateFavicon();
  }

  private updateFavicon() {
    // Dot color per state — null means no dot (base icon only)
    const dotColors: Record<string, string | null> = {
      idle: null,
      working: "#f59e0b", // amber
      done: "#22c55e",    // green
      asking: "#ef4444",  // red
    };
    const dot = dotColors[this._titleState] ?? null;
    // SVG: guéridon table icon (circle on a line) + optional status dot
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="12" r="8" fill="none" stroke="%23e5e7eb" stroke-width="2"/>
      <text x="16" y="16" text-anchor="middle" font-size="12" fill="%23e5e7eb">G</text>
      ${dot ? `<circle cx="26" cy="6" r="6" fill="${dot.replace("#", "%23")}"/>` : ""}
    </svg>`;
    let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = `data:image/svg+xml,${svg}`;
  }

  setContextPercent(pct: number) {
    this._contextPercent = Math.max(0, Math.min(100, pct));
  }

  updateConnectionStatus(label: string) {
    this._connectionState = label;
    // Auto-hide "Connected" after 2s
    if (label === "Connected") {
      setTimeout(() => {
        if (this._connectionState === "Connected") {
          this._connectionState = "";
        }
      }, 2000);
    }
  }


  /** Transient info notification — auto-dismisses after 4s */
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

  /** Persistent error banner — stays until dismissed or cleared (gdn-vipebi).
   *  Use for connection errors, process failures, anything needing attention.
   *  Auto-dismissable errors (e.g. process exit) clear on agent_start;
   *  non-auto-dismissable errors persist until user dismisses. */
  showError(text: string, opts?: { action?: string; onAction?: () => void; autoDismiss?: boolean }) {
    this._errorText = text;
    this._errorAction = opts?.action ?? null;
    this._errorOnAction = opts?.onAction ?? null;
    this._errorAutoDismiss = opts?.autoDismiss ?? false;
  }

  dismissError(onlyAutoDismiss = false) {
    if (onlyAutoDismiss && !this._errorAutoDismiss) return;
    this._errorText = "";
    this._errorAction = null;
    this._errorOnAction = null;
    this._errorAutoDismiss = false;
  }

  @state() private _errorText = "";
  private _errorAction: string | null = null;
  private _errorOnAction: (() => void) | null = null;
  private _errorAutoDismiss = false;

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
          this.syncState();
          break;

        case "agent_start":
          this.syncState();
          // After replay, pin to bottom — the ResizeObserver handles streaming,
          // but replay lands all messages in one batch before the observer fires.
          // Double-rAF: first waits for Lit render, second waits for layout
          // reflow. Single rAF undershoots on iOS Safari after large DOM
          // updates, causing empty space at top (gdn-gocuze).
          requestAnimationFrame(() =>
            requestAnimationFrame(() => this.scrollToBottom(true))
          );
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

  private async handleSend() {
    const text = this._inputText.trim();
    const hasImages = this._pendingImages.length > 0;
    if ((!text && !hasImages) || !this.agent || this._isSending) return;

    this.onPromptSent?.();
    this._inputText = "";
    const ta = this.querySelector(".gdn-textarea") as HTMLTextAreaElement;
    if (ta) ta.style.height = "auto";

    if (!hasImages) {
      this.agent.prompt(text);
      return;
    }

    // Build ContentBlock[] with images + optional text
    this._isSending = true;
    try {
      const blocks: ContentBlock[] = [];
      for (const pending of this._pendingImages) {
        const resized = await resizeImage(pending.file);
        const data = await fileToBase64(resized);
        const mediaType = outputMimeType(pending.file.type);
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
        URL.revokeObjectURL(pending.previewUrl);
      }
      if (text) blocks.push({ type: "text", text });
      this._pendingImages = [];
      this.agent.prompt(blocks);
    } catch (e) {
      this.showToast("Failed to process image");
    } finally {
      this._isSending = false;
    }
  }

  private handleAbort() {
    this.agent?.abort();
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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

  private handleTapInput() {
    // Tapping the input implies intent to reply — jump to latest.
    // Can't use focus: iOS keeps textarea focused during touch scroll,
    // so re-tapping it doesn't fire a new focus event.
    if (this.userScrolled) {
      this.scrollToBottom(true);
    }
  }

  // --- Image upload ---

  private handlePaperclipClick() {
    const input = this.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    input?.click();
  }

  private handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) this.addFiles(input.files);
    input.value = ""; // Reset so same file can be re-selected
  }

  addFiles(files: FileList) {
    for (const file of files) {
      if (!isAcceptedImageType(file.type)) {
        this.showToast("Use JPEG, PNG, GIF, or WebP");
        continue;
      }
      const id = Math.random().toString(36).slice(2);
      const previewUrl = URL.createObjectURL(file);
      this._pendingImages = [
        ...this._pendingImages,
        { id, file, previewUrl },
      ];
    }
  }

  private handleRemoveImage(id: string) {
    const img = this._pendingImages.find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.previewUrl);
    this._pendingImages = this._pendingImages.filter((i) => i.id !== id);
  }

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && isAcceptedImageType(item.type)) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      imageFiles.forEach((f) => dt.items.add(f));
      this.addFiles(dt.files);
    }
    // No images: let default text paste proceed
  }

  // Arrow properties for document-level listeners (stable `this` binding)
  private _onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.types.includes("Files")) {
      this._showDropOverlay = true;
    }
  };

  private _onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  private _onDragLeave = (e: DragEvent) => {
    // relatedTarget is null when leaving the viewport boundary
    if (!e.relatedTarget) {
      this._showDropOverlay = false;
    }
  };

  private _onDrop = (e: DragEvent) => {
    e.preventDefault();
    this._showDropOverlay = false;
    if (e.dataTransfer?.files.length) {
      this.addFiles(e.dataTransfer.files);
    }
  };

  // --- Placeholder (connection status via input hint — gdn-mezajo) ---

  private get _placeholder(): string {
    if (this._connectionState && this._connectionState !== "Connected") {
      return this._connectionState;
    }
    return "Message Claude…";
  }

  private get _inputDisabled(): boolean {
    return !!this._connectionState &&
      this._connectionState !== "Connected" &&
      this._connectionState !== "";
  }

  // --- Tap-to-focus (gdn-vipita) ---

  private handleMessageAreaClick(e: MouseEvent) {
    // Don't steal focus if user is selecting text
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Don't steal focus if they clicked an interactive element
    const target = e.target as HTMLElement;
    if (target.closest("a, button, code-block, details")) return;
    this.focusInput();
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
      <div class="flex flex-col min-h-[100dvh] bg-background text-foreground">
        <!-- Hidden file input for image upload -->
        <input type="file" class="hidden"
          accept="image/jpeg,image/png,image/gif,image/webp" multiple
          @change=${this.handleFileInput} />

        <!-- Drop overlay -->
        ${this._showDropOverlay
          ? html`<div class="fixed inset-0 bg-primary/10 backdrop-blur-sm z-40
                             flex items-center justify-center">
              <div class="text-lg font-medium text-foreground/70 pointer-events-none">
                Drop images here
              </div>
            </div>`
          : ""}

        <!-- Messages (tap empty space to focus input — gdn-vipita) -->
        <div class="flex-1" @click=${this.handleMessageAreaClick}>
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

        <!-- Error banner — persistent, above input bar (gdn-vipebi) -->
        ${this._errorText
          ? html`<div class="gdn-error-banner fixed left-0 right-0 z-30
                             flex items-center justify-center px-4"
                      style="bottom: calc(6rem + var(--kb-offset, 0px)); padding-bottom: env(safe-area-inset-bottom, 0)">
              <div class="max-w-3xl w-full flex items-center gap-2 px-3 py-2
                          rounded-xl bg-red-500/15 border border-red-500/30
                          text-sm text-red-700 dark:text-red-300">
                <span class="flex-1">${this._errorText}</span>
                ${this._errorAction
                  ? html`<button
                      class="shrink-0 px-2 py-0.5 rounded-md bg-red-500/20
                             text-red-700 dark:text-red-300 text-xs font-medium
                             hover:bg-red-500/30 transition-colors"
                      @click=${() => this._errorOnAction?.()}
                    >${this._errorAction}</button>`
                  : ""}
                <button
                  class="shrink-0 w-8 h-8 flex items-center justify-center
                         rounded-full text-red-500/60 hover:text-red-500
                         transition-colors text-base"
                  @click=${() => this.dismissError()}
                  title="Dismiss"
                >&times;</button>
              </div>
            </div>`
          : ""}

        <!-- Input area — fixed to viewport bottom, offset for iOS keyboard -->
        <div class="gdn-input-bar fixed left-0 right-0 bg-background transition-[bottom] duration-150"
             style="bottom: var(--kb-offset, 0px)">
          <div
            class="max-w-3xl mx-auto px-2"
            style="padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0.5rem))"
          >
            <div class="rounded-2xl border ${this._isStreaming ? 'border-primary/50 animate-pulse' : 'border-border'} bg-secondary/50 p-2 transition-colors">
              <!-- Textarea (full width) -->
              <textarea
                class="gdn-textarea w-full resize-none bg-transparent text-foreground
                       text-base outline-none px-2 py-1.5 max-h-32"
                rows="1"
                placeholder=${this._placeholder}
                .value=${this._inputText}
                @input=${this.handleInput}
                @click=${this.handleTapInput}
                @keydown=${this.handleKeydown}
                @paste=${this.handlePaste}
              ></textarea>

              <!-- Pending image thumbnails -->
              ${this._pendingImages.length > 0
                ? html`<div class="flex gap-2 px-1 py-1.5 overflow-x-auto">
                    ${this._pendingImages.map(
                      (img) => html`
                        <div
                          class="relative shrink-0 w-12 h-12 rounded-lg overflow-hidden
                                 border border-border"
                        >
                          <img
                            src=${img.previewUrl}
                            class="w-full h-full object-cover"
                            alt="Pending upload"
                          />
                          <button
                            class="absolute top-0 right-0 w-4 h-4 bg-black/60 text-white
                                   rounded-bl-lg flex items-center justify-center text-[10px]"
                            @click=${() => this.handleRemoveImage(img.id)}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      `,
                    )}
                  </div>`
                : ""}

              <!-- Button row -->
              <div class="flex items-center gap-1 mt-1">
                <!-- Paperclip (image upload) -->
                <button
                  class="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center
                         text-muted-foreground hover:text-foreground hover:bg-secondary
                         transition-colors"
                  title="Attach image"
                  @click=${this.handlePaperclipClick}
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
                         text-xs font-medium text-muted-foreground hover:text-foreground
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
                      ?disabled=${!this._inputText.trim() && this._pendingImages.length === 0}
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
