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
import { property } from "lit/decorators.js";
import { Check, AlertCircle, Loader } from "lucide";
import { i18n } from "./vendor/i18n.js";

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

	createRenderRoot() { return this; }
	connectedCallback() { super.connectedCallback(); this.style.display = "block"; }

	private extractResultText(): string {
		if (!this.result?.content) return "";
		return this.result.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}

	render() {
		const name = this.tool?.name || this.toolCall?.name || "tool";
		const isActive = !this.aborted && (this.isStreaming || this.pending);
		const hasResult = !!this.result;
		const isError = this.result?.isError || this.aborted;

		// Status indicator
		let statusIcon: TemplateResult;
		if (isActive) {
			statusIcon = html`<span class="text-muted-foreground animate-spin">${icon(Loader, "sm")}</span>`;
		} else if (isError) {
			statusIcon = html`<span class="text-destructive">${icon(AlertCircle, "sm")}</span>`;
		} else {
			statusIcon = html`<span class="text-green-500">${icon(Check, "sm")}</span>`;
		}

		// Body: bash tool gets console-block, everything else gets code-block
		const isBash = name === "Bash" || name === "bash";
		const args = this.toolCall?.arguments || {};
		const resultText = this.extractResultText();

		let body: TemplateResult;
		if (isBash && args.command) {
			body = html`
				<console-block .content=${args.command + (resultText ? "\n" + resultText : "")}
					.variant=${isError ? "error" : "default"}></console-block>
			`;
		} else if (this.aborted) {
			body = html`<div class="text-xs text-muted-foreground italic">${i18n("Call was aborted; no result.")}</div>`;
		} else if (isActive && !hasResult) {
			body = html`<div class="text-xs text-muted-foreground">${i18n("Waiting for tool result…")}</div>`;
		} else {
			const argsStr = Object.keys(args).length ? JSON.stringify(args, null, 2) : "";
			body = html`
				${argsStr ? html`
					<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Call")}</div>
					<code-block .code=${argsStr} language="json"></code-block>
				` : ""}
				${hasResult ? html`
					<div class="text-xs font-medium mb-1 mt-2 text-muted-foreground">${i18n("Result")}</div>
					<code-block .code=${resultText || i18n("(no result)")} language="text"></code-block>
				` : ""}
			`;
		}

		return html`
			<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				<div class="flex items-center gap-2 mb-2">
					${statusIcon}
					<span class="text-xs font-medium text-muted-foreground">${name}</span>
				</div>
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
	connectedCallback() { super.connectedCallback(); this.style.display = "block"; }

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
				${orderedParts.length ? html`<div class="px-4 flex flex-col gap-3">${orderedParts}</div>` : ""}
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
