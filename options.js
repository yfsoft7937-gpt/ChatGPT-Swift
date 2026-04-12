const DEFAULTS = {
  enabled: true,
  minMessagesForVirtualization: 12,
  overscanMessages: 3,
  keepRecentMessages: 4,
  freezeAfterInputMs: 800,
  foldCodeBlocks: true,
  foldCodeLineCount: 100,
  codePreviewLines: 32,
  debugOverlay: false,
  aggressiveMode: false,
  contentVisibilityOnly: false,
  autoRestoreNearViewport: true,
  restoreAbovePx: 320,
  restoreBelowPx: 760,
  virtualizeAbovePx: 1400,
  virtualizeBelowPx: 1800,
  restoreBatchPerFrame: 2,
  autoRestorePinMs: 1600
};

const keys = Object.keys(DEFAULTS);

const applyValues = (settings) => {
  for (const key of keys) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = Boolean(settings[key]);
    } else {
      el.value = settings[key];
    }
  }
};

const readValues = () => {
  const payload = {};
  for (const key of keys) {
    const el = document.getElementById(key);
    if (!el) continue;
    payload[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  return payload;
};

const load = async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  applyValues(settings);
};

const save = async () => {
  await chrome.storage.sync.set(readValues());
};

const reset = async () => {
  await chrome.storage.sync.set(DEFAULTS);
  applyValues(DEFAULTS);
};

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
load();
