/**
 * Folder chooser — full-screen list of project folders with search.
 * Shown in lobby mode before chat. User picks a folder to start/resume a session.
 *
 * Same pattern as ask-user-overlay: Lit templates + Tailwind, rendered into a
 * DOM container. Closure captures state and callbacks.
 */

import { html, render, nothing } from "lit";
import type { FolderInfo, FolderState } from "./ws-transport.js";

export interface FolderChooserHandle {
  /** Update the folder list (e.g. after refresh) */
  updateFolders(folders: FolderInfo[]): void;
  /** Remove the chooser from the DOM */
  dismiss(): void;
}

export function showFolderChooser(
  initialFolders: FolderInfo[],
  onSelect: (folder: FolderInfo) => void,
): FolderChooserHandle {
  let folders = initialFolders;
  let filter = "";
  let connectingPath: string | null = null;

  const container = document.createElement("div");
  container.id = "folder-chooser";
  document.body.appendChild(container);

  function filtered(): FolderInfo[] {
    if (!filter) return folders;
    const q = filter.toLowerCase();
    return folders.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.handoffPurpose && f.handoffPurpose.toLowerCase().includes(q)),
    );
  }

  function timeAgo(iso: string): string {
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

  function stateColor(state: FolderState): string {
    switch (state) {
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

  function stateLabel(state: FolderState): string {
    switch (state) {
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

  function renderItem(folder: FolderInfo) {
    const isConnecting = connectingPath === folder.path;
    const dot = stateColor(folder.state);
    const ago = folder.lastActive ? timeAgo(folder.lastActive) : null;
    const label = stateLabel(folder.state);

    return html`
      <button
        class="w-full text-left px-4 py-3 flex items-start gap-3
               active:bg-secondary/50 transition-colors"
        style="min-height: 52px; touch-action: manipulation"
        ?disabled=${!!connectingPath}
        @click=${() => {
          connectingPath = folder.path;
          rerender();
          onSelect(folder);
        }}
      >
        <div class="mt-1.5 w-2.5 h-2.5 shrink-0 flex items-center justify-center">
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
              ${isConnecting
                ? "connecting…"
                : ago
                  ? ago
                  : label}
            </span>
          </div>
          ${folder.handoffPurpose
            ? html`<div
                class="text-xs text-muted-foreground mt-0.5 truncate"
              >
                ${folder.handoffPurpose}
              </div>`
            : nothing}
        </div>
      </button>
    `;
  }

  function rerender() {
    const items = filtered();

    const template = html`
      <div
        class="fixed inset-0 z-40 bg-background text-foreground flex flex-col"
        style="height: 100dvh"
      >
        <!-- Header + search -->
        <div
          class="shrink-0 px-4 pb-2"
          style="padding-top: max(0.75rem, env(safe-area-inset-top, 0.75rem))"
        >
          <h1 class="text-lg font-semibold mb-3">Guéridon</h1>
          <input
            type="search"
            placeholder="Search folders…"
            class="w-full px-3 py-2 rounded-lg bg-secondary text-foreground text-sm
                   placeholder:text-muted-foreground outline-none
                   focus:ring-2 focus:ring-primary/50"
            .value=${filter}
            @input=${(e: Event) => {
              filter = (e.target as HTMLInputElement).value;
              rerender();
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
                  ${items.map((f) => renderItem(f))}
                </div>
              `
            : html`
                <div class="px-4 py-8 text-center text-muted-foreground text-sm">
                  ${filter
                    ? `No folders matching "${filter}"`
                    : "No folders found"}
                </div>
              `}
        </div>
      </div>
    `;

    render(template, container);
  }

  rerender();

  return {
    updateFolders(newFolders: FolderInfo[]) {
      folders = newFolders;
      rerender();
    },
    dismiss() {
      render(nothing, container);
      container.remove();
    },
  };
}
