# ChatGPT Swift v0.4.1

This build upgrades the v0.3 line with **automatic near-viewport restore** and a more performance-focused update path for long ChatGPT sessions.

## New in v0.4.1
- Auto-restores virtualized messages when they approach the viewport
- Uses separate restore and virtualize thresholds to avoid placeholder flicker
- Batches auto-restores across animation frames to reduce scroll jank
- Reuses placeholders instead of recreating them repeatedly
- Processes heavy code blocks incrementally instead of rescanning all `pre` tags on every update
- Uses `ResizeObserver` to keep placeholder heights more accurate as live content changes
- Adds a lighter route-change detector and tighter mutation filtering
- Unifies defaults across content script, popup, options, and service worker

## Recommended defaults
- Min messages before virtualizing: 12
- Overscan: 3
- Keep newest live: 4
- Pause after typing: 800ms
- Auto restore above viewport: 320px
- Auto restore below viewport: 760px
- Virtualize above viewport: 1400px
- Virtualize below viewport: 1800px
- Auto restores per frame: 2

## Behavior summary
- Nearby messages stay live or auto-restore before you reach them
- Mid-distance messages are left alone to avoid unnecessary DOM churn
- Far-away history becomes placeholders to keep the live DOM small
- Safe mode keeps all messages in the DOM and applies browser-side containment instead of placeholder replacement

## Install
1. Open `chrome://extensions` or `edge://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Choose this folder
5. Reload ChatGPT


## v0.4.1

- Fixed auto restore by observing virtualized placeholders with IntersectionObserver so they restore when they approach the viewport.
- Kept restore batching and hysteresis so nearby history becomes visible automatically without causing heavy scroll jank.
