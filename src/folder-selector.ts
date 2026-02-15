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
import type { FolderInfo, FolderState, FolderActivity } from "./ws-transport.js";

const SWIPE_THRESHOLD = 80; // px to reveal delete zone

@customElement("folder-selector")
export class FolderSelector extends DialogBase {
  @state() folders: FolderInfo[] = [];
  @state() private filter = "";
  @state() private connectingPath: string | null = null;
  @state() private creatingFolder = false;
  @state() private swipedPath: string | null = null; // Which folder is swiped open
  @state() private confirmingDelete: string | null = null; // Awaiting confirmation

  private onSelectCallback?: (folder: FolderInfo) => void;
  private onCloseCallback?: () => void;
  private onNewFolderCallback?: () => void;
  private onDeleteCallback?: (folder: FolderInfo) => void;

  // Touch tracking for swipe gesture
  private touchStartX = 0;
  private touchStartY = 0;
  private touchCurrentX = 0;
  private swipeRow: HTMLElement | null = null;
  private isSwipeGesture = false;

  // Dialog dimensions — nearly full screen on mobile
  protected override modalWidth = "min(480px, 92vw)";
  protected override modalHeight = "min(600px, 85vh)";

  /** Open the dialog. Returns the instance for external folder list updates. */
  static show(
    folders: FolderInfo[],
    onSelect: (folder: FolderInfo) => void,
    onClose?: () => void,
    onNewFolder?: () => void,
    onDelete?: (folder: FolderInfo) => void,
  ): FolderSelector {
    const dialog = new FolderSelector();
    dialog.folders = folders;
    dialog.onSelectCallback = onSelect;
    dialog.onCloseCallback = onClose;
    dialog.onNewFolderCallback = onNewFolder;
    dialog.onDeleteCallback = onDelete;
    dialog.open();
    return dialog;
  }

  /** Update folder list (e.g. when bridge sends a refresh) */
  updateFolders(folders: FolderInfo[]) {
    this.folders = folders;
  }

  /** Transition from "Creating…" to "connecting…" after folder is created. */
  folderCreated(path: string) {
    this.creatingFolder = false;
    this.connectingPath = path;
  }

  private handleSelect(folder: FolderInfo) {
    this.connectingPath = folder.path;
    this.onSelectCallback?.(folder);
    // Don't close yet — main.ts closes on successful session connect
  }

  /** Reset creating state on error so user can retry. */
  resetCreating() {
    this.creatingFolder = false;
  }

  override close() {
    this.connectingPath = null;
    this.creatingFolder = false;
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

  private stateLabel(s: FolderState, activity: FolderActivity): string {
    switch (s) {
      case "active":
        return activity === "working" ? "Working…" : "Waiting for you";
      case "paused":
        return "Paused";
      case "closed":
        return "Closed";
      case "fresh":
        return "";
    }
  }

  // --- Swipe gesture ---

  private handleTouchStart(e: TouchEvent, path: string) {
    // Reset any other open swipe
    if (this.swipedPath && this.swipedPath !== path) {
      this.resetSwipe();
    }
    this.touchStartX = e.touches[0].clientX;
    this.touchStartY = e.touches[0].clientY;
    this.touchCurrentX = this.touchStartX;
    this.isSwipeGesture = false;
    this.swipeRow = (e.currentTarget as HTMLElement).querySelector(".swipe-content");
  }

  private handleTouchMove(e: TouchEvent) {
    const dx = e.touches[0].clientX - this.touchStartX;
    const dy = e.touches[0].clientY - this.touchStartY;

    // Decide swipe vs scroll on first significant movement
    if (!this.isSwipeGesture && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      // Vertical — let the list scroll
      this.swipeRow = null;
      return;
    }

    if (Math.abs(dx) > 10) {
      this.isSwipeGesture = true;
    }

    if (!this.isSwipeGesture || !this.swipeRow) return;

    e.preventDefault(); // Prevent scroll while swiping horizontally
    // Only allow swiping left (negative dx), clamp to delete zone width
    const clampedDx = Math.max(-SWIPE_THRESHOLD - 20, Math.min(0, dx));
    this.touchCurrentX = this.touchStartX + clampedDx;
    this.swipeRow.style.transform = `translateX(${clampedDx}px)`;
    this.swipeRow.style.transition = "none";
  }

  private handleTouchEnd(_e: TouchEvent, path: string) {
    if (!this.swipeRow || !this.isSwipeGesture) {
      this.swipeRow = null;
      return;
    }

    const dx = this.touchCurrentX - this.touchStartX;
    this.swipeRow.style.transition = "transform 0.2s ease";

    if (dx < -SWIPE_THRESHOLD * 0.6) {
      // Past threshold — lock open
      this.swipeRow.style.transform = `translateX(-${SWIPE_THRESHOLD}px)`;
      this.swipedPath = path;
    } else {
      // Snap back
      this.swipeRow.style.transform = "translateX(0)";
      this.swipedPath = null;
    }
    this.swipeRow = null;
  }

  private resetSwipe() {
    this.swipedPath = null;
    this.confirmingDelete = null;
    // Reset all swipe-content transforms
    const rows = this.querySelectorAll(".swipe-content") as NodeListOf<HTMLElement>;
    for (const row of rows) {
      row.style.transition = "transform 0.2s ease";
      row.style.transform = "translateX(0)";
    }
  }

  private handleDelete(folder: FolderInfo) {
    if (this.confirmingDelete === folder.path) {
      // Second tap — confirmed
      this.onDeleteCallback?.(folder);
      this.confirmingDelete = null;
      this.swipedPath = null;
    } else {
      // First tap — ask for confirmation
      this.confirmingDelete = folder.path;
    }
  }

  // --- Render ---

  protected override renderContent() {
    const items = this.filtered;

    return html`
      ${DialogContent({
        className: "!p-0 h-full flex flex-col",
        children: html`
          <!-- Header + search -->
          <div class="px-4 pt-3.5 pb-2 shrink-0">
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

          <!-- New folder -->
          ${this.onNewFolderCallback
            ? html`
                <div class="px-4 pb-2 shrink-0">
                  <button
                    class="w-full px-3 py-2.5 rounded-lg text-sm font-medium
                           bg-primary/10 text-primary
                           active:bg-primary/20 transition-colors
                           disabled:opacity-50"
                    ?disabled=${this.creatingFolder || !!this.connectingPath}
                    @click=${() => {
                      this.creatingFolder = true;
                      this.onNewFolderCallback?.();
                    }}
                  >
                    ${this.creatingFolder ? "Creating…" : "+ New folder"}
                  </button>
                </div>
              `
            : nothing}

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
    const label = this.stateLabel(folder.state, folder.activity);
    const isConfirming = this.confirmingDelete === folder.path;

    return html`
      <div class="relative overflow-hidden"
        @touchstart=${(e: TouchEvent) => this.handleTouchStart(e, folder.path)}
        @touchmove=${(e: TouchEvent) => this.handleTouchMove(e)}
        @touchend=${(e: TouchEvent) => this.handleTouchEnd(e, folder.path)}
      >
        <!-- Delete zone (revealed by swipe) -->
        <div class="absolute right-0 top-0 bottom-0 flex items-center justify-center"
             style="width: ${SWIPE_THRESHOLD}px">
          <button
            class="w-full h-full flex items-center justify-center text-sm font-medium
                   text-white ${isConfirming ? 'bg-red-600' : 'bg-red-500'}
                   active:bg-red-700 transition-colors"
            @click=${() => this.handleDelete(folder)}
          >${isConfirming ? "Confirm" : "Delete"}</button>
        </div>

        <!-- Swipeable content row -->
        <button
          class="swipe-content relative w-full text-left px-4 py-3 flex items-start gap-3
                 bg-background active:bg-secondary/50 transition-colors"
          style="min-height: 52px; touch-action: pan-y"
          ?disabled=${!!this.connectingPath}
          @click=${() => this.swipedPath === folder.path ? this.resetSwipe() : this.handleSelect(folder)}
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
      </div>
    `;
  }
}
