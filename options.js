const DEFAULTS = {
  enabled: true,
  minMessagesForVirtualization: 12,
  overscanMessages: 2,
  keepRecentMessages: 3,
  freezeAfterInputMs: 700,
  foldCodeBlocks: true,
  foldCodeLineCount: 120,
  codePreviewLines: 40,
  debugOverlay: false,
  aggressiveMode: false,
  contentVisibilityOnly: false
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
