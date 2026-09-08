'use strict';

/* ======================================================================
   Small helpers
   ====================================================================== */

const $ = (id) => document.getElementById(id);

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

// Wrap chrome.tabs.sendMessage so a missing content script (chrome:// pages,
// the Web Store, a page that hasn't finished loading) never throws — it just
// resolves to null and callers show an empty state instead of crashing.
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    if (!tabId) return resolve(null);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ======================================================================
   Tabs
   ====================================================================== */

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach((tabEl) => {
    tabEl.addEventListener('click', () => {
      const target = tabEl.dataset.tab;

      tabs.forEach((t) => {
        const active = t === tabEl;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      });

      panels.forEach((p) => {
        const active = p.dataset.panel === target;
        p.classList.toggle('is-active', active);
        p.hidden = !active;
      });
    });
  });
}

/* ======================================================================
   Header host chip
   ====================================================================== */

async function initHostChip() {
  const tab = await getActiveTab();
  const chip = $('hostChip');
  if (!tab || !tab.url) {
    chip.textContent = 'no active tab';
    return;
  }
  try {
    const url = new URL(tab.url);
    chip.textContent = url.protocol.startsWith('http') ? url.hostname : url.protocol.replace(':', '');
  } catch {
    chip.textContent = '—';
  }
}

/* ======================================================================
   Clock
   ====================================================================== */

const CLOCK_FORMAT_KEY = 'mono_is24h';

function formatClock(date, is24h) {
  let h = date.getHours();
  const m = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());

  if (is24h) {
    return `${pad2(h)}:${m}:${s}`;
  }
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m}:${s} ${suffix}`;
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function initClock() {
  const readout = $('clockReadout');
  const dateEl = $('clockDate');
  const formatToggle = $('formatToggle');

  let is24h = true;
  let lastSecond = -1;

  chrome.storage.sync.get([CLOCK_FORMAT_KEY], (res) => {
    is24h = res[CLOCK_FORMAT_KEY] !== false; // default true
    formatToggle.textContent = is24h ? '24h' : '12h';
    formatToggle.setAttribute('aria-pressed', String(!is24h));
  });

  formatToggle.addEventListener('click', () => {
    is24h = !is24h;
    formatToggle.textContent = is24h ? '24h' : '12h';
    formatToggle.setAttribute('aria-pressed', String(!is24h));
    chrome.storage.sync.set({ [CLOCK_FORMAT_KEY]: is24h });
    lastSecond = -1; // force immediate repaint
  });

  function tick() {
    const now = new Date();
    if (now.getSeconds() !== lastSecond) {
      lastSecond = now.getSeconds();
      readout.textContent = formatClock(now, is24h);
      dateEl.textContent = formatDate(now);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ======================================================================
   Timer — state lives in chrome.storage.local so it survives the popup
   closing; chrome.alarms (in the service worker) fires the completion
   notification even while the popup isn't open at all.
   ====================================================================== */

const TIMER_KEY = 'mono_timer_state';
// shape: { running: bool, endTime: number|null, remainingMs: number, durationMs: number }

function initTimer() {
  const minInput = $('timerMin');
  const secInput = $('timerSec');
  const readout = $('timerReadout');
  const progress = $('timerProgress');
  const block = document.querySelector('.timer-block');
  const startBtn = $('timerStart');
  const pauseBtn = $('timerPause');
  const resetBtn = $('timerReset');
  const hint = $('timerHint');

  let uiInterval = null;

  function paint(state) {
    const remaining = Math.max(0, state.remainingMs);
    const mm = Math.floor(remaining / 60000);
    const ss = Math.floor((remaining % 60000) / 1000);
    readout.textContent = `${pad2(mm)}:${pad2(ss)}`;

    const pct = state.durationMs > 0
      ? Math.min(100, ((state.durationMs - remaining) / state.durationMs) * 100)
      : 0;
    progress.style.width = `${pct}%`;

    block.classList.toggle('is-running', state.running);
    startBtn.disabled = state.running;
    pauseBtn.disabled = !state.running;
    startBtn.textContent = !state.running && state.remainingMs > 0 && state.remainingMs < state.durationMs
      ? 'Resume'
      : 'Start';

    hint.textContent = state.running
      ? "Runs in the background — you'll get a notification when it ends."
      : 'Set a duration and press Start.';
  }

  function stopUiLoop() {
    if (uiInterval) {
      clearInterval(uiInterval);
      uiInterval = null;
    }
  }

  function startUiLoop() {
    stopUiLoop();
    uiInterval = setInterval(async () => {
      const state = await loadState();
      if (!state.running) {
        stopUiLoop();
        return;
      }
      const remaining = state.endTime - Date.now();
      if (remaining <= 0) {
        stopUiLoop();
        const finished = { running: false, endTime: null, remainingMs: 0, durationMs: state.durationMs };
        await saveState(finished);
        paint(finished);
        return;
      }
      paint({ ...state, remainingMs: remaining });
    }, 250);
  }

  function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([TIMER_KEY], (res) => {
        resolve(res[TIMER_KEY] || { running: false, endTime: null, remainingMs: 0, durationMs: 0 });
      });
    });
  }

  function saveState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [TIMER_KEY]: state }, resolve);
    });
  }

  startBtn.addEventListener('click', async () => {
    let state = await loadState();

    if (!state.running && state.remainingMs > 0 && state.remainingMs < state.durationMs) {
      // resume a paused timer
      state.endTime = Date.now() + state.remainingMs;
      state.running = true;
    } else {
      // fresh start from the inputs
      const min = Math.max(0, Math.min(999, parseInt(minInput.value, 10) || 0));
      const sec = Math.max(0, Math.min(59, parseInt(secInput.value, 10) || 0));
      const totalMs = (min * 60 + sec) * 1000;
      if (totalMs <= 0) return;
      state = {
        running: true,
        endTime: Date.now() + totalMs,
        remainingMs: totalMs,
        durationMs: totalMs,
      };
    }

    await saveState(state);
    await sendToBackground({ type: 'TIMER_SCHEDULE', endTime: state.endTime });
    paint(state);
    startUiLoop();
  });

  pauseBtn.addEventListener('click', async () => {
    const state = await loadState();
    if (!state.running) return;
    const remaining = Math.max(0, state.endTime - Date.now());
    const paused = { ...state, running: false, endTime: null, remainingMs: remaining };
    await saveState(paused);
    await sendToBackground({ type: 'TIMER_CANCEL' });
    stopUiLoop();
    paint(paused);
  });

  resetBtn.addEventListener('click', async () => {
    const cleared = { running: false, endTime: null, remainingMs: 0, durationMs: 0 };
    await saveState(cleared);
    await sendToBackground({ type: 'TIMER_CANCEL' });
    stopUiLoop();
    paint(cleared);
    progress.style.width = '0%';
    readout.textContent = '00:00';
  });

  // Resume UI on popup open if a timer is already running or paused.
  (async () => {
    const state = await loadState();
    if (state.durationMs > 0) {
      paint(state.running ? { ...state, remainingMs: Math.max(0, state.endTime - Date.now()) } : state);
      if (state.running) startUiLoop();
    }
  })();
}

/* ======================================================================
   Media tab: speed-controller toggle + page media scan/download
   ====================================================================== */

const SPEED_KEY = 'mono_speed_enabled';

function initSpeedToggle() {
  const toggle = $('speedToggle');

  chrome.storage.sync.get([SPEED_KEY], (res) => {
    const enabled = res[SPEED_KEY] !== false; // default on
    toggle.setAttribute('aria-checked', String(enabled));
  });

  toggle.addEventListener('click', async () => {
    const enabled = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(enabled));
    chrome.storage.sync.set({ [SPEED_KEY]: enabled });

    const tab = await getActiveTab();
    if (tab) sendToTab(tab.id, { type: 'SET_SPEED_CONTROLLER', enabled });
  });
}

function mediaTypeLabel(type) {
  if (type === 'video') return 'VIDEO';
  if (type === 'audio') return 'AUDIO';
  if (type === 'image') return 'IMAGE';
  return type.toUpperCase();
}

function filenameFor(url, type) {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() || 'download';
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
    const ext = type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'jpg';
    return `${base}.${ext}`;
  } catch {
    const ext = type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'jpg';
    return `monochrome-download.${ext}`;
  }
}

function renderMediaList(items) {
  const list = $('mediaList');
  list.innerHTML = '';

  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'media-empty';
    li.id = 'mediaEmpty';
    li.textContent = 'No downloadable media found on this page.';
    list.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'media-item';

    const type = document.createElement('span');
    type.className = 'media-type';
    type.textContent = mediaTypeLabel(item.type);

    const url = document.createElement('span');
    url.className = 'media-url';
    url.textContent = item.url;
    url.title = item.url;

    const btn = document.createElement('button');
    btn.className = 'media-download';
    btn.textContent = 'Download';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const filename = filenameFor(item.url, item.type);

      let res;
      if (item.url.startsWith('blob:')) {
        // blob: URLs only exist inside the page that created them — the
        // content script has to trigger this download itself.
        const tab = await getActiveTab();
        res = await sendToTab(tab ? tab.id : null, { type: 'DOWNLOAD_BLOB', url: item.url, filename });
      } else {
        res = await sendToBackground({ type: 'DOWNLOAD_MEDIA', url: item.url, filename });
      }

      btn.textContent = res && res.ok ? 'Saved' : 'Failed';
      if (!(res && res.ok)) btn.disabled = false;
    });

    li.append(type, url, btn);
    list.appendChild(li);
  });
}

function initMediaScan() {
  const scanBtn = $('scanBtn');

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';

    const tab = await getActiveTab();
    const [domResult, networkResult] = await Promise.all([
      sendToTab(tab ? tab.id : null, { type: 'SCAN_MEDIA' }),
      tab ? sendToBackground({ type: 'GET_NETWORK_MEDIA', tabId: tab.id }) : Promise.resolve(null),
    ]);

    const domItems = (domResult && domResult.items) || [];
    const netItems = (networkResult && networkResult.items) || [];

    // merge + de-dupe by URL
    const seen = new Set();
    const merged = [];
    [...domItems, ...netItems].forEach((item) => {
      if (!item || !item.url || seen.has(item.url)) return;
      seen.add(item.url);
      merged.push(item);
    });

    renderMediaList(merged);
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan page';
  });
}

/* ======================================================================
   Blocker tab
   ====================================================================== */

const BLOCKER_KEY = 'mono_blocker_settings';
const DEFAULT_BLOCKER = { master: true, youtube: true, instagram: true, tiktok: true };

function initBlocker() {
  const master = $('blockerMaster');
  const rows = {
    youtube: $('toggleYoutube'),
    instagram: $('toggleInstagram'),
    tiktok: $('toggleTiktok'),
  };
  const counts = {
    youtube: $('countYoutube'),
    instagram: $('countInstagram'),
    tiktok: $('countTiktok'),
  };

  async function pushSettings(settings) {
    chrome.storage.sync.set({ [BLOCKER_KEY]: settings });
    const tab = await getActiveTab();
    if (tab) sendToTab(tab.id, { type: 'SET_BLOCKER_SETTINGS', settings });
  }

  function paint(settings) {
    master.setAttribute('aria-checked', String(settings.master));
    Object.keys(rows).forEach((key) => {
      rows[key].setAttribute('aria-checked', String(settings[key]));
      rows[key].disabled = !settings.master;
    });
  }

  chrome.storage.sync.get([BLOCKER_KEY], async (res) => {
    const settings = { ...DEFAULT_BLOCKER, ...(res[BLOCKER_KEY] || {}) };
    paint(settings);

    // pull live counts from the content script for the active tab
    const tab = await getActiveTab();
    const status = await sendToTab(tab ? tab.id : null, { type: 'GET_BLOCKER_STATUS' });
    if (status && status.counts) {
      counts.youtube.textContent = `${status.counts.youtube || 0} hidden`;
      counts.instagram.textContent = `${status.counts.instagram || 0} hidden`;
      counts.tiktok.textContent = `${status.counts.tiktok || 0} hidden`;
    }
  });

  master.addEventListener('click', async () => {
    const settings = { ...DEFAULT_BLOCKER, ...((await new Promise((r) =>
      chrome.storage.sync.get([BLOCKER_KEY], (res) => r(res[BLOCKER_KEY]))
    )) || {}) };
    settings.master = master.getAttribute('aria-checked') !== 'true';
    paint(settings);
    pushSettings(settings);
  });

  Object.keys(rows).forEach((key) => {
    rows[key].addEventListener('click', async () => {
      const settings = { ...DEFAULT_BLOCKER, ...((await new Promise((r) =>
        chrome.storage.sync.get([BLOCKER_KEY], (res) => r(res[BLOCKER_KEY]))
      )) || {}) };
      settings[key] = rows[key].getAttribute('aria-checked') !== 'true';
      paint(settings);
      pushSettings(settings);
    });
  });
}

/* ======================================================================
   Boot
   ====================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initHostChip();
  initClock();
  initTimer();
  initSpeedToggle();
  initMediaScan();
  initBlocker();
});
