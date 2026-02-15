/**
 * <foldable-block> — unified fold/expand element for tool blocks and code blocks.
 *
 * Two modes:
 *   1. bodyTemplate (tool blocks): Lit renders the body content when expanded.
 *   2. siblingTarget (code blocks): toggles display of an existing sibling element.
 *
 * Usage:
 *   <!-- Mode 1: Lit-managed body -->
 *   <foldable-block label="Read" detail="/path/to/file"
 *     .statusIcon=${html`...`}
 *     .bodyTemplate=${html`<code-block ...></code-block>`}>
 *   </foldable-block>
 *
 *   <!-- Mode 2: external sibling (set imperatively) -->
 *   <foldable-block label="python" detail="29 lines"></foldable-block>
 *   <code-block style="display:none" ...></code-block>
 *   <!-- then: fold.siblingTarget = codeBlockElement -->
 */

import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ChevronRight } from "lucide";

export class FoldableBlock extends LitElement {
	/** Primary label shown in collapsed state (e.g. "python", "Bash") */
	@property({ type: String }) label = "";

	/** Secondary detail text shown only when collapsed (e.g. "29 lines", "/path") */
	@property({ type: String }) detail = "";

	/** Optional icon rendered between chevron and label (e.g. status indicator) */
	@property({ attribute: false }) statusIcon?: TemplateResult;

	/** Body content rendered when expanded (mode 1: Lit-managed) */
	@property({ attribute: false }) bodyTemplate?: TemplateResult;

	/** External element to show/hide on toggle (mode 2: sibling target) */
	siblingTarget?: HTMLElement;

	@state() private _expanded = false;

	createRenderRoot() { return this; }
	connectedCallback() { super.connectedCallback(); this.style.display = "block"; }

	private toggle() {
		const yBefore = this.getBoundingClientRect().top;

		// Suppress auto-scroll-to-bottom while content resizes
		const gi = document.querySelector("gueridon-interface") as any;
		if (gi) gi._suppressAutoScroll = true;

		this._expanded = !this._expanded;
		// Mode 2: toggle sibling visibility
		if (this.siblingTarget) {
			this.siblingTarget.style.display = this._expanded ? "block" : "none";
		}

		// Compensate scroll drift synchronously (mode 2) then release after layout settles
		requestAnimationFrame(() => {
			const drift = this.getBoundingClientRect().top - yBefore;
			if (drift !== 0) window.scrollBy(0, drift);
			// Release after one more frame so ResizeObserver doesn't snap back
			requestAnimationFrame(() => {
				if (gi) gi._suppressAutoScroll = false;
			});
		});
	}

	render() {
		const exp = this._expanded;

		return html`
			<div class="border border-border rounded-md bg-card text-card-foreground">
				<div class="flex items-center gap-2 cursor-pointer select-none py-1.5 px-2.5"
					@click=${this.toggle}>
					<span class="transition-transform inline-block ${exp ? "rotate-90" : ""}"
						>${icon(ChevronRight, "sm")}</span>
					${this.statusIcon ?? ""}
					<span class="text-xs font-medium text-muted-foreground">${this.label}</span>
					${!exp && this.detail ? html`<span class="text-xs text-muted-foreground/60 truncate font-mono">${this.detail}</span>` : ""}
				</div>
				${exp && this.bodyTemplate ? html`<div class="foldable-body">${this.bodyTemplate}</div>` : ""}
			</div>
		`;
	}
}

if (!customElements.get("foldable-block")) {
	customElements.define("foldable-block", FoldableBlock);
}
