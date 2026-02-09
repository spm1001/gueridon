# Vendored pi-web-ui Components

One-time copy of 6 files from `pi-mono/packages/web-ui/src/`.

## Provenance

- **Source:** `~/Repos/pi-mono` (fork of badlogic/pi-mono)
- **Branch:** `gueridon`
- **Commit:** `41c4157b` — "fix(web-ui): remove per-message stats, fix double render on message_end"
- **Date:** 2026-02-09

## What's here

| File | Origin | Import rewrites |
|------|--------|----------------|
| `MessageList.ts` | `components/MessageList.ts` | `./message-renderer-registry.js` (unchanged) |
| `StreamingMessageContainer.ts` | `components/StreamingMessageContainer.ts` | None |
| `ThinkingBlock.ts` | `components/ThinkingBlock.ts` | None |
| `ConsoleBlock.ts` | `components/ConsoleBlock.ts` | `../utils/i18n.js` → `./i18n.js` |
| `message-renderer-registry.ts` | `components/message-renderer-registry.ts` | None |
| `i18n.ts` | `utils/i18n.ts` | Trimmed to ~10 keys (from 200+) |

## Why vendored (not imported from pi-web-ui)

pi-web-ui's barrel (`index.ts`) loads ~30 modules. Many have heavy transitive
deps (pdfjs-dist, xlsx, jszip, @aws-sdk) that break in our browser bundle.
We only need 4 container/display components. Vendoring them eliminates:

- The `@mariozechner/pi-web-ui` barrel and all 30+ modules
- Vite alias pointing to pi-mono fork source
- `optimizeDeps.exclude` for pi-web-ui
- `renderTool` chain and its deps (javascript-repl, extract-document, etc.)
- `@smithy` / `@aws-sdk` build externals

## What we own instead

`src/message-components.ts` — our own `<user-message>`, `<assistant-message>`,
`<tool-message>` implementations. These replace pi-web-ui's `Messages.ts` and
its `renderTool` chain with much simpler rendering.

## Update strategy

These files are frozen at the commit above. If upstream fixes a bug in
MessageList or StreamingMessageContainer, cherry-pick the specific change
into the vendored file. Don't re-vendor the whole barrel.

## Drift detection

`.provenance.json` records the commit hash and file mapping in machine-readable
form. `update-all.sh` (in claude-suite) diffs these 6 files against
`upstream/main` in `~/Repos/pi-mono` daily and reports drift in session-start
news. When you see a drift report, review the diff and cherry-pick what's useful.
