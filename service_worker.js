const DEFAULT_SETTINGS = {
  enabled: true,
  minMessagesForVirtualization: 30,
  overscanMessages: 8,
  keepRecentMessages: 10,
  freezeAfterInputMs: 1600,
  foldCodeBlocks: true,
  foldCodeLineCount: 120,
  codePreviewLines: 40,
  debugOverlay: false,
  aggressiveMode: false,
  contentVisibilityOnly: false
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  await chrome.storage.sync.set(merged);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'getDefaultSettings') {
    sendResponse(DEFAULT_SETTINGS);
    return true;
  }
  return false;
});
