# CSS Shell Testing

`css-shell.html` is a standalone test page for validating CSS layout changes before they land in production. It loads `style.css` via `<link>`, then overrides specific rules in a `<style>` block. No bridge connection, no SSE — just layout and scroll behaviour.

## URL

```
https://tube.atlas-cloud.ts.net/css-shell
```

Served by the bridge's STATIC_FILES (`/css-shell` → `css-shell.html`).

## What it tests

| Feature | How to test |
|---------|------------|
| **Body-scroll layout** | Scroll through dummy messages — document scrolls, not a container element |
| **Sticky input** | Input area stays at viewport bottom while scrolling. Disappears at extreme top (intentional — reappears on slight scroll down) |
| **Scroll-snap auto-follow** | Tap send button to start streaming simulator (800ms intervals). Stay near bottom — should auto-follow. Scroll up — should leave you alone |
| **scroll-padding-bottom** | When snap engages, last message should land above the input area, not behind it |
| **field-sizing: content** | Type multiple lines in textarea — grows with content, no JS needed |
| **Keyboard behaviour** | Tap textarea — keyboard opens, input stays visible. Dismiss — snaps back cleanly |
| **will-change: transform** | No visible sticky flicker during keyboard open/close animation |
| **Pull-to-refresh** | Scroll past the top — Safari pull-to-refresh should trigger (desired behaviour) |

## Streaming simulator

The **send button** toggles a streaming simulator:
- Tap once → starts appending messages every 800ms (button turns red)
- Tap again → stops

Use this to test scroll-snap behaviour during rapid DOM mutations, simulating Claude streaming a response.

## Diagnostics panel

The `<pre id="diag">` block at the top shows live measurements, updated on scroll/resize:

| Field | What it tells you |
|-------|------------------|
| `OVERFLOW: YES/NO` | Whether the document is taller than the viewport (required for Full Page screenshots and scroll-snap) |
| `doc.scrollH` | Document scroll height — should exceed `innerHeight` |
| `window.scrollY` | Live scroll position — confirms document-level scrolling |
| `html overflow` | Should be `visible` — if `hidden`, standalone media query is leaking through |
| `input sticky` | Should be `sticky` — confirms the override is winning |

## CSS overrides in the shell

The `<style>` block overrides these `style.css` rules:

```css
html  { overflow: visible !important; scroll-snap-type: y proximity; scroll-padding-bottom: ... }
body  { height: auto; min-height: 100dvh; }
.messages    { overflow-y: visible; flex: 1 0 auto; }
.input-area  { position: sticky; bottom: 0; z-index: 10; will-change: transform; }
.input-field { field-sizing: content; max-height: none; }
```

When a shell override is validated, migrate it to `style.css` proper.

## Testing checklist (iOS)

Test in **both** Safari and standalone (they have different viewport behaviour):

- [ ] Messages scroll freely (document scroll, not element scroll)
- [ ] Input bar sticks at bottom during scroll
- [ ] Input bar disappears at extreme top, reappears on scroll down
- [ ] Streaming simulator: auto-follows at bottom
- [ ] Streaming simulator: doesn't yank when scrolled up
- [ ] Snap lands above input area (not behind it)
- [ ] Textarea grows with multi-line input
- [ ] Keyboard open/close: no layout breakage
- [ ] Safari: Full Page screenshot tab appears (not available in standalone)
- [ ] Safari: URL bar shrinks on scroll down
- [ ] Diagnostics: OVERFLOW shows YES

## Workflow

1. Make CSS changes in `css-shell.html` `<style>` block
2. Commit, push, deploy (`cd /opt/gueridon && git pull && sudo systemctl restart gueridon`)
3. Test on phone at `/css-shell`
4. Once validated, apply the same rules to `style.css`
5. Delete or update the shell override (keep the shell as a regression test bed)
