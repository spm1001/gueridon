// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

// --- Test infrastructure ---

// jsdom lacks ResizeObserver
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

// Mock vendored + local rendering components with lightweight stubs.
// GueridonInterface passes Lit .property bindings to these — we just need
// them registered as custom elements so they appear in the DOM.
//
// Gotcha: jsdom doesn't upgrade custom elements created inside Lit templates
// (innerHTML → importNode path bypasses constructors and connectedCallback).
// Stub methods are patched onto elements in createElement() instead.

vi.mock("./vendor/MessageList.js", () => {
  class MessageList extends HTMLElement {}
  if (!customElements.get("message-list")) {
    customElements.define("message-list", MessageList);
  }
  return { MessageList };
});

vi.mock("./vendor/StreamingMessageContainer.js", () => {
  class StreamingMessageContainer extends HTMLElement {}
  if (!customElements.get("streaming-message-container")) {
    customElements.define("streaming-message-container", StreamingMessageContainer);
  }
  return { StreamingMessageContainer };
});

vi.mock("./vendor/ThinkingBlock.js", () => ({}));
vi.mock("./vendor/ConsoleBlock.js", () => ({}));
vi.mock("./message-components.js", () => ({}));
vi.mock("@mariozechner/mini-lit/dist/MarkdownBlock.js", () => ({}));
vi.mock("@mariozechner/mini-lit/dist/CodeBlock.js", () => ({}));

import { GueridonInterface } from "./gueridon-interface.js";
import { ClaudeCodeAgent } from "./claude-code-agent.js";

// Ensure custom element is registered — @customElement decorator may not
// fire in vitest's SSR transform pipeline. Belt-and-suspenders.
if (!customElements.get("gueridon-interface")) {
  customElements.define("gueridon-interface", GueridonInterface);
}

// --- Helpers ---

async function createElement(): Promise<GueridonInterface> {
  const el = new GueridonInterface();
  document.body.appendChild(el);
  await el.updateComplete;

  // jsdom doesn't upgrade custom elements in Lit templates — patch stubs
  const streaming = el.querySelector("streaming-message-container") as any;
  if (streaming && typeof streaming.setMessage !== "function") {
    streaming.setMessage = function (_msg: any, _done?: boolean) {};
  }

  return el;
}

// --- Tests ---

describe("GueridonInterface", () => {
  let el: GueridonInterface;

  afterEach(() => {
    el?.remove();
    vi.useRealTimers();
  });

  // -- DOM structure --

  describe("renders DOM structure", () => {
    it("creates and completes first render", async () => {
      el = await createElement();
      expect(el.isConnected).toBe(true);
    });

    it("contains message-list", async () => {
      el = await createElement();
      expect(el.querySelector("message-list")).toBeInstanceOf(HTMLElement);
    });

    it("contains streaming-message-container", async () => {
      el = await createElement();
      expect(el.querySelector("streaming-message-container")).toBeInstanceOf(
        HTMLElement,
      );
    });

    it("contains textarea with placeholder", async () => {
      el = await createElement();
      const ta = el.querySelector(".gdn-textarea") as HTMLTextAreaElement;
      expect(ta).toBeInstanceOf(HTMLTextAreaElement);
      expect(ta.placeholder).toBe("Message Claude\u2026");
    });

    it("contains send button", async () => {
      el = await createElement();
      expect(el.querySelector('button[title="Send"]')).toBeTruthy();
    });

    it("contains folder button", async () => {
      el = await createElement();
      expect(el.querySelector('button[title="Choose folder"]')).toBeTruthy();
    });

    it("contains paperclip button", async () => {
      el = await createElement();
      expect(el.querySelector('button[title="Attach image"]')).toBeTruthy();
    });
  });

  // -- setCwd --

  describe("setCwd", () => {
    it("shows short folder name", async () => {
      el = await createElement();
      el.setCwd("/Users/test/Repos/my-project");
      await el.updateComplete;
      expect(el.textContent).toContain("my-project");
    });

    it("shows full path as button title", async () => {
      el = await createElement();
      el.setCwd("/Users/test/Repos/my-project");
      await el.updateComplete;
      const btn = [...el.querySelectorAll("button")].find(
        (b) => b.title === "/Users/test/Repos/my-project",
      );
      expect(btn).toBeTruthy();
    });
  });

  // -- setContextPercent --

  describe("setContextPercent", () => {
    it("shows remaining % when context used", async () => {
      el = await createElement();
      el.setContextPercent(30);
      await el.updateComplete;
      expect(el.textContent).toContain("70%");
    });

    it("hidden when context is 0%", async () => {
      el = await createElement();
      el.setContextPercent(0);
      await el.updateComplete;
      expect(el.textContent).not.toMatch(/\d+%/);
    });

    it("clamps above 100 to 0% remaining", async () => {
      el = await createElement();
      el.setContextPercent(110);
      await el.updateComplete;
      expect(el.textContent).toContain("0%");
    });
  });

  // -- Connection status --

  describe("connection status", () => {
    it("hidden by default", async () => {
      el = await createElement();
      // Dot is always in DOM but invisible (opacity 0) by default
      const dot = el.querySelector(".w-1\\.5.h-1\\.5.rounded-full") as HTMLElement;
      expect(dot).toBeTruthy();
      expect(dot.style.opacity).toBe("0");
    });

    it("shows dot with correct color when set", async () => {
      el = await createElement();
      el.updateConnectionStatus("Reconnecting\u2026", "bg-amber-500");
      await el.updateComplete;
      const dot = el.querySelector(".w-1\\.5.h-1\\.5.rounded-full");
      expect(dot).toBeTruthy();
      expect(dot!.classList.contains("bg-amber-500")).toBe(true);
    });

    it("auto-hides Connected after 2s", async () => {
      vi.useFakeTimers();
      el = await createElement();
      el.updateConnectionStatus("Connected", "bg-green-500");
      await el.updateComplete;
      const dot = el.querySelector(".w-1\\.5.h-1\\.5.rounded-full") as HTMLElement;
      expect(dot.style.opacity).toBe("1");

      vi.advanceTimersByTime(2000);
      await el.updateComplete;
      expect(dot.style.opacity).toBe("0");
    });

    it("non-Connected status stays visible", async () => {
      vi.useFakeTimers();
      el = await createElement();
      el.updateConnectionStatus("Disconnected", "bg-red-500");
      await el.updateComplete;

      vi.advanceTimersByTime(5000);
      await el.updateComplete;
      const dot = el.querySelector(".w-1\\.5.h-1\\.5.rounded-full");
      expect(dot).toBeTruthy();
      expect(dot!.classList.contains("bg-red-500")).toBe(true);
    });
  });

  // -- Streaming state (send vs abort) --

  describe("streaming state", () => {
    it("shows send button when not streaming", async () => {
      el = await createElement();
      expect(el.querySelector('button[title="Send"]')).toBeTruthy();
      expect(el.querySelector('button[title="Stop"]')).toBeFalsy();
    });

    it("shows abort button when streaming", async () => {
      el = await createElement();
      (el as any)._isStreaming = true;
      el.requestUpdate();
      await el.updateComplete;
      expect(el.querySelector('button[title="Stop"]')).toBeTruthy();
      expect(el.querySelector('button[title="Send"]')).toBeFalsy();
    });

    it("send button disabled when input empty", async () => {
      el = await createElement();
      const btn = el.querySelector(
        'button[title="Send"]',
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("send button enabled when input has text", async () => {
      el = await createElement();
      (el as any)._inputText = "hello";
      el.requestUpdate();
      await el.updateComplete;
      const btn = el.querySelector(
        'button[title="Send"]',
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  // -- Agent wiring (CC events → DOM) --

  describe("agent wiring", () => {
    function assistantComplete(
      content: any[],
      stopReason = "end_turn",
      usage = { input_tokens: 500, output_tokens: 50 },
    ) {
      return {
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: "msg_1",
          role: "assistant",
          content,
          stop_reason: stopReason,
          usage,
        },
      };
    }

    function result(
      usage = { input_tokens: 500, output_tokens: 50 },
    ) {
      return { type: "result", subtype: "success", is_error: false, usage };
    }

    function messageStart(id = "msg_1") {
      return {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            model: "claude-opus-4-6",
            id,
            role: "assistant",
            content: [],
            stop_reason: null,
            usage: {},
          },
        },
      };
    }

    function textBlockStart(index: number) {
      return {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      };
    }

    function textDelta(index: number, text: string) {
      return {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        },
      };
    }

    function blockStop(index: number) {
      return {
        type: "stream_event",
        event: { type: "content_block_stop", index },
      };
    }

    function messageStop() {
      return { type: "stream_event", event: { type: "message_stop" } };
    }

    it("passes messages to message-list after assistant complete", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
      agent.handleCCEvent(
        assistantComplete([{ type: "text", text: "Hello world!" }]),
      );
      agent.handleCCEvent(result());

      await el.updateComplete;

      const msgList = el.querySelector("message-list") as any;
      expect(msgList.messages).toHaveLength(1);
      expect(msgList.messages[0].role).toBe("assistant");
    });

    it("updates streaming container during stream", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      const streamingEl = el.querySelector(
        "streaming-message-container",
      ) as any;
      const setMessageSpy = vi.spyOn(streamingEl, "setMessage");

      agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
      agent.handleCCEvent(messageStart());
      agent.handleCCEvent(textBlockStart(0));
      agent.handleCCEvent(textDelta(0, "Hello"));

      await el.updateComplete;

      expect(setMessageSpy).toHaveBeenCalled();
      const lastCall = setMessageSpy.mock.calls.at(-1)!;
      expect(lastCall[0]).not.toBeNull(); // message object passed
    });

    it("clears streaming container on agent_end", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      const streamingEl = el.querySelector(
        "streaming-message-container",
      ) as any;
      const setMessageSpy = vi.spyOn(streamingEl, "setMessage");

      // Stream then complete
      agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
      agent.handleCCEvent(messageStart());
      agent.handleCCEvent(textBlockStart(0));
      agent.handleCCEvent(textDelta(0, "Hello"));
      agent.handleCCEvent(blockStop(0));
      agent.handleCCEvent(messageStop());
      agent.handleCCEvent(
        assistantComplete([{ type: "text", text: "Hello" }]),
      );
      agent.handleCCEvent(result());

      await el.updateComplete;

      // After agent_end, streaming container should have been cleared (null)
      const nullCalls = setMessageSpy.mock.calls.filter(
        (c) => c[0] === null,
      );
      expect(nullCalls.length).toBeGreaterThan(0);
    });

    it("passes tool-use messages to message-list", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
      agent.handleCCEvent(
        assistantComplete(
          [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          "tool_use",
        ),
      );

      await el.updateComplete;

      const msgList = el.querySelector("message-list") as any;
      expect(msgList.messages).toHaveLength(1);
      expect(msgList.messages[0].role).toBe("assistant");
      // Content should have a toolCall block (mapped from tool_use)
      const toolCall = msgList.messages[0].content.find(
        (b: any) => b.type === "toolCall",
      );
      expect(toolCall).toBeDefined();
      expect(toolCall.name).toBe("Bash");
    });

    it("syncs pendingToolCalls immediately on tool_execution_start", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      // Feed assistant message with tool_use — this emits tool_execution_start
      agent.handleCCEvent(
        assistantComplete(
          [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          "tool_use",
        ),
      );
      await el.updateComplete;

      // pendingToolCalls should be synced immediately (not waiting for next message_end)
      const msgList = el.querySelector("message-list") as any;
      expect(msgList.pendingToolCalls).toBeInstanceOf(Set);
      expect(msgList.pendingToolCalls.has("toolu_1")).toBe(true);
    });

    it("syncs pendingToolCalls after full tool cycle", async () => {
      el = await createElement();
      const agent = new ClaudeCodeAgent();
      el.setAgent(agent);

      agent.handleCCEvent({ type: "system", subtype: "init", cwd: "/test" });
      agent.handleCCEvent(
        assistantComplete(
          [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          "tool_use",
        ),
      );
      // Tool result clears the pending call
      agent.handleCCEvent({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: "file.ts",
              is_error: false,
            },
          ],
        },
      });
      // Follow-up text triggers message_end → syncState
      agent.handleCCEvent(
        assistantComplete([{ type: "text", text: "Found file.ts" }]),
      );
      agent.handleCCEvent(result());

      await el.updateComplete;

      const msgList = el.querySelector("message-list") as any;
      expect(msgList.pendingToolCalls).toBeInstanceOf(Set);
      expect(msgList.pendingToolCalls.size).toBe(0);
    });
  });

  // -- Error/edge states --

  describe("error and edge states", () => {
    it("renders gracefully with no agent set", async () => {
      el = await createElement();
      // No setAgent called — all state stays at defaults
      expect(el.querySelector("message-list")).toBeInstanceOf(HTMLElement);
      expect(el.querySelector(".gdn-textarea")).toBeInstanceOf(
        HTMLTextAreaElement,
      );
      // Send should not throw when clicked with no agent
      const sendBtn = el.querySelector(
        'button[title="Send"]',
      ) as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(true);
    });

    it("shows compaction toast via notifyCompaction", async () => {
      el = await createElement();
      el.notifyCompaction(150000, 80000);
      // Toast is appended to document.body with position:fixed
      const toast = [...document.body.children].find(
        (child) =>
          child instanceof HTMLElement && child.style.position === "fixed",
      ) as HTMLElement;
      expect(toast).toBeTruthy();
      expect(toast.textContent).toContain("150k");
      expect(toast.textContent).toContain("80k");
    });

    it("folder button fires onFolderSelect callback", async () => {
      el = await createElement();
      const callback = vi.fn();
      el.onFolderSelect = callback;

      const folderBtn = el.querySelector(
        'button[title="Choose folder"]',
      ) as HTMLButtonElement;
      folderBtn.click();

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  // -- Image upload --

  describe("image upload", () => {
    // jsdom lacks DataTransfer, so we build a minimal FileList-like object
    function makeFile(name: string, type: string, content = "pixels"): File {
      return new File([content], name, { type });
    }

    function makeFileList(...files: File[]): FileList {
      const list = Object.create(FileList.prototype);
      files.forEach((f, i) => { list[i] = f; });
      Object.defineProperty(list, "length", { value: files.length });
      list[Symbol.iterator] = function* () {
        for (let i = 0; i < files.length; i++) yield files[i];
      };
      return list;
    }

    it("has hidden file input with correct accept types", async () => {
      el = await createElement();
      const input = el.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.accept).toBe("image/jpeg,image/png,image/gif,image/webp");
      expect(input.multiple).toBe(true);
      expect(input.classList.contains("hidden")).toBe(true);
    });

    it("paperclip click triggers file input", async () => {
      el = await createElement();
      const input = el.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(input, "click");
      const paperclip = el.querySelector(
        'button[title="Attach image"]',
      ) as HTMLButtonElement;
      paperclip.click();
      expect(clickSpy).toHaveBeenCalled();
    });

    it("addFiles populates pending images", async () => {
      el = await createElement();
      const files = makeFileList(makeFile("photo.jpg", "image/jpeg"));
      el.addFiles(files);
      await el.updateComplete;
      expect((el as any)._pendingImages).toHaveLength(1);
    });

    it("addFiles rejects unsupported types", async () => {
      el = await createElement();
      const toastSpy = vi.spyOn(el, "showToast");
      const files = makeFileList(makeFile("doc.pdf", "application/pdf"));
      el.addFiles(files);
      expect((el as any)._pendingImages).toHaveLength(0);
      expect(toastSpy).toHaveBeenCalledWith("Use JPEG, PNG, GIF, or WebP");
    });

    it("accepts all four supported image types", async () => {
      el = await createElement();
      el.addFiles(makeFileList(makeFile("a.jpg", "image/jpeg")));
      el.addFiles(makeFileList(makeFile("b.png", "image/png")));
      el.addFiles(makeFileList(makeFile("c.gif", "image/gif")));
      el.addFiles(makeFileList(makeFile("d.webp", "image/webp")));
      expect((el as any)._pendingImages).toHaveLength(4);
    });

    it("renders thumbnail strip when images pending", async () => {
      el = await createElement();
      el.addFiles(makeFileList(makeFile("photo.jpg", "image/jpeg")));
      await el.updateComplete;
      const strip = el.querySelector(".overflow-x-auto");
      expect(strip).toBeTruthy();
      const thumbnails = strip!.querySelectorAll("img");
      expect(thumbnails).toHaveLength(1);
    });

    it("remove button clears image from pending", async () => {
      el = await createElement();
      el.addFiles(makeFileList(makeFile("photo.jpg", "image/jpeg")));
      await el.updateComplete;

      const removeBtn = el.querySelector(
        ".overflow-x-auto button",
      ) as HTMLButtonElement;
      expect(removeBtn).toBeTruthy();
      removeBtn.click();
      await el.updateComplete;

      expect((el as any)._pendingImages).toHaveLength(0);
      expect(el.querySelector(".overflow-x-auto")).toBeFalsy();
    });

    it("send button enabled when images pending and no text", async () => {
      el = await createElement();
      el.addFiles(makeFileList(makeFile("photo.jpg", "image/jpeg")));
      await el.updateComplete;
      const btn = el.querySelector(
        'button[title="Send"]',
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("no thumbnail strip when no images pending", async () => {
      el = await createElement();
      await el.updateComplete;
      expect(el.querySelector(".overflow-x-auto")).toBeFalsy();
    });
  });
});
