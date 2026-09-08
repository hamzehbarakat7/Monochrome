# Monochrome

A strict black-and-white, high-contrast Chrome extension built on Manifest V3
with no frameworks and no build step — just HTML, CSS, and vanilla JS.

## Features

- **Clock & Timer** — live clock (12h/24h) rendered with `requestAnimationFrame`,
  plus a countdown timer that keeps running in the background via `chrome.alarms`
  and notifies you on completion.
- **Short-form content blocker** — collapses YouTube Shorts, Instagram Reels,
  and TikTok feed items as you browse, with per-platform toggles and live counts.
- **Video speed controller** — hover overlay on any `<video>` element, 0.25×–4.00×,
  plus `S` / `D` / `R` hotkeys with an on-screen toast.
- **Media scanner** — finds video/audio/image sources on the current page
  (DOM + network) and lets you download them with one click.

## Install (unpacked)

1. Download or clone this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.

## Known limitations

- Adaptive-streaming players (MediaSource/`blob:`-backed, common on major
  video platforms) won't download as a complete file — only the buffered
  fragment is accessible. Direct file-backed sources work fine.
- Instagram/TikTok markup is obfuscated and changes often; the blocker relies
  on `href`/attribute heuristics rather than exact class names, so it may
  need occasional updates.
- Sub-minute timers may see their *notification* lag slightly behind the
  on-screen countdown due to Chrome's alarm scheduling floor.

## License

See [LICENSE](#license--contribution-terms) below.
