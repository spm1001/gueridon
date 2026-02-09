/**
 * FolderSelector — dialog for choosing a project folder.
 *
 * Extends DialogBase (mini-lit) for backdrop + escape + focus management.
 * Rendering logic adapted from folder-chooser.ts but in dialog form.
 */

import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { DialogHeader, DialogContent } from "@mariozechner/mini-lit/dist/Dialog.js";
import type { FolderInfo, FolderState } from "./ws-transport.js";

@customElement("folder-selector")
export class FolderSelector extends DialogBase {
  @state() folders: FolderInfo[] = [];
  @state() private filter = "";
  @state() private connectingPath: string | null = null;

  private onSelectCallback?: (folder: FolderInfo) => void;
  private onCloseCallback?: () => void;

  // Dialog dimensions — nearly full screen on mobile
  protected override modalWidth = "min(480px, 92vw)";
  protected override modalHeight = "min(600px, 85vh)";

  /** Open the dialog. Returns the instance for external folder list updates. */
  static show(
    folders: FolderInfo[],
    onSelect: (folder: FolderInfo) => void,
    onClose?: () => void,
  ): FolderSelector {
    const dialog = new FolderSelector();
    dialog.folders = folders;
    dialog.onSelectCallback = onSelect;
    dialog.onCloseCallback = onClose;
    dialog.open();
    return dialog;
  }

  /** Update folder list (e.g. when bridge sends a refresh) */
  updateFolders(folders: FolderInfo[]) {
    this.folders = folders;
  }

  private handleSelect(folder: FolderInfo) {
    this.connectingPath = folder.path;
    this.onSelectCallback?.(folder);
    // Don't close yet — main.ts closes on successful session connect
  }

  override close() {
    this.connectingPath = null;
    this.filter = "";
    super.close();
    this.onCloseCallback?.();
  }

  // --- Helpers ---

  private get filtered(): FolderInfo[] {
    if (!this.filter) return this.folders;
    const q = this.filter.toLowerCase();
    return this.folders.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.handoffPurpose && f.handoffPurpose.toLowerCase().includes(q)),
    );
  }

  private timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
  }

  private stateColor(s: FolderState): string {
    switch (s) {
      case "active":
        return "bg-green-500";
      case "paused":
        return "bg-amber-500";
      case "closed":
        return "bg-zinc-400";
      case "fresh":
        return "";
    }
  }

  private stateLabel(s: FolderState): string {
    switch (s) {
      case "active":
        return "Active";
      case "paused":
        return "Paused";
      case "closed":
        return "Closed";
      case "fresh":
        return "";
    }
  }

  // --- Render ---

  protected override renderContent() {
    const items = this.filtered;

    return html`
      ${DialogContent({
        className: "h-full flex flex-col p-0",
        children: html`
          <!-- Header + search -->
          <div class="px-4 pt-4 pb-2 shrink-0">
            ${DialogHeader({
              title: "Guéridon",
              description: "Choose a project folder",
            })}
            <input
              type="search"
              placeholder="Search folders…"
              class="w-full mt-3 px-3 py-2 rounded-lg bg-secondary text-foreground
                     text-sm placeholder:text-muted-foreground outline-none
                     focus:ring-2 focus:ring-primary/50"
              .value=${this.filter}
              @input=${(e: Event) => {
                this.filter = (e.target as HTMLInputElement).value;
              }}
            />
          </div>

          <!-- Folder list -->
          <div
            class="flex-1 overflow-y-auto overscroll-contain"
            style="-webkit-overflow-scrolling: touch"
          >
            ${items.length > 0
              ? html`
                  <div class="divide-y divide-border">
                    ${items.map((f) => this.renderItem(f))}
                  </div>
                `
              : html`
                  <div
                    class="px-4 py-8 text-center text-muted-foreground text-sm"
                  >
                    ${this.filter
                      ? `No folders matching "${this.filter}"`
                      : "No folders found"}
                  </div>
                `}
          </div>
        `,
      })}
    `;
  }

  private renderItem(folder: FolderInfo) {
    const isConnecting = this.connectingPath === folder.path;
    const dot = this.stateColor(folder.state);
    const ago = folder.lastActive ? this.timeAgo(folder.lastActive) : null;
    const label = this.stateLabel(folder.state);

    return html`
      <button
        class="w-full text-left px-4 py-3 flex items-start gap-3
               active:bg-secondary/50 transition-colors"
        style="min-height: 52px; touch-action: manipulation"
        ?disabled=${!!this.connectingPath}
        @click=${() => this.handleSelect(folder)}
      >
        <div
          class="mt-1.5 w-2.5 h-2.5 shrink-0 flex items-center justify-center"
        >
          ${dot
            ? html`<span class="w-2 h-2 rounded-full ${dot}"></span>`
            : nothing}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-sm text-foreground truncate">
              ${folder.name}
            </span>
            <span class="text-xs text-muted-foreground shrink-0">
              ${isConnecting ? "connecting…" : ago ? ago : label}
            </span>
          </div>
          ${folder.handoffPurpose
            ? html`<div class="text-xs text-muted-foreground mt-0.5 truncate">
                ${folder.handoffPurpose}
              </div>`
            : nothing}
        </div>
      </button>
    `;
  }
}
