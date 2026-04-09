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

const fields = [
  'enabled',
  'contentVisibilityOnly',
  'aggressiveMode',
  'debugOverlay',
  'minMessagesForVirtualization',
  'overscanMessages'
];

const load = async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];
  }
};

const save = async () => {
  const payload = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    payload[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  await chrome.storage.sync.set(payload);
  window.close();
};

document.getElementById('save').addEventListener('click', save);
load();
