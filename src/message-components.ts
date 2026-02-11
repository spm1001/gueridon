/**
 * Message leaf renderers — our own implementations replacing pi-web-ui's
 * Messages.ts + renderTool chain.
 *
 * Eliminates: renderTool, javascript-repl, extract-document, pdfjs-dist,
 * xlsx, docx-preview, jszip, and all their transitive dependencies.
 *
 * Three custom elements:
 *   <user-message>      — user chat bubble with markdown
 *   <assistant-message>  — assistant reply: text, thinking, tool calls
 *   <tool-message>       — tool call card: name, args, result
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { Check, AlertCircle, Loader, ChevronRight } from "lucide";
import { i18n } from "./vendor/i18n.js";

/** Create an SVG chevron-right element matching Lucide's icon(ChevronRight, "sm").
 *  Used in imperative DOM (code block fold headers) where Lit templates aren't available. */
function createChevronSVG(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "m9 18 6-6-6-6");
	svg.appendChild(path);
	return svg;
}

// --- <user-message> ---

export class UserMessage extends LitElement {
	@property({ type: Object }) message: any;

	createRenderRoot() { return this; }
	connectedCallback() { super.connectedCallback(); this.style.display = "block"; }

	render() {
		const content =
			typeof this.message?.content === "string"
				? this.message.content
				: this.message?.content?.find((c: any) => c.type === "text")?.text || "";

		return html`
			<div class="flex justify-start mx-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${content}></markdown-block>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("user-message")) {
	customElements.define("user-message", UserMessage);
}

// --- <tool-message> ---

export class ToolMessage extends LitElement {
	@property({ type: Object }) toolCall: any;
	@property({ type: Object }) tool?: AgentTool<any>;
	@property({ type: Object }) result?: any;
	@property({ type: Boolean }) pending = false;
	@property({ type: Boolean }) aborted = false;
	@property({ type: Boolean }) isStreaming = false;

	@state() private _isExpanded = false;

	createRenderRoot() { return this; }
	connectedCallback() { super.connectedCallback(); this.style.display = "block"; }

	private extractResultText(): string {
		if (!this.result?.content) return "";
		return this.result.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}

	private toggleExpanded() {
		this._isExpanded = !this._isExpanded;
	}

	/** One-line summary for collapsed state: bash command or tool name */
	private getSummary(name: string, args: any): string {
		const isBash = name === "Bash" || name === "bash";
		if (isBash && args.command) {
			// Show first line of command, truncated
			const firstLine = args.command.split("\n")[0];
			return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
		}
		if (args.file_path) return args.file_path;
		if (args.pattern) return args.pattern;
		if (args.query) return args.query;
		return "";
	}

	render() {
		const name = this.tool?.name || this.toolCall?.name || "tool";
		const isActive = !this.aborted && (this.isStreaming || this.pending);
		const hasResult = !!this.result;
		const isError = this.result?.isError || this.aborted;

		const expanded = this._isExpanded;

		// Status indicator
		let statusIcon: TemplateResult;
		if (isActive) {
			statusIcon = html`<span class="text-muted-foreground animate-spin">${icon(Loader, "sm")}</span>`;
		} else if (isError) {
			statusIcon = html`<span class="text-destructive">${icon(AlertCircle, "sm")}</span>`;
		} else {
			statusIcon = html`<span class="text-green-500">${icon(Check, "sm")}</span>`;
		}

		const args = this.toolCall?.arguments || {};
		const summary = this.getSummary(name, args);

		// Collapsed: single tappable line — tool name, status, brief summary
		// No nested scrollable containers, no scroll intercept
		const header = html`
			<div class="flex items-center gap-2 cursor-pointer select-none py-1.5 px-2.5"
				@click=${this.toggleExpanded}>
				<span class="transition-transform inline-block ${expanded ? "rotate-90" : ""}"
					>${icon(ChevronRight, "sm")}</span>
				${statusIcon}
				<span class="text-xs font-medium text-muted-foreground">${name}</span>
				${!expanded && summary ? html`<span class="text-xs text-muted-foreground/60 truncate font-mono">${summary}</span>` : ""}
			</div>
		`;

		if (!expanded) {
			return html`
				<div class="border border-border rounded-md bg-card text-card-foreground">
					${header}
				</div>
			`;
		}

		// Expanded: full body
		const isBash = name === "Bash" || name === "bash";
		const resultText = this.extractResultText();

		let body: TemplateResult;
		if (isBash && args.command) {
			body = html`
				<console-block .content=${args.command + (resultText ? "\n" + resultText : "")}
					.variant=${isError ? "error" : "default"}></console-block>
			`;
		} else if (this.aborted) {
			body = html`<div class="text-xs text-muted-foreground italic px-2.5 pb-2">${i18n("Call was aborted; no result.")}</div>`;
		} else if (isActive && !hasResult) {
			body = html`<div class="text-xs text-muted-foreground px-2.5 pb-2">${i18n("Waiting for tool result…")}</div>`;
		} else {
			const argsStr = Object.keys(args).length ? JSON.stringify(args, null, 2) : "";
			body = html`
				<div class="px-2.5 pb-2">
					${argsStr ? html`
						<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Call")}</div>
						<code-block .code=${argsStr} language="json"></code-block>
					` : ""}
					${hasResult ? html`
						<div class="text-xs font-medium mb-1 mt-2 text-muted-foreground">${i18n("Result")}</div>
						<code-block .code=${resultText || i18n("(no result)")} language="text"></code-block>
					` : ""}
				</div>
			`;
		}

		return html`
			<div class="border border-border rounded-md bg-card text-card-foreground">
				${header}
				${body}
			</div>
		`;
	}
}

if (!customElements.get("tool-message")) {
	customElements.define("tool-message", ToolMessage);
}

// --- <assistant-message> ---

export class AssistantMessage extends LitElement {
	@property({ type: Object }) message: any;
	@property({ type: Array }) tools?: AgentTool<any>[];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Boolean }) hideToolCalls = false;
	@property({ type: Object }) toolResultsById?: Map<string, any>;
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Boolean }) hidePendingToolCalls = false;
	@property({ attribute: false }) onCostClick?: () => void;

	createRenderRoot() { return this; }

	connectedCallback() {
		super.connectedCallback();
		this.style.display = "block";
	}

	updated() {
		// Don't fold code blocks during streaming — let content flow
		if (this.isStreaming) return;
		// Wrap markdown code blocks in fold headers (once per block).
		// Double-rAF: first frame lets Lit render code-block children,
		// second frame reads the <pre> element for accurate line counts.
		requestAnimationFrame(() => requestAnimationFrame(() => {
			this.querySelectorAll("markdown-block code-block:not([data-folded])").forEach((cb) => {
				const el = cb as HTMLElement;
				el.setAttribute("data-folded", "");

				const lang = el.getAttribute("language") || "code";
				// Read line count from rendered <pre> — .code may be base64
				const pre = el.querySelector("pre");
				const lineCount = pre ? pre.textContent!.trim().split("\n").length : 0;

				el.style.display = "none";

				const header = document.createElement("div");
				header.className = "flex items-center gap-2 cursor-pointer select-none py-1.5 px-2.5 border border-border rounded-md bg-card text-card-foreground";

				const chevron = document.createElement("span");
				chevron.className = "transition-transform inline-block";
				chevron.appendChild(createChevronSVG());

				const labelEl = document.createElement("span");
				labelEl.className = "text-xs font-medium text-muted-foreground";
				labelEl.textContent = lang;

				const countEl = document.createElement("span");
				countEl.className = "text-xs text-muted-foreground/50";
				countEl.textContent = lineCount === 1 ? "1 line" : `${lineCount} lines`;

				header.append(chevron, labelEl, countEl);

				header.addEventListener("click", () => {
					const showing = el.style.display !== "none";
					el.style.display = showing ? "none" : "block";
					chevron.style.transform = showing ? "" : "rotate(90deg)";
				});

				el.parentElement!.insertBefore(header, el);
			});
		}));
	}

	render() {
		const orderedParts: TemplateResult[] = [];

		for (const chunk of this.message?.content || []) {
			if (chunk.type === "text" && chunk.text?.trim()) {
				orderedParts.push(html`<markdown-block .content=${chunk.text}></markdown-block>`);
			} else if (chunk.type === "thinking" && chunk.thinking?.trim()) {
				orderedParts.push(
					html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`,
				);
			} else if (chunk.type === "toolCall") {
				if (!this.hideToolCalls) {
					const tool = this.tools?.find((t) => t.name === chunk.name);
					const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
					const result = this.toolResultsById?.get(chunk.id);
					// Skip rendering pending tool calls when hidePendingToolCalls is true
					if (this.hidePendingToolCalls && pending && !result) {
						continue;
					}
					const aborted = this.message.stopReason === "aborted" && !result;
					orderedParts.push(
						html`<tool-message
							.tool=${tool}
							.toolCall=${chunk}
							.result=${result}
							.pending=${pending}
							.aborted=${aborted}
							.isStreaming=${this.isStreaming}
						></tool-message>`,
					);
				}
			}
		}

		return html`
			<div>
				${orderedParts.length ? html`<div class="px-4 flex flex-col gap-2">${orderedParts}</div>` : ""}
				${this.message?.stopReason === "error" && this.message?.errorMessage
					? html`
						<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden">
							<strong>${i18n("Error:")}</strong> ${this.message.errorMessage}
						</div>
					`
					: ""}
				${this.message?.stopReason === "aborted"
					? html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`
					: ""}
			</div>
		`;
	}
}

if (!customElements.get("assistant-message")) {
	customElements.define("assistant-message", AssistantMessage);
}
