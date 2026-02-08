/**
 * AskUserQuestion overlay — renders CC's questions as tappable buttons
 * on a mobile-friendly bottom sheet. Single-select: tap = send immediately.
 * Multi-select: toggle options, then confirm.
 *
 * Multi-question: all questions use "select then confirm" mode regardless
 * of individual multiSelect flags — user answers all questions before sending.
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

  // Selection state: questionIndex → Set<optionIndex>
  const selected = new Map<number, Set<number>>();

  // Immediate mode: exactly one question AND single-select. Tap = send.
  // Everything else: select per question, then confirm.
  const isImmediate =
    data.questions.length === 1 && !data.questions[0].multiSelect;

  function handleOptionTap(qi: number, oi: number) {
    const q = data.questions[qi];

    if (isImmediate) {
      dismiss();
      onAnswer(q.options[oi].label);
      return;
    }

    // Record selection
    const sel = selected.get(qi) || new Set();
    if (q.multiSelect) {
      // Toggle
      if (sel.has(oi)) sel.delete(oi);
      else sel.add(oi);
    } else {
      // Single-select: replace previous
      sel.clear();
      sel.add(oi);
    }
    selected.set(qi, sel);
    renderSheet();
  }

  function handleConfirm() {
    const parts: string[] = [];
    for (let qi = 0; qi < data.questions.length; qi++) {
      const q = data.questions[qi];
      const sel = selected.get(qi);
      if (!sel || sel.size === 0) continue;
      const labels = [...sel].map((oi) => q.options[oi].label).join(", ");
      parts.push(formatAnswer(data.questions, qi, labels));
    }
    dismiss();
    onAnswer(parts.join("\n") || "No selection");
  }

  function hasAllAnswers(): boolean {
    return data.questions.every(
      (_, qi) => (selected.get(qi)?.size ?? 0) > 0,
    );
  }

  function dismiss() {
    if (overlayContainer) {
      render(nothing, overlayContainer);
    }
  }

  function renderSheet() {
    const allAnswered = hasAllAnswers();

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
          class="w-full bg-background border-t border-border rounded-t-2xl shadow-2xl"
          style="animation: slide-up 0.25s ease-out; max-height: 70vh; display: flex; flex-direction: column"
        >
          <div
            class="p-4 space-y-4 overflow-y-auto overscroll-contain"
            style="padding-bottom: max(1rem, env(safe-area-inset-bottom, 1rem)); -webkit-overflow-scrolling: touch"
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
                      const isSelected = selected.get(qi)?.has(oi) ?? false;
                      // In immediate mode, all buttons are primary (no selection state)
                      if (isImmediate) {
                        return html`
                          <button
                            class="w-full text-left px-4 py-3 rounded-xl bg-primary text-primary-foreground text-sm
                                   active:opacity-80"
                            style="min-height: 44px; touch-action: manipulation"
                            @click=${() => handleOptionTap(qi, oi)}
                          >
                            <div class="font-medium">${opt.label}</div>
                            ${opt.description
                              ? html`<div class="text-xs mt-0.5 opacity-75">${opt.description}</div>`
                              : nothing}
                          </button>
                        `;
                      }
                      // Select-then-confirm mode: show selection state
                      return html`
                        <button
                          class="w-full text-left px-4 py-3 rounded-xl text-sm transition-colors
                                 ${isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground"}"
                          style="min-height: 44px; touch-action: manipulation"
                          @click=${() => handleOptionTap(qi, oi)}
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

            ${!isImmediate
              ? html`
                  <button
                    class="w-full py-3 rounded-xl text-sm font-medium active:opacity-80 transition-colors
                           ${allAnswered
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"}"
                    style="min-height: 44px; touch-action: manipulation"
                    ?disabled=${!allAnswered}
                    @click=${handleConfirm}
                  >
                    ${allAnswered
                      ? "Send answers"
                      : `Answer all questions (${selected.size}/${data.questions.length})`}
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
