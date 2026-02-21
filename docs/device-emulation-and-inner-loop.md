# Plan: Device Emulation & Inner Loop Speed

> **Staleness note (2026-02):** This plan was written during the Vite+Lit era. Guéridon is now a single `index.html` with no build step — there's no Vite HMR, no `:5173` dev server. The passe device emulation and screenshot patterns remain valid; the dev sandbox (Phase 4) would need rethinking for the current architecture. Design iteration now happens in the `brisk-bear` repo using static state.json files.

**Origin:** Comparing Guéridon with Shelley (boldsoftware/shelley) surfaced that
Claude is blind during mobile UI iteration. The feedback loop is: edit → user
looks at phone → user describes what they see → Claude processes. This plan
makes Claude self-sufficient: edit → see → edit → see, all on kube, no human
in the loop until they want to be.

**Context:** Shelley blog post says *"Mobile-friendly because ideas can come any
time"* — both projects agree mobile web beats terminal. But Shelley's devs can
see their own UI. Guéridon's Claude can't. This plan fixes that.

## Architecture

```
┌─────────────────── kube ───────────────────┐
│                                             │
│  Claude edits src/ ──→ Vite HMR (:5173)    │
│                            │                │
│                            ▼                │
│  Chromium headless (:9222, iPhone viewport) │
│       │                    ▲                │
│       │ CDP localhost      │ loads page     │
│       ▼                    │                │
│  passe screenshot ◄────────┘                │
│       │                                     │
│       ▼                                     │
│  /tmp/mobile.jpg → Claude reads it          │
│                                             │
│  Dev bridge (:3002) ← Vite connects WS     │
│                                             │
├─────────────────────────────────────────────┤
│  Prod bridge (:3001) ← your phone (Safari) │
└─────────────────────────────────────────────┘
```

Everything above the line is Claude's dev sandbox. Below is the user's live
session. They don't touch each other.

## Key decisions

1. **Chromium on kube, not Mac Chrome.** No auth needed for dev testing. Eliminates
   Tailscale round-trip. CDP calls go over localhost (<1ms vs ~40ms over DERP).

2. **JPEG + optimizeForSpeed for screenshots.** 2-4× faster than PNG, smaller files
   for Claude to ingest. PNG stays default for fidelity; `--fast` flag for inner loop.

3. **Device presets as code, not config.** Python dict in `_devices.py`. No YAML, no
   external files. ~6 presets covering the devices that matter.

4. **Instrument before optimising.** Add timing breakdown to screenshot verb so we
   know where time goes before chasing micro-optimisations.

5. **`watch` verb for HMR-triggered auto-screenshot.** Listens for Vite's
   `[vite] hot updated` console message via `Runtime.consoleAPICalled`, waits
   100ms for Lit render, auto-screenshots. Turns edit-and-see into a zero-action
   loop.

## Phases

### Phase 1: Foundation — Chromium on kube + device presets

**Install Chromium on kube:**
```bash
sudo apt install chromium
chromium --headless=new --remote-debugging-port=9222 --no-sandbox &
```

Verify CDP works locally: `curl http://localhost:9222/json/version`

**Device presets** (`src/passe/_devices.py`):
```python
DEVICES = {
    "iPhone 14 Pro": {
        "width": 393, "height": 852, "deviceScaleFactor": 3,
        "mobile": True, "touch": True, "maxTouchPoints": 5,
        "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ...",
        "platform": "iPhone",
        "orientation": "portraitPrimary",
    },
    # iPhone SE, Pixel 7, iPad Air, iPad Pro 11, Desktop 1080p
}
```

**`device` DSL verb** — applies preset mid-script:
```
device "iPhone 14 Pro"
goto http://kube:5173
screenshot /tmp/mobile.png
```

Fires three CDP calls:
1. `Emulation.setDeviceMetricsOverride` (viewport + DPR + mobile + orientation)
2. `Emulation.setUserAgentOverride` (UA + platform)
3. `Emulation.setTouchEmulationEnabled` (touch + maxTouchPoints)

Bonus: `Emulation.setSafeAreaInsetsOverride` for iPhone notch — affects
`env(safe-area-inset-*)` CSS.

**`--device` flag** on `passe run` and `passe screenshot` for one-shot use.

### Phase 2: Fast screenshots + instrumentation

**JPEG + optimizeForSpeed:**
- Add `--format` flag (png/jpeg/webp, default png)
- Add `--quality` flag (0-100, JPEG only)
- Add `--fast` shorthand: sets jpeg/q70/optimizeForSpeed/viewport-only

**Timing breakdown** on screenshot verb:
```json
{"i":2, "verb":"screenshot", "ms":147,
 "breakdown":{"capture_ms":45, "decode_ms":12, "write_ms":3, "bytes":287431, "format":"png"}}
```

Three `time.monotonic()` calls. Zero overhead. Tells us whether to chase
encoding, base64 decode, or file I/O.

### Phase 3: `watch` verb — HMR-triggered auto-screenshot

```
passe run -c 'device "iPhone 14 Pro"; goto http://kube:5173; watch --fast /tmp/mobile-latest.jpg'
```

Implementation:
1. `Runtime.enable()` to receive console events
2. Listen for `Runtime.consoleAPICalled` where `args[0].value` starts with
   `"[vite] hot updated"`
3. Debounce 100ms (Lit async render cycle)
4. `Page.captureScreenshot` with JPEG/optimizeForSpeed
5. Write to the specified path (overwrite each time)
6. Log each capture to stderr: `{"event":"hmr","file":"/src/foo.ts","screenshot_ms":23}`
7. Stays alive until killed (Ctrl-C or signal)

Also responds to `[vite] page reload` (full reload case) — waits for
`Page.loadEventFired` before screenshot.

### Phase 4: Guéridon dev sandbox

**Dev bridge on :3002:**
- Add `PORT` env var support to bridge.ts (one line)
- `PORT=3002 npm run bridge` for dev, `:3001` stays production

**Guéridon test hooks** — thin `window.__gdn` namespace:
```javascript
window.__gdn = {
    simulateDisconnect: () => { /* close WS, trigger reconnect UI */ },
    showToast: (msg, type) => { /* fire toaster */ },
    setContextGauge: (pct) => { /* set gauge to specific % */ },
    triggerAskUser: (q) => { /* show AskUser dialog */ },
};
```

These let passe trigger any UI state for visual testing:
```
device "iPhone 14 Pro"
goto http://kube:5173
eval window.__gdn.showToast('Context compacting...', 'warning')
wait 300
screenshot --fast /tmp/toaster.jpg
```

### Phase 5: Skill update

Update SKILL.md with:
- `device` verb documentation
- `--device` flag on run/screenshot
- `--fast` and `--format`/`--quality` flags
- `watch` verb with HMR integration
- The kube-local Chrome pattern (vs Mac Chrome for authenticated browsing)
- Anti-pattern: using PNG for inner-loop screenshots (use `--fast`)

## What this enables for Guéridon development

| Before | After |
|--------|-------|
| Edit → user looks at phone → describes → Claude processes | Edit → Claude sees result in <200ms |
| Toaster/disconnect testing requires reproduction on phone | `eval window.__gdn.showToast(...)` + screenshot |
| One server, dev disrupts prod | Dev (:3002) and prod (:3001) isolated |
| Chrome on Mac, 40ms CDP round-trips | Chromium on kube, <1ms CDP |
| PNG screenshots, 30-80ms, 200-500KB | JPEG --fast, 10-20ms, 30-80KB |

## Fidelity caveat

This is Chrome's Blink engine pretending to be Safari's WebKit. For 90% of UI
work (layout, spacing, colours, components) it's pixel-close. For Safari-specific
bugs (`-webkit-` scroll, safe-area-insets, rubber-band bounce, backdrop-filter)
the user is still the oracle. The device emulation handles viewport, DPR, UA,
and touch — not the rendering engine.
