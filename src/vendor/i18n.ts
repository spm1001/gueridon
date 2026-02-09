// Vendored from pi-mono/packages/web-ui/src/utils/i18n.ts
// Commit: 41c4157b (2026-02-09)
//
// Trimmed to only the keys our vendored components actually use:
// ConsoleBlock: "console", "Copy output", "Copied!"
// ThinkingBlock: none (uses inline "Thinking...")
// Messages (via assistant-message): "Error:", "Request aborted", "Call", "Result",
//   "(no result)", "Waiting for tool result…", "Call was aborted; no result."
//
// The full upstream file has 200+ keys for features we don't use (artifacts,
// sessions, providers, API key config, etc.). This minimal version avoids
// carrying dead translations.

import { defaultEnglish, type MiniLitRequiredMessages, setTranslations } from "@mariozechner/mini-lit";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages extends MiniLitRequiredMessages {
		console: string;
		"Copy output": string;
		"Copied!": string;
		"Error:": string;
		"Request aborted": string;
		Call: string;
		Result: string;
		"(no result)": string;
		"Waiting for tool result…": string;
		"Call was aborted; no result.": string;
	}
}

const translations = {
	en: {
		...defaultEnglish,
		console: "console",
		"Copy output": "Copy output",
		"Copied!": "Copied!",
		"Error:": "Error:",
		"Request aborted": "Request aborted",
		Call: "Call",
		Result: "Result",
		"(no result)": "(no result)",
		"Waiting for tool result…": "Waiting for tool result…",
		"Call was aborted; no result.": "Call was aborted; no result.",
	},
};

setTranslations(translations);

export * from "@mariozechner/mini-lit/dist/i18n.js";
