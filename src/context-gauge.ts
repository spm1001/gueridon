/**
 * Context status bar — takes over pi-web-ui's stats bar (the h-5 div below
 * the input area) and replaces its content with CWD + % remaining.
 *
 * Uses a MutationObserver to find the stats element after pi-web-ui renders,
 * then replaces its children on each update.
 */

export interface ContextGauge {
  /** Update the % remaining display */
  update(percent: number): void;
  /** Set the CWD text */
  setCwd(cwd: string): void;
  /** Show a brief compaction notification */
  notifyCompaction(fromTokens: number, toTokens: number): void;
}

export function createContextGauge(): ContextGauge {
  let cwdText = "";
  let remaining = 100;
  let statsEl: HTMLElement | null = null;

  // Find pi-web-ui's stats bar. It's the .h-5 div inside agent-interface's
  // input area. We watch for it since ChatPanel renders asynchronously.
  function findStatsBar(): HTMLElement | null {
    // The stats bar is: agent-interface > div > div.shrink-0 > div.max-w-3xl > div.h-5
    const candidates = document.querySelectorAll<HTMLElement>(
      "agent-interface .shrink-0 .h-5",
    );
    // Take the last match (the global stats bar, not any per-message ones)
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  function ensureStatsEl(): HTMLElement | null {
    if (statsEl && statsEl.isConnected) return statsEl;
    statsEl = findStatsBar();
    return statsEl;
  }

  // Watch for the stats bar to appear (ChatPanel renders async)
  const observer = new MutationObserver(() => {
    if (ensureStatsEl()) {
      renderBar();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Compaction toast (separate element, briefly overlays)
  const toast = document.createElement("div");
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "28px",
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
  document.body.appendChild(toast);

  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function colorForRemaining(pct: number): string {
    if (pct <= 10) return "#ef4444"; // red
    if (pct <= 20) return "#eab308"; // amber
    return ""; // inherit (muted-foreground from parent)
  }

  function renderBar() {
    const el = ensureStatsEl();
    if (!el) return;

    // Replace the stats bar content entirely
    el.innerHTML = "";
    el.style.display = "flex";
    el.style.justifyContent = "space-between";
    el.style.alignItems = "center";

    const cwdSpan = document.createElement("span");
    cwdSpan.textContent = cwdText;
    cwdSpan.style.overflow = "hidden";
    cwdSpan.style.textOverflow = "ellipsis";
    cwdSpan.style.whiteSpace = "nowrap";
    cwdSpan.title = cwdText; // full path on hover/long-press

    const pctSpan = document.createElement("span");
    pctSpan.textContent = remaining < 100 ? `${remaining}%` : "";
    pctSpan.style.fontWeight = "500";
    const color = colorForRemaining(remaining);
    if (color) pctSpan.style.color = color;

    el.appendChild(cwdSpan);
    el.appendChild(pctSpan);
  }

  function update(percent: number) {
    const used = Math.max(0, Math.min(100, percent));
    remaining = Math.round(100 - used);
    renderBar();
  }

  function setCwd(cwd: string) {
    // Show just the last path component (repo name)
    const short = cwd.split("/").filter(Boolean).pop() || cwd;
    cwdText = short;
    renderBar();
  }

  function notifyCompaction(fromTokens: number, toTokens: number) {
    const fromK = Math.round(fromTokens / 1000);
    const toK = Math.round(toTokens / 1000);
    toast.textContent = `Context compacted: ${fromK}k → ${toK}k`;
    toast.style.opacity = "1";

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toastTimer = null;
    }, 4000);
  }

  return { update, setCwd, notifyCompaction };
}
