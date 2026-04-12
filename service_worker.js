const DEFAULT_SETTINGS = {
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
