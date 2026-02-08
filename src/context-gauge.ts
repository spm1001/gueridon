/**
 * Context fuel gauge — provides a Lit template for pi-web-ui's stats bar
 * showing CWD + % context remaining.
 *
 * Uses AgentInterface.customStats to render natively inside Lit's render
 * cycle instead of fighting it with DOM manipulation.
 */

import { html } from "lit";

export interface ContextGauge {
  /** Update the % remaining display */
  update(percent: number): void;
  /** Set the CWD text */
  setCwd(cwd: string): void;
  /** Show a brief compaction notification */
  notifyCompaction(fromTokens: number, toTokens: number): void;
  /** Lit template for the stats bar — pass to AgentInterface.customStats */
  renderStats(): unknown;
}

export function createContextGauge(
  /** Called when gauge state changes and the host component should re-render */
  requestUpdate: () => void,
): ContextGauge {
  let cwdText = "";
  let remaining = 100;

  // Compaction toast (fixed-position overlay, independent of stats bar)
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
    if (pct <= 10) return "color: #ef4444;"; // red
    if (pct <= 20) return "color: #eab308;"; // amber
    return ""; // inherit muted-foreground from parent
  }

  function renderStats(): unknown {
    return html`
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title=${cwdText}>${cwdText}</span>
      <span style="font-weight:500; ${colorForRemaining(remaining)}">${remaining < 100 ? `${remaining}%` : ""}</span>
    `;
  }

  function update(percent: number) {
    const used = Math.max(0, Math.min(100, percent));
    remaining = Math.round(100 - used);
    requestUpdate();
  }

  function setCwd(cwd: string) {
    // Show just the last path component (repo name)
    const short = cwd.split("/").filter(Boolean).pop() || cwd;
    cwdText = short;
    requestUpdate();
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

  return { update, setCwd, notifyCompaction, renderStats };
}
