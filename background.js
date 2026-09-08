'use strict';

const TIMER_ALARM = 'countdownTimer';
const TIMER_KEY = 'mono_timer_state';

/* ======================================================================
   Countdown timer — the popup owns the visible countdown (it's just
   comparing Date.now() to a stored end time, which stays accurate on its
   own); the alarm here exists purely so the completion notification still
   fires when the popup isn't open at all.

   Chrome clamps alarms to roughly a 1-minute floor for packed extensions,
   so a sub-minute timer's *notification* may lag slightly behind the
   popup's own on-screen countdown reaching zero. This is a platform limit,
   not a bug in the timer logic.
   ====================================================================== */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TIMER_ALARM) return;

  chrome.storage.local.set({
    [TIMER_KEY]: { running: false, endTime: null, remainingMs: 0, durationMs: 0 },
  });

  chrome.notifications.create(`mono-timer-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Timer done',
    message: 'Your Monochrome countdown timer has finished.',
    priority: 2,
  });
});

/* ======================================================================
   Downloads
   ====================================================================== */

function handleDownload(message, sendResponse) {
  chrome.downloads.download(
    {
      url: message.url,
      filename: message.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    },
    (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        sendResponse({ ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, downloadId });
    }
  );
}

/* ======================================================================
   Network media tracking
   Complements the DOM scan in content.js: catches video/audio (and larger,
   likely-content images) loaded via network requests the DOM might not
   directly expose — e.g. a lazily-fetched asset that hasn't been wired into
   an <img>/<video> tag yet. Per-tab, capped, and reset on navigation.
   ====================================================================== */

const MAX_ITEMS_PER_TAB = 200;
const MIN_IMAGE_BYTES = 20000; // skip icons/tracking pixels, keep likely content images

const tabMedia = new Map(); // tabId -> Map(url -> {type, url})

function classify(contentType, contentLength) {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('image/')) {
    const len = parseInt(contentLength || '0', 10);
    return len >= MIN_IMAGE_BYTES ? 'image' : null;
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const headers = details.responseHeaders || [];
    let contentType = null;
    let contentLength = null;
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value;
      if (name === 'content-length') contentLength = h.value;
    }

    const type = classify(contentType, contentLength);
    if (!type) return;

    if (!tabMedia.has(details.tabId)) tabMedia.set(details.tabId, new Map());
    const bucket = tabMedia.get(details.tabId);
    if (bucket.size >= MAX_ITEMS_PER_TAB) return;
    if (!bucket.has(details.url)) {
      bucket.set(details.url, { type, url: details.url });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabMedia.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
});

/* ======================================================================
   Message router
   ====================================================================== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'TIMER_SCHEDULE':
      chrome.alarms.create(TIMER_ALARM, { when: message.endTime });
      sendResponse({ ok: true });
      return false;

    case 'TIMER_CANCEL':
      chrome.alarms.clear(TIMER_ALARM);
      sendResponse({ ok: true });
      return false;

    case 'DOWNLOAD_MEDIA':
      handleDownload(message, sendResponse);
      return true; // async

    case 'GET_NETWORK_MEDIA': {
      const bucket = tabMedia.get(message.tabId);
      sendResponse({ items: bucket ? Array.from(bucket.values()) : [] });
      return false;
    }

    default:
      return false;
  }
});
