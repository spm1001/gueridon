/**
 * AskUserQuestion overlay — renders CC's questions as tappable buttons
 * on a mobile-friendly bottom sheet. Single-select: tap = send immediately.
 * Multi-select: toggle options, then confirm.
 */

import { html, render, nothing } from "lit";
import type { AskUserQuestionData, AskUserQuestionItem } from "./claude-code-agent.js";

let overlayContainer: HTMLElement | null = null;

export function showAskUserOverlay(
  data: AskUserQuestionData,
  onAnswer: (answer: string) => void,
  onDismiss: () => void,
): void {
  if (!overlayContainer) {
    overlayContainer = document.createElement("div");
    overlayContainer.id = "ask-user-overlay";
    document.body.appendChild(overlayContainer);
  }

  // Multi-select state: questionIndex → Set<optionIndex>
  const selected = new Map<number, Set<number>>();
  const hasMultiSelect = data.questions.some((q) => q.multiSelect);

  function handleSingleSelect(questionIndex: number, label: string) {
    const answer = formatAnswer(data.questions, questionIndex, label);
    dismiss();
    onAnswer(answer);
  }

  function toggleOption(questionIndex: number, optionIndex: number) {
    const sel = selected.get(questionIndex) || new Set();
    if (sel.has(optionIndex)) {
      sel.delete(optionIndex);
    } else {
      sel.add(optionIndex);
    }
    selected.set(questionIndex, sel);
    renderSheet();
  }

  function handleMultiConfirm() {
    const parts: string[] = [];
    for (const [qi, sel] of selected) {
      const q = data.questions[qi];
      const labels = [...sel].map((oi) => q.options[oi].label);
      if (labels.length > 0) {
        parts.push(formatAnswer(data.questions, qi, labels.join(", ")));
      }
    }
    dismiss();
    onAnswer(parts.join("\n") || "No selection");
  }

  function dismiss() {
    if (overlayContainer) {
      render(nothing, overlayContainer);
    }
  }

  function renderSheet() {
    const template = html`
      <div
        class="fixed inset-0 z-50 flex items-end"
        style="background: rgba(0,0,0,0.3); backdrop-filter: blur(2px)"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) {
            dismiss();
            onDismiss();
          }
        }}
      >
        <div
          class="w-full bg-background border-t border-border rounded-t-2xl shadow-2xl p-4 space-y-4"
          style="animation: slide-up 0.25s ease-out; padding-bottom: max(2rem, env(safe-area-inset-bottom, 2rem))"
        >
          ${data.questions.map(
            (q, qi) => html`
              <div class="space-y-2.5">
                ${q.header
                  ? html`<div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      ${q.header}
                    </div>`
                  : nothing}
                <div class="text-sm font-medium text-foreground">${q.question}</div>
                <div class="flex flex-col gap-2">
                  ${q.options.map((opt, oi) => {
                    if (q.multiSelect) {
                      const isSelected = selected.get(qi)?.has(oi) ?? false;
                      return html`
                        <button
                          class="w-full text-left px-4 py-3 rounded-xl text-sm transition-colors
                                 ${isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground"}"
                          style="min-height: 44px; touch-action: manipulation"
                          @click=${() => toggleOption(qi, oi)}
                        >
                          <div class="font-medium">${opt.label}</div>
                          ${opt.description
                            ? html`<div class="text-xs mt-0.5 opacity-75">${opt.description}</div>`
                            : nothing}
                        </button>
                      `;
                    }
                    return html`
                      <button
                        class="w-full text-left px-4 py-3 rounded-xl bg-primary text-primary-foreground text-sm
                               active:opacity-80"
                        style="min-height: 44px; touch-action: manipulation"
                        @click=${() => handleSingleSelect(qi, opt.label)}
                      >
                        <div class="font-medium">${opt.label}</div>
                        ${opt.description
                          ? html`<div class="text-xs mt-0.5 opacity-75">${opt.description}</div>`
                          : nothing}
                      </button>
                    `;
                  })}
                </div>
              </div>
            `,
          )}
          ${hasMultiSelect
            ? html`
                <button
                  class="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium
                         active:opacity-80"
                  style="min-height: 44px; touch-action: manipulation"
                  @click=${handleMultiConfirm}
                >
                  Confirm selection
                </button>
              `
            : nothing}
          <button
            class="w-full text-center text-xs text-muted-foreground py-2"
            style="touch-action: manipulation"
            @click=${() => {
              dismiss();
              onDismiss();
            }}
          >
            Type a custom answer instead
          </button>
        </div>
      </div>
    `;

    render(template, overlayContainer!);
  }

  renderSheet();
}

export function dismissAskUserOverlay(): void {
  if (overlayContainer) {
    render(nothing, overlayContainer);
  }
}

function formatAnswer(
  questions: AskUserQuestionItem[],
  questionIndex: number,
  answer: string,
): string {
  if (questions.length === 1) {
    return answer;
  }
  const header = questions[questionIndex].header;
  return header ? `${header}: ${answer}` : answer;
}
