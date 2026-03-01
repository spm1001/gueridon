# iOS Standalone Viewport Lie

Investigated 2026-02-28. iPhone 14 Pro, iOS (version TBC).

## The Problem

In iOS standalone mode (Add to Home Screen with `apple-mobile-web-app-capable`), all CSS viewport units and most JS APIs report a height shorter than the actual screen:

| API / Unit | Standalone value | True screen | Lies? |
|------------|-----------------|-------------|-------|
| `screen.height` | 852px | 852px | No |
| `100dvh` | 793px | 852px | **Yes** |
| `100vh` | 793px | 852px | **Yes** |
| `100svh` | 793px | 852px | **Yes** |
| `-webkit-fill-available` | 793px | 852px | **Yes** |
| `window.innerHeight` | 793px* | 852px | **Yes** |
| `visualViewport.height` | 793px* | 852px | **Yes** |

\* These can change to 852px after a viewport recalculation (see below).

The 59px gap is exactly `env(safe-area-inset-top)` — the status bar / Dynamic Island area. In regular Safari, the browser's own chrome accounts for this space. In standalone mode, there's no chrome, so the 59px becomes a visible black gap at the bottom of the screen.

### Safari comparison (same device)

| API / Unit | Safari value | Notes |
|------------|-------------|-------|
| `100dvh` | 695px | Correct — Safari URL bar + tab bar eat 157px |
| `env(safe-area-inset-top)` | 8px | Safari's chrome handles the notch |
| `env(safe-area-inset-bottom)` | 8px | Safari's chrome handles the home indicator |

In standalone mode, `safe-area-inset-top` is 59px and `safe-area-inset-bottom` is 34px — the raw hardware insets.

## Experiments

### 1. `-webkit-fill-available`

```css
body { height: -webkit-fill-available; }
```

**Result:** Resolves to 793px — same as `100dvh`. WebKit's "fill available" also lies in standalone.

**Side observation:** With `-webkit-fill-available`, the page rubber-bands on drag. With `100dvh`, the page can "dock" — slide into position and stay (see experiment 4).

### 2. `calc(100dvh + env(safe-area-inset-top))`

```css
html, body { height: calc(100dvh + env(safe-area-inset-top, 0px)); }
```

**Result:** Creates a feedback loop.
1. CSS evaluates: 793 + 59 = 852px. Body fits the screen.
2. Body exceeding the 793px viewport triggers iOS to recalculate the viewport to 852px.
3. CSS re-evaluates: `100dvh` is now 852, so 852 + 59 = 911px. Body overshoots by 59px.
4. The button bar hangs off the bottom of the screen.

### 3. Same + `overflow: hidden`

```css
html, body {
  height: calc(100dvh + env(safe-area-inset-top, 0px));
  overflow: hidden;
}
```

**Result:** iOS ignores `overflow: hidden` for viewport-level scrolling in standalone mode. The feedback loop still fires. Body still 911px.

### 4. The docking behaviour

With plain `100dvh` (793px body, 59px gap), the page can be dragged downward and it **stays** — it doesn't rubber-band back. iOS treats the 793px body as a sled on the 852px screen. After the user drags it into position, iOS recalculates the viewport to 852px and `100dvh` re-resolves.

This is not rubber-banding (elastic overscroll). It's a discrete viewport resize triggered by user gesture. Force-quitting the app resets to the 793px state.

### 5. `calc(100dvh + 1px)` — the fix

```css
html, body { height: calc(100dvh + 1px); }
```

**Result:** Works. The 1px overflow is enough to trigger the viewport recalculation. iOS smoothly animates the expansion (the page "slides" into place by itself). After recalculation:

- `100dvh` = 852px
- body.h = 853px (852 + 1)
- gap = -1px (1px overshoot, invisible)

The body is 1px taller than the screen — completely imperceptible.

**In Safari:** body = 696px (695 + 1). The 1px overshoot is invisible. Safari doesn't trigger any recalculation because its viewport isn't lying. Effectively neutral.

## The Fix

```css
/* iOS standalone: viewport units lie (793px vs 852px screen).
   +1px forces iOS to recalculate the viewport to the true height.
   Overshoot is 1px — invisible. Neutral in Safari. */
html, body {
  height: calc(100dvh + 1px);
}
```

This is a **CSS-only fix** that replaces the previous JS-only approach:

```javascript
// Previous: JS sets screen.height on html+body
document.documentElement.style.height = screen.height + 'px';
document.body.style.height = screen.height + 'px';
```

The JS fix remains useful for keyboard resize handling (`visualViewport` resize events set height to `visualViewport.height` when keyboard opens, `screen.height` when it closes). But the initial layout no longer depends on JS.

## `display-mode: standalone` media query doesn't match

When a page is added to the iOS home screen via `apple-mobile-web-app-capable`, the CSS `@media (display-mode: standalone)` media query **does not match** — it reports as `browser`. This is despite the page visually running in standalone mode (no Safari chrome, 793px viewport not 695px).

The `calc(100dvh + 1px)` fix is applied unconditionally (not behind a standalone media query) because:
1. The media query is unreliable on iOS
2. The effect is neutral in Safari (+1px is invisible)

## Related

- `style.css` line 321: comment about standalone height
- `index.html` line 119: JS standalone viewport fix (keyboard resize handling)
- MEMORY.md: iOS standalone viewport gap entry
- `docs/device-emulation-and-inner-loop.md` line 184: fidelity caveat about WebKit vs Blink
