// Shared fixture data for mockup scenes and tests.
// Follows the same IIFE + dual-export pattern as other client/*.cjs modules.
// Shapes match BBState/BBMessage/BBToolCall from server/state-builder.ts.

(function () {
  "use strict";

  // --- Tool calls ---

  const TOOL_READ_DONE = {
    name: "Read",
    input: "server/bridge.ts",
    output: "const http = require('http');\nconst { spawn } = require('child_process');\n// ... 1068 lines",
    status: "completed",
  };

  const TOOL_BASH_DONE = {
    name: "Bash",
    input: "npm test",
    output: "✓ 423 tests passed (6.6s)",
    status: "completed",
  };

  const TOOL_GREP_DONE = {
    name: "Grep",
    input: "field-sizing",
    output: "style.css:361:  field-sizing: content;",
    status: "completed",
  };

  const TOOL_EDIT_DONE = {
    name: "Edit",
    input: "style.css",
    output: "The file style.css has been updated successfully.",
    status: "completed",
  };

  const TOOL_BASH_RUNNING = {
    name: "Bash",
    input: "npm test",
    output: null,
    status: "running",
  };

  const TOOL_EDIT_ERROR = {
    name: "Edit",
    input: "style.css",
    output: "old_string not found in file",
    status: "error",
  };

  const TOOL_GLOB_DONE = {
    name: "Glob",
    input: "client/*.cjs",
    output: "client/render-utils.cjs\nclient/render-chips.cjs\nclient/render-messages.cjs\nclient/render-chrome.cjs",
    status: "completed",
  };

  const TOOL_WEBSEARCH_DONE = {
    name: "WebSearch",
    input: "field-sizing content CSS Safari support",
    output: "Safari 26.2 adds support for field-sizing: content.",
    status: "completed",
  };

  // --- Messages ---

  const MSG_USER_SIMPLE = { role: "user", content: "Can you check the layout CSS?" };
  const MSG_USER_LONG = { role: "user", content: "I've been noticing some visual jank in the input area — the gap between the textarea and the button bar feels uneven, and the + and / buttons don't look quite right. Can you take a look at style.css and the css-shell and figure out what's going on?" };
  const MSG_USER_WITH_DEPOSIT = { role: "user", content: "[guéridon:upload] Deposited 1 file to mise/upload--gueridon--abc123:\n  • screenshot.png (image/png, 54 KB)\n\nHere's the screenshot of the layout issue" };
  const MSG_USER_OPTIMISTIC = { role: "user", content: "Fix the gap spacing", _msgId: "opt-001" };

  const MSG_ASSISTANT_SHORT = { role: "assistant", content: "I'll take a look at the CSS." };
  const MSG_ASSISTANT_MARKDOWN = { role: "assistant", content: "The layout uses **body-scroll** — the document itself scrolls, not a container element. Key rules:\n\n- `body { min-height: 100dvh }` — grows with content\n- `.messages { flex: 1 0 auto }` — never collapses\n- `.input-area { position: sticky; bottom: 0 }` — stays at viewport bottom\n\nThis enables Safari Full Page screenshots." };
  const MSG_ASSISTANT_CODE = { role: "assistant", content: "Here's the fix:\n\n```css\n.input-area {\n  gap: 8px; /* uniform spacing */\n}\n```\n\nThe `8px` matches the `btn-bar` gap and creates even rhythm." };
  const MSG_ASSISTANT_WITH_TOOLS = {
    role: "assistant",
    content: "Found the issue — the gap was 6px on `.input-area` but 8px on `.btn-bar`.",
    tool_calls: [TOOL_READ_DONE, TOOL_GREP_DONE],
  };
  const MSG_ASSISTANT_TOOLS_ONLY = {
    role: "assistant",
    content: null,
    tool_calls: [TOOL_READ_DONE, TOOL_EDIT_DONE, TOOL_BASH_DONE],
  };
  const MSG_ASSISTANT_THINKING = {
    role: "assistant",
    content: "The `field-sizing: content` property is supported in Safari 26.2+, so no fallback needed for your device.",
    thinking: "The user is asking about field-sizing support. Let me check — Safari 26.2 shipped it in December 2025. Their phone is running iOS 18+ which includes Safari 26.2. So it should work. The @supports fallback bon item (gdn-camiki) can be closed.",
  };
  const MSG_ASSISTANT_RUNNING = {
    role: "assistant",
    content: null,
    tool_calls: [TOOL_BASH_RUNNING],
  };
  const MSG_ASSISTANT_ERROR = {
    role: "assistant",
    content: "The edit failed — let me try a different approach.",
    tool_calls: [TOOL_EDIT_ERROR],
  };

  const MSG_SYSTEM = { role: "user", content: "Session resumed after bridge restart", synthetic: true };
  const MSG_LOCAL_COMMAND = { role: "user", content: "<local-command-stdout>Model: claude-opus-4-6\nContext: 45% (92k/200k tokens)\nSession: c5c1fbfa</local-command-stdout>" };

  // --- Thinking ---

  const THINKING_SHORT = "Let me check the CSS for the input area gap.";
  const THINKING_LONG = "The user wants to understand the field-sizing property. Let me think through this carefully.\n\nfield-sizing: content is a CSS property that makes form elements (textarea, input) auto-size to fit their content. It was proposed as part of CSS UI Level 4. Chrome shipped it in version 123 (March 2024), Firefox in 133 (late 2024). Safari added it in Technology Preview and shipped it in Safari 26.2 (December 2025).\n\nThe previous approach used a JS input event listener that reset the textarea height on every keystroke: ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'. This worked everywhere but was imperative layout work.\n\nWith field-sizing: content, the browser handles it natively. The textarea grows as text is added and shrinks as text is removed. Combined with max-height: 40dvh and overflow-y: auto, it caps at 40% of the viewport then becomes scrollable.\n\nSince the user's phone runs Safari 26.2+, this works. No @supports fallback needed.";

  // --- Slash commands ---

  const SLASH_COMMANDS = [
    { name: "/compact", description: "Compact conversation context", local: true },
    { name: "/context", description: "Show context window usage", local: true },
    { name: "/cost", description: "Show session cost", local: true },
    { name: "/help", description: "Get help with Claude Code", local: true },
    { name: "/commit", description: "Create a git commit", local: false },
    { name: "/review", description: "Review code changes", local: false },
    { name: "/close", description: "End-of-session ritual", local: false },
  ];

  // --- Switcher sessions ---

  const SWITCHER_SESSIONS = [
    {
      project: "gueridon",
      id: "/home/modha/Repos/gueridon",
      status: "now",
      backendState: "active",
      context_pct: 45,
      humanSessionCount: 1,
      updated: new Date(Date.now() - 5 * 60_000).toISOString(),
      last_message: "CSS-first layout migration",
      sessions: [
        { id: "c5c1fbfa-6608-4f73-a437-23a13b4217a5", lastActive: new Date(Date.now() - 5 * 60_000).toISOString(), contextPct: 45, model: "claude-opus-4-6", closed: false, humanInteraction: true },
      ],
    },
    {
      project: "bon",
      id: "/home/modha/Repos/bon",
      status: "now",
      backendState: "paused",
      context_pct: 72,
      humanSessionCount: 2,
      updated: new Date(Date.now() - 25 * 60_000).toISOString(),
      last_message: "Tactical step persistence",
      sessions: [
        { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", lastActive: new Date(Date.now() - 25 * 60_000).toISOString(), contextPct: 72, model: "claude-opus-4-6", closed: false, humanInteraction: true },
        { id: "f9e8d7c6-b5a4-3210-fedc-ba0987654321", lastActive: new Date(Date.now() - 3_600_000).toISOString(), contextPct: 95, model: "claude-sonnet-4-5-20250514", closed: true, humanInteraction: true },
      ],
    },
    {
      project: "trousse",
      id: "/home/modha/Repos/trousse",
      status: "previous",
      backendState: "closed",
      context_pct: 88,
      humanSessionCount: 1,
      updated: new Date(Date.now() - 7_200_000).toISOString(),
      last_message: "Skill-forge validation",
      sessions: [
        { id: "11223344-5566-7788-99aa-bbccddeeff00", lastActive: new Date(Date.now() - 7_200_000).toISOString(), contextPct: 88, model: "claude-opus-4-6", closed: true, humanInteraction: true },
      ],
    },
    {
      project: "passe",
      id: "/home/modha/Repos/passe",
      status: "previous",
      backendState: "closed",
      context_pct: 30,
      humanSessionCount: 1,
      updated: new Date(Date.now() - 86_400_000).toISOString(),
      last_message: "CDP screenshot pipeline",
      sessions: [
        { id: "aabbccdd-eeff-0011-2233-445566778899", lastActive: new Date(Date.now() - 86_400_000).toISOString(), contextPct: 30, model: "claude-sonnet-4-5-20250514", closed: true, humanInteraction: true },
      ],
    },
    {
      project: "dotfiles",
      id: "/home/modha/Repos/dotfiles",
      status: "fresh",
      backendState: "fresh",
      context_pct: 0,
      humanSessionCount: 0,
      updated: null,
      last_message: null,
      sessions: [],
    },
  ];

  // --- Session state (for renderStatusBar) ---

  const SESSION_IDLE = {
    session: { id: "c5c1fbfa", project: "gueridon", context_pct: 45, model: "claude-opus-4-6" },
    connection: "connected",
    status: "idle",
  };

  const SESSION_WORKING = {
    session: { id: "c5c1fbfa", project: "gueridon", context_pct: 45, model: "claude-opus-4-6" },
    connection: "connected",
    status: "working",
  };

  const SESSION_DISCONNECTED = {
    session: { id: "c5c1fbfa", project: "gueridon", context_pct: 45, model: "claude-opus-4-6" },
    connection: "disconnected",
    status: "idle",
  };

  const SESSION_HIGH_CONTEXT = {
    session: { id: "c5c1fbfa", project: "gueridon", context_pct: 92, model: "claude-opus-4-6" },
    connection: "connected",
    status: "idle",
  };

  const SESSION_NO_FOLDER = {
    session: {},
    connection: "connected",
    status: "idle",
  };

  // --- Deposit manifests ---

  const DEPOSIT_SINGLE = {
    folder: "mise/upload--gueridon--abc123",
    manifest: {
      files: [{ deposited_as: "screenshot.png", mime_type: "image/png", size_bytes: 54321 }],
      warnings: [],
    },
  };

  const DEPOSIT_MULTI = {
    folder: "mise/upload--gueridon--def456",
    manifest: {
      files: [
        { deposited_as: "error-log.txt", mime_type: "text/plain", size_bytes: 2048 },
        { deposited_as: "config.json", mime_type: "application/json", size_bytes: 512 },
        { deposited_as: "photo.heic", mime_type: "application/octet-stream", size_bytes: 3_200_000 },
      ],
      warnings: ["photo.heic: deposited as binary (HEIC not supported)"],
    },
  };

  // --- Composite scenes (full conversations for mockup rendering) ---

  const SCENE_CONVERSATION = [
    MSG_USER_SIMPLE,
    MSG_ASSISTANT_WITH_TOOLS,
    MSG_USER_LONG,
    MSG_ASSISTANT_THINKING,
    MSG_ASSISTANT_TOOLS_ONLY,
    MSG_ASSISTANT_MARKDOWN,
  ];

  const SCENE_STREAMING = [
    MSG_USER_SIMPLE,
    MSG_ASSISTANT_RUNNING,
  ];

  const SCENE_ERROR = [
    MSG_USER_SIMPLE,
    MSG_ASSISTANT_ERROR,
    { role: "user", content: "Try editing with a bigger context" },
    MSG_ASSISTANT_WITH_TOOLS,
  ];

  const SCENE_DEPOSIT = [
    MSG_USER_WITH_DEPOSIT,
    MSG_ASSISTANT_SHORT,
    MSG_ASSISTANT_TOOLS_ONLY,
    MSG_ASSISTANT_MARKDOWN,
  ];

  const SCENE_SYSTEM = [
    MSG_SYSTEM,
    MSG_USER_SIMPLE,
    MSG_ASSISTANT_SHORT,
  ];

  // --- Exports ---

  var mod = {
    // Tool calls
    TOOL_READ_DONE,
    TOOL_BASH_DONE,
    TOOL_GREP_DONE,
    TOOL_EDIT_DONE,
    TOOL_BASH_RUNNING,
    TOOL_EDIT_ERROR,
    TOOL_GLOB_DONE,
    TOOL_WEBSEARCH_DONE,

    // Messages
    MSG_USER_SIMPLE,
    MSG_USER_LONG,
    MSG_USER_WITH_DEPOSIT,
    MSG_USER_OPTIMISTIC,
    MSG_ASSISTANT_SHORT,
    MSG_ASSISTANT_MARKDOWN,
    MSG_ASSISTANT_CODE,
    MSG_ASSISTANT_WITH_TOOLS,
    MSG_ASSISTANT_TOOLS_ONLY,
    MSG_ASSISTANT_THINKING,
    MSG_ASSISTANT_RUNNING,
    MSG_ASSISTANT_ERROR,
    MSG_SYSTEM,
    MSG_LOCAL_COMMAND,

    // Thinking text
    THINKING_SHORT,
    THINKING_LONG,

    // Slash commands
    SLASH_COMMANDS,

    // Switcher
    SWITCHER_SESSIONS,

    // Session states
    SESSION_IDLE,
    SESSION_WORKING,
    SESSION_DISCONNECTED,
    SESSION_HIGH_CONTEXT,
    SESSION_NO_FOLDER,

    // Deposits
    DEPOSIT_SINGLE,
    DEPOSIT_MULTI,

    // Composite scenes
    SCENE_CONVERSATION,
    SCENE_STREAMING,
    SCENE_ERROR,
    SCENE_DEPOSIT,
    SCENE_SYSTEM,
  };

  if (typeof window !== "undefined") window.Gdn = Object.assign(window.Gdn || {}, mod);
  if (typeof module !== "undefined") module.exports = mod;
})();
