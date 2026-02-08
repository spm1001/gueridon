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
        class="fixed inset-0 z-50 flex items-end bg-black/30"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) {
            dismiss();
            onDismiss();
          }
        }}
      >
        <div class="w-full bg-background border-t border-border rounded-t-2xl shadow-2xl p-4 pb-8 space-y-4">
          ${data.questions.map(
            (q, qi) => html`
              <div class="space-y-2">
                ${q.header
                  ? html`<div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      ${q.header}
                    </div>`
                  : nothing}
                <div class="text-sm font-medium text-foreground">${q.question}</div>
                <div class="flex flex-wrap gap-2">
                  ${q.options.map((opt, oi) => {
                    if (q.multiSelect) {
                      const isSelected = selected.get(qi)?.has(oi) ?? false;
                      return html`
                        <button
                          class="px-4 py-2.5 rounded-full text-sm touch-manipulation transition-colors
                                 ${isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground hover:bg-secondary/80"}"
                          @click=${() => toggleOption(qi, oi)}
                        >
                          ${opt.label}
                        </button>
                      `;
                    }
                    return html`
                      <button
                        class="px-4 py-2.5 rounded-full bg-primary text-primary-foreground text-sm
                               active:opacity-80 touch-manipulation"
                        @click=${() => handleSingleSelect(qi, opt.label)}
                      >
                        ${opt.label}
                      </button>
                    `;
                  })}
                </div>
                ${q.options.some((o) => o.description)
                  ? html`
                      <div class="text-xs text-muted-foreground space-y-0.5 mt-1">
                        ${q.options
                          .filter((o) => o.description)
                          .map(
                            (o) => html`
                              <div><span class="font-medium">${o.label}:</span> ${o.description}</div>
                            `,
                          )}
                      </div>
                    `
                  : nothing}
              </div>
            `,
          )}
          ${hasMultiSelect
            ? html`
                <button
                  class="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium
                         active:opacity-80 touch-manipulation"
                  @click=${handleMultiConfirm}
                >
                  Confirm selection
                </button>
              `
            : nothing}
          <button
            class="w-full text-center text-xs text-muted-foreground py-2 touch-manipulation"
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
