'use strict';

/* ======================================================================
   Shared state, loaded from storage on inject and kept live via
   chrome.storage.onChanged so every open tab stays in sync with the
   popup regardless of which tab last changed a setting.
   ====================================================================== */

const BLOCKER_KEY = 'mono_blocker_settings';
const SPEED_KEY = 'mono_speed_enabled';
const DEFAULT_BLOCKER = { master: true, youtube: true, instagram: true, tiktok: true };

let blockerSettings = { ...DEFAULT_BLOCKER };
let speedEnabled = true;

const collapsedSets = {
  youtube: new WeakSet(),
  instagram: new WeakSet(),
  tiktok: new WeakSet(),
};
const collapsedCounts = { youtube: 0, instagram: 0, tiktok: 0 };

chrome.storage.sync.get([BLOCKER_KEY, SPEED_KEY], (res) => {
  blockerSettings = { ...DEFAULT_BLOCKER, ...(res[BLOCKER_KEY] || {}) };
  speedEnabled = res[SPEED_KEY] !== false;
  runBlockerPass();
  if (speedEnabled) enhanceAllVideos();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes[BLOCKER_KEY]) {
    blockerSettings = { ...DEFAULT_BLOCKER, ...changes[BLOCKER_KEY].newValue };
    runBlockerPass();
  }
  if (changes[SPEED_KEY]) {
    speedEnabled = changes[SPEED_KEY].newValue !== false;
    if (speedEnabled) enhanceAllVideos();
    else disableAllOverlays();
  }
});

function platformFromHost() {
  const h = location.hostname;
  if (h.includes('youtube.com')) return 'youtube';
  if (h.includes('instagram.com')) return 'instagram';
  if (h.includes('tiktok.com')) return 'tiktok';
  return null;
}

/* ======================================================================
   Short-form feed blocker
   Selectors on YouTube/Instagram/TikTok are not part of any public API and
   change as the sites redeploy their frontends, so each platform pass pairs
   a couple of known container selectors with an href-based heuristic
   (matching links to /shorts/, /reel/, etc.) that tends to survive markup
   churn better than exact class names.
   ====================================================================== */

function collapse(el, platformKey) {
  if (!el || collapsedSets[platformKey].has(el)) return;
  collapsedSets[platformKey].add(el);
  el.classList.add('mono-collapsed');
  collapsedCounts[platformKey] += 1;
}

function blockYouTubeShorts() {
  document
    .querySelectorAll('ytd-reel-video-renderer, ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]')
    .forEach((el) => collapse(el, 'youtube'));

  // Shorts entries mixed into normal video grids/results link to /shorts/<id>
  document
    .querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer')
    .forEach((el) => {
      if (collapsedSets.youtube.has(el)) return;
      const link = el.querySelector('a[href^="/shorts/"]');
      if (link) collapse(el, 'youtube');
    });
}

function blockInstagramReels() {
  // Instagram's own class names are hashed and rotate on nearly every deploy,
  // so we anchor on the one stable signal: an <a> pointing at /reel/ or /reels/.
  document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]').forEach((a) => {
    const container = a.closest('article') || a.closest('div[role="button"]') || a.parentElement;
    if (container) collapse(container, 'instagram');
  });
}

function blockTikTokFeed() {
  document
    .querySelectorAll('div[data-e2e="recommend-list-item-container"], div[data-e2e="feed-video"]')
    .forEach((el) => collapse(el, 'tiktok'));
}

function runBlockerPass() {
  if (!blockerSettings.master) return;
  const platform = platformFromHost();
  if (platform === 'youtube' && blockerSettings.youtube) blockYouTubeShorts();
  if (platform === 'instagram' && blockerSettings.instagram) blockInstagramReels();
  if (platform === 'tiktok' && blockerSettings.tiktok) blockTikTokFeed();
}

const blockerObserver = new MutationObserver(() => {
  clearTimeout(blockerObserver._t);
  blockerObserver._t = setTimeout(runBlockerPass, 150);
});
blockerObserver.observe(document.documentElement, { childList: true, subtree: true });

// Infinite-scroll feeds sometimes mutate in ways the observer's debounce
// misses (e.g. attribute-only swaps); a light interval is cheap insurance.
setInterval(runBlockerPass, 3000);

/* ======================================================================
   Global video speed controller
   ====================================================================== */

let lastInteractedVideo = null;

function clampRate(r) {
  return Math.min(4, Math.max(0.25, Math.round(r * 100) / 100));
}

function attachSpeedOverlay(video) {
  if (!speedEnabled || video.dataset.monoAttached) return;
  video.dataset.monoAttached = '1';

  const overlay = document.createElement('div');
  overlay.className = 'mono-speed-overlay';
  overlay.innerHTML =
    '<button type="button" data-action="dec" aria-label="Decrease speed">\u2212</button>' +
    '<span class="mono-rate">1.00\u00d7</span>' +
    '<button type="button" data-action="inc" aria-label="Increase speed">+</button>';
  document.body.appendChild(overlay);

  const rateLabel = overlay.querySelector('.mono-rate');

  const setRate = (rate) => {
    rate = clampRate(rate);
    video.playbackRate = rate;
    rateLabel.textContent = `${rate.toFixed(2)}\u00d7`;
  };

  overlay.querySelector('[data-action="dec"]').addEventListener('click', (e) => {
    e.stopPropagation();
    setRate(video.playbackRate - 0.25);
  });
  overlay.querySelector('[data-action="inc"]').addEventListener('click', (e) => {
    e.stopPropagation();
    setRate(video.playbackRate + 0.25);
  });

  function reposition() {
    if (!document.body.contains(video)) {
      teardown();
      return;
    }
    const rect = video.getBoundingClientRect();
    const visible =
      rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
    overlay.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    overlay.style.top = `${Math.max(4, rect.top + 8)}px`;
    overlay.style.left = `${Math.max(4, rect.left + 8)}px`;
  }

  const onScroll = () => reposition();
  const onResize = () => reposition();
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize);
  const intervalId = setInterval(reposition, 500);
  reposition();

  const onEnter = () => {
    overlay.classList.add('mono-visible');
    lastInteractedVideo = video;
  };
  const onLeave = () => overlay.classList.remove('mono-visible');
  video.addEventListener('mouseenter', onEnter);
  video.addEventListener('mouseleave', onLeave);
  overlay.addEventListener('mouseenter', () => overlay.classList.add('mono-visible'));
  overlay.addEventListener('mouseleave', onLeave);

  function teardown() {
    clearInterval(intervalId);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    overlay.remove();
    delete video.dataset.monoAttached;
  }

  video._monoSetRate = setRate;
  video._monoTeardown = teardown;
  setRate(video.playbackRate || 1);
}

function enhanceAllVideos() {
  document.querySelectorAll('video').forEach(attachSpeedOverlay);
}

function disableAllOverlays() {
  document.querySelectorAll('video').forEach((v) => {
    if (v._monoTeardown) v._monoTeardown();
  });
}

const videoObserver = new MutationObserver(() => {
  if (speedEnabled) enhanceAllVideos();
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

function pickVisibleVideo() {
  return (
    Array.from(document.querySelectorAll('video')).find((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    }) || null
  );
}

let toastEl = null;
let toastTimer = null;
function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'mono-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('mono-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('mono-show'), 900);
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!speedEnabled) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (key !== 's' && key !== 'd' && key !== 'r') return;

    const video = lastInteractedVideo && document.body.contains(lastInteractedVideo)
      ? lastInteractedVideo
      : pickVisibleVideo();
    if (!video) return;

    e.preventDefault();
    let rate = video.playbackRate;
    if (key === 's') rate -= 0.25;
    if (key === 'd') rate += 0.25;
    if (key === 'r') rate = 1;
    rate = clampRate(rate);
    video.playbackRate = rate;
    if (video._monoSetRate) video._monoSetRate(rate);
    showToast(`Speed ${rate.toFixed(2)}\u00d7`);
  },
  true
);

/* ======================================================================
   Media scanner
   Note: video/audio elements backed by adaptive streaming (MediaSource /
   blob: URLs, common on YouTube-style players) won't yield a downloadable
   whole file this way — the blob only represents currently buffered
   segments, not the full source. Direct <video src>, <source src>, and
   plain file-backed blobs (e.g. a fully-fetched clip) work as expected.
   ====================================================================== */

function scanMedia() {
  const items = [];
  const add = (type, url) => {
    if (!url || url.startsWith('data:')) return;
    items.push({ type, url });
  };

  document.querySelectorAll('video').forEach((v) => {
    add('video', v.currentSrc || v.getAttribute('src'));
    v.querySelectorAll('source[src]').forEach((s) => add('video', s.src));
  });

  document.querySelectorAll('audio').forEach((a) => {
    add('audio', a.currentSrc || a.getAttribute('src'));
    a.querySelectorAll('source[src]').forEach((s) => add('audio', s.src));
  });

  document.querySelectorAll('img').forEach((img) => {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    add('image', lazy || img.currentSrc || img.getAttribute('src'));
  });

  const seen = new Set();
  return items.filter((i) => {
    if (!i.url || seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

function downloadBlobUrl(url, filename) {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}

/* ======================================================================
   Messages from the popup
   ====================================================================== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'SET_BLOCKER_SETTINGS':
      blockerSettings = { ...DEFAULT_BLOCKER, ...message.settings };
      runBlockerPass();
      sendResponse({ ok: true });
      break;

    case 'GET_BLOCKER_STATUS':
      sendResponse({ counts: { ...collapsedCounts } });
      break;

    case 'SET_SPEED_CONTROLLER':
      speedEnabled = !!message.enabled;
      if (speedEnabled) enhanceAllVideos();
      else disableAllOverlays();
      sendResponse({ ok: true });
      break;

    case 'SCAN_MEDIA':
      sendResponse({ items: scanMedia() });
      break;

    case 'DOWNLOAD_BLOB':
      sendResponse({ ok: downloadBlobUrl(message.url, message.filename) });
      break;

    default:
      return false;
  }
  return false;
});
