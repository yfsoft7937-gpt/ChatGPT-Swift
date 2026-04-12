(() => {
  'use strict';

  const FALLBACK_SETTINGS = {
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

  const MESSAGE_SELECTOR = 'article, [data-message-author-role], [data-testid^="conversation-turn-"]';
  const MAX_PLACEHOLDER_HEIGHT = 3200;
  const MIN_PLACEHOLDER_HEIGHT = 60;
  const DEFAULT_MEASURED_HEIGHT = 120;

  const state = {
    settings: { ...FALLBACK_SETTINGS },
    url: location.href,
    scrollRoot: null,
    transcriptRoot: null,
    observerRoot: null,
    messages: [],
    metaById: new Map(),
    lastInputTs: 0,
    booted: false,
    editableGuardsInstalled: false,
    rescanTimer: null,
    delayedUpdateTimer: null,
    scrollTicking: false,
    observer: null,
    resizeObserver: null,
    placeholderObserver: null,
    placeholderObserverConfigKey: '',
    debugEl: null,
    observerSuppressCount: 0,
    ignoreObserverUntil: 0,
    restoreQueue: [],
    restoreQueuedIds: new Set(),
    restoreRaf: 0,
    installedScrollTarget: null,
    routeHooksInstalled: false,
    routeTimer: null,
    pendingCodeRoots: new Set(),
    codeProcessingScheduled: false,
    stats: {
      live: 0,
      virtual: 0,
      messageCount: 0,
      updates: 0,
      scans: 0,
      autoRestores: 0,
      queuedRestores: 0,
      lastReason: 'boot',
      detector: 'none',
      lastUpdateMs: 0,
      avgUpdateMs: 0
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const log = (...args) => {
    if (state.settings.debugOverlay) {
      console.debug('[CGWD]', ...args);
    }
  };

  const schedule = (fn, timeout = 400) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(fn, { timeout });
    } else {
      setTimeout(fn, 50);
    }
  };

  const isEditableTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('textarea, input, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
    );
  };

  const getSettings = async () => {
    try {
      const stored = await chrome.storage.sync.get(FALLBACK_SETTINGS);
      return { ...FALLBACK_SETTINGS, ...stored };
    } catch (_error) {
      return { ...FALLBACK_SETTINGS };
    }
  };

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  };

  const isScrollable = (el) => {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
    return el.scrollHeight > el.clientHeight * 1.1;
  };

  const hasHeavyContent = (el) => Boolean(el.querySelector('pre, table, img, svg, canvas, video, audio, blockquote, code'));
  const textLength = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().length;

  const isLikelyUtilityRegion = (el) => {
    if (!(el instanceof Element)) return true;
    if (el.classList.contains('cgwd-placeholder')) return false;
    if (el.matches('nav, header, footer, aside, form, dialog, menu, button')) return true;
    if (el.closest('nav, header, footer, aside, dialog')) return true;
    if (el.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]')) return true;
    return false;
  };

  const childScore = (el) => {
    if (!(el instanceof HTMLElement)) return 0;
    if (!visible(el)) return 0;
    if (isLikelyUtilityRegion(el)) return 0;

    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const textLen = textLength(el);

    if (width < 220 || height < 24) return 0;

    let score = 0;
    if (textLen > 20) score += 1;
    if (textLen > 80) score += 2;
    if (textLen > 180) score += 2;
    if (height > 60) score += 1;
    if (height > 140) score += 1;
    if (hasHeavyContent(el)) score += 2;
    if (el.querySelector('button, a')) score += 0.5;

    return score;
  };

  const commonAncestor = (nodes) => {
    if (!nodes.length) return null;
    const paths = nodes.map((node) => {
      const chain = [];
      let current = node.parentElement;
      while (current && current !== document.body && current !== document.documentElement) {
        chain.push(current);
        current = current.parentElement;
      }
      return chain.reverse();
    });

    if (!paths.length || !paths[0].length) return document.querySelector('main') || document.body;

    let ancestor = null;
    for (let i = 0; i < paths[0].length; i += 1) {
      const candidate = paths[0][i];
      const shared = paths.every((path) => path[i] === candidate);
      if (!shared) break;
      ancestor = candidate;
    }
    return ancestor || document.querySelector('main') || document.body;
  };

  const findScrollRoot = (messageNodes = []) => {
    const main = document.querySelector('main') || document.body;

    if (messageNodes.length) {
      const candidates = new Set();
      for (const node of messageNodes) {
        let current = node.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 8) {
          if (isScrollable(current)) candidates.add(current);
          current = current.parentElement;
          depth += 1;
        }
      }
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        const score = Math.max(rect.width, 1) * Math.max(rect.height, 1) * (el.scrollHeight / Math.max(el.clientHeight, 1));
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      if (best) return best;
    }

    const all = [main, ...main.querySelectorAll('*')];
    let best = null;
    let bestScore = 0;

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (!isScrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      const score = Math.max(rect.width, 1) * Math.max(rect.height, 1) * (el.scrollHeight / Math.max(el.clientHeight, 1));
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best || document.scrollingElement || document.documentElement;
  };

  const findMessageNodesBySelectors = () => {
    const main = document.querySelector('main') || document.body;
    const selectorGroups = [
      { selector: 'main article', detector: 'main-article' },
      { selector: '[data-message-author-role]', detector: 'author-role' },
      { selector: '[data-testid^="conversation-turn-"]', detector: 'conversation-turn' },
      { selector: 'article[data-testid], article', detector: 'article-fallback' }
    ];

    for (const group of selectorGroups) {
      const nodes = Array.from(document.querySelectorAll(group.selector))
        .filter((node) => node instanceof HTMLElement)
        .filter((node) => main.contains(node))
        .filter((node) => visible(node))
        .filter((node) => !node.classList.contains('cgwd-placeholder'))
        .filter((node) => childScore(node) >= 1.5 || node.matches('article, [data-message-author-role], [data-testid^="conversation-turn-"]'));

      if (nodes.length >= 2) {
        return { nodes, detector: group.detector };
      }
    }

    return { nodes: [], detector: 'none' };
  };

  const detectTranscriptRootHeuristic = (scrollRoot) => {
    const main = document.querySelector('main') || document.body;
    const candidateParents = new Map();
    const descendants = main.querySelectorAll('div, article, section, li');

    for (const el of descendants) {
      if (!(el instanceof HTMLElement)) continue;
      const parent = el.parentElement;
      if (!(parent instanceof HTMLElement)) continue;
      if (!parent.isConnected) continue;
      if (scrollRoot && !scrollRoot.contains(parent) && parent !== scrollRoot && parent !== main) continue;
      const score = childScore(el);
      if (score < 2) continue;
      const entry = candidateParents.get(parent) || { score: 0, count: 0, totalHeight: 0 };
      entry.score += score;
      entry.count += 1;
      entry.totalHeight += el.getBoundingClientRect().height;
      candidateParents.set(parent, entry);
    }

    let bestParent = null;
    let bestScore = 0;

    for (const [parent, entry] of candidateParents.entries()) {
      if (entry.count < 4) continue;
      const density = entry.score + entry.count * 2 + entry.totalHeight / 500;
      if (density > bestScore) {
        bestScore = density;
        bestParent = parent;
      }
    }

    return bestParent;
  };

  const findMessageNodesHeuristic = (root) => {
    if (!(root instanceof HTMLElement)) return [];
    const directChildren = Array.from(root.children)
      .filter((child) => child instanceof HTMLElement)
      .filter((child) => childScore(child) >= 2);
    if (directChildren.length >= 2) return directChildren;

    return Array.from(root.querySelectorAll(':scope > div, :scope > section, :scope > article, :scope > li'))
      .filter((child) => child instanceof HTMLElement)
      .filter((child) => childScore(child) >= 2);
  };

  const withObserverSuppressed = (fn) => {
    state.observerSuppressCount += 1;
    try {
      return fn();
    } finally {
      state.ignoreObserverUntil = Math.max(state.ignoreObserverUntil, performance.now() + 120);
      setTimeout(() => {
        state.observerSuppressCount = Math.max(0, state.observerSuppressCount - 1);
      }, 0);
    }
  };

  const compareDomOrder = (a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  };

  const summarizeMessage = (node) => {
    if (!(node instanceof HTMLElement)) {
      return { role: 'History', preview: 'Off-screen message' };
    }
    const role = node.getAttribute('data-message-author-role')
      || node.dataset?.messageAuthorRole
      || (node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role'))
      || 'history';
    const preview = (node.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
    return {
      role: role.charAt(0).toUpperCase() + role.slice(1),
      preview: preview || 'Off-screen message'
    };
  };

  const refreshPlaceholderText = (meta) => {
    if (!meta?.placeholder || !(meta.placeholder instanceof HTMLButtonElement)) return;
    const hint = meta.placeholder.querySelector('.cgwd-placeholder-hint');
    if (!hint) return;
    const queued = state.restoreQueuedIds.has(meta.id);
    if (queued) {
      meta.placeholder.dataset.cgwdRestoring = '1';
      hint.textContent = 'Restoring…';
      return;
    }
    delete meta.placeholder.dataset.cgwdRestoring;
    hint.textContent = state.settings.autoRestoreNearViewport ? 'Auto-restores near viewport · Click to restore now' : 'Click to restore';
  };

  const createMeta = (node, index, previous = null) => {
    const id = node.dataset.cgwdId || previous?.id || `cgwd-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    node.dataset.cgwdId = id;
    node.classList.add('cgwd-message');
    return {
      id,
      node,
      placeholder: previous?.placeholder || null,
      measuredHeight: previous?.measuredHeight || 0,
      state: 'live',
      index,
      manualPinUntil: previous?.manualPinUntil || 0,
      optimizedMode: previous?.optimizedMode || 'none'
    };
  };

  const getPrimaryNode = (meta) => (meta.state === 'live' ? meta.node : meta.placeholder);

  const getRectForMessage = (meta) => {
    const node = getPrimaryNode(meta);
    if (!(node instanceof Element)) {
      return { top: Infinity, bottom: Infinity, height: 0 };
    }
    return node.getBoundingClientRect();
  };

  const measureHeight = (meta) => {
    const target = getPrimaryNode(meta);
    if (!(target instanceof HTMLElement)) return meta.measuredHeight || DEFAULT_MEASURED_HEIGHT;
    const rect = target.getBoundingClientRect();
    const measured = Math.max(
      rect.height || 0,
      target.offsetHeight || 0,
      Math.min(target.scrollHeight || 0, MAX_PLACEHOLDER_HEIGHT),
      MIN_PLACEHOLDER_HEIGHT
    );
    meta.measuredHeight = clamp(measured, MIN_PLACEHOLDER_HEIGHT, MAX_PLACEHOLDER_HEIGHT);
    return meta.measuredHeight;
  };

  const clearSafeOptimization = (meta) => {
    if (!(meta.node instanceof HTMLElement)) return;
    if (meta.optimizedMode !== 'content-visibility') return;
    meta.node.style.contentVisibility = '';
    meta.node.style.contain = '';
    meta.node.style.containIntrinsicSize = '';
    meta.node.style.willChange = '';
    meta.optimizedMode = 'none';
  };

  const applySafeOptimization = (meta) => {
    if (!(meta.node instanceof HTMLElement)) return;
    const height = measureHeight(meta);
    meta.node.style.contentVisibility = 'auto';
    meta.node.style.contain = 'layout paint style';
    meta.node.style.containIntrinsicSize = `${Math.round(height)}px`;
    meta.node.style.willChange = 'contents';
    meta.optimizedMode = 'content-visibility';
  };

  const ensureResizeObserver = () => {
    if (state.resizeObserver) return;
    state.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLElement)) continue;
        const id = target.dataset.cgwdId;
        if (!id) continue;
        const meta = state.metaById.get(id);
        if (!meta) continue;
        const height = clamp(entry.contentRect.height || target.offsetHeight || meta.measuredHeight || DEFAULT_MEASURED_HEIGHT, MIN_PLACEHOLDER_HEIGHT, MAX_PLACEHOLDER_HEIGHT);
        meta.measuredHeight = height;
        if (meta.placeholder instanceof HTMLElement) {
          meta.placeholder.style.height = `${Math.round(height)}px`;
        }
        if (meta.optimizedMode === 'content-visibility') {
          meta.node.style.containIntrinsicSize = `${Math.round(height)}px`;
        }
      }
    });
  };

  const syncResizeObserver = () => {
    ensureResizeObserver();
    state.resizeObserver.disconnect();
    for (const meta of state.messages) {
      if (meta.state === 'live' && meta.node instanceof HTMLElement && meta.node.isConnected) {
        state.resizeObserver.observe(meta.node);
      }
    }
  };

  const getPlaceholderObserverRoot = () => {
    if (
      state.scrollRoot === document.scrollingElement ||
      state.scrollRoot === document.documentElement ||
      state.scrollRoot === document.body ||
      state.scrollRoot === window ||
      !state.scrollRoot
    ) {
      return null;
    }
    return state.scrollRoot;
  };

  const getPlaceholderObserverConfigKey = () => {
    const root = getPlaceholderObserverRoot();
    const restoreAbovePx = Math.max(120, Number(state.settings.restoreAbovePx) || 0);
    const restoreBelowPx = Math.max(180, Number(state.settings.restoreBelowPx) || 0);
    return `${root ? 'element' : 'window'}:${restoreAbovePx}:${restoreBelowPx}`;
  };

  const ensurePlaceholderObserver = () => {
    if (!state.settings.autoRestoreNearViewport) {
      if (state.placeholderObserver) {
        state.placeholderObserver.disconnect();
        state.placeholderObserver = null;
        state.placeholderObserverConfigKey = '';
      }
      return null;
    }

    const nextKey = getPlaceholderObserverConfigKey();
    if (state.placeholderObserver && state.placeholderObserverConfigKey === nextKey) {
      return state.placeholderObserver;
    }

    if (state.placeholderObserver) {
      state.placeholderObserver.disconnect();
    }

    const restoreAbovePx = Math.max(120, Number(state.settings.restoreAbovePx) || 0);
    const restoreBelowPx = Math.max(180, Number(state.settings.restoreBelowPx) || 0);
    state.placeholderObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLElement)) continue;
        const id = target.dataset.cgwdPlaceholderFor;
        if (!id) continue;
        const meta = state.metaById.get(id);
        if (!meta || meta.state !== 'virtual') continue;
        if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
        queueRestore(meta, true);
      }
    }, {
      root: getPlaceholderObserverRoot(),
      rootMargin: `${restoreAbovePx}px 0px ${restoreBelowPx}px 0px`,
      threshold: 0.01
    });
    state.placeholderObserverConfigKey = nextKey;
    return state.placeholderObserver;
  };

  const syncPlaceholderObserver = () => {
    const observer = ensurePlaceholderObserver();
    if (!observer) return;
    observer.disconnect();
    for (const meta of state.messages) {
      if (meta.state === 'virtual' && meta.placeholder instanceof HTMLElement && meta.placeholder.isConnected) {
        observer.observe(meta.placeholder);
      }
    }
  };

  const observePlaceholder = (meta) => {
    if (!meta?.placeholder || !(meta.placeholder instanceof HTMLElement)) return;
    const observer = ensurePlaceholderObserver();
    if (!observer) return;
    observer.observe(meta.placeholder);
  };

  const unobservePlaceholder = (meta) => {
    if (!state.placeholderObserver || !meta?.placeholder || !(meta.placeholder instanceof HTMLElement)) return;
    state.placeholderObserver.unobserve(meta.placeholder);
  };

  const getOrCreatePlaceholder = (meta) => {
    if (meta.placeholder instanceof HTMLButtonElement) {
      const height = measureHeight(meta);
      meta.placeholder.style.height = `${Math.round(height)}px`;
      const summary = summarizeMessage(meta.node);
      meta.placeholder.dataset.cgwdPlaceholderFor = meta.id;
      const label = meta.placeholder.querySelector('.cgwd-placeholder-label');
      const summaryEl = meta.placeholder.querySelector('.cgwd-placeholder-summary');
      const hint = meta.placeholder.querySelector('.cgwd-placeholder-hint');
      if (label) label.textContent = `${summary.role} message virtualized`;
      if (summaryEl) summaryEl.textContent = summary.preview;
      if (hint) hint.textContent = state.settings.autoRestoreNearViewport ? 'Auto-restores near viewport · Click to restore now' : 'Click to restore';
      refreshPlaceholderText(meta);
      return meta.placeholder;
    }

    const placeholder = document.createElement('button');
    placeholder.type = 'button';
    placeholder.className = 'cgwd-placeholder';
    placeholder.dataset.cgwdPlaceholderFor = meta.id;
    const summary = summarizeMessage(meta.node);
    const height = measureHeight(meta);
    placeholder.style.height = `${Math.round(height)}px`;
    placeholder.innerHTML = `
      <span class="cgwd-placeholder-copy">
        <span class="cgwd-placeholder-label">${summary.role} message virtualized</span>
        <span class="cgwd-placeholder-summary">${summary.preview}</span>
      </span>
      <span class="cgwd-placeholder-hint">${state.settings.autoRestoreNearViewport ? 'Auto-restores near viewport · Click to restore now' : 'Click to restore'}</span>
    `;
    placeholder.addEventListener('click', () => {
      meta.manualPinUntil = performance.now() + Math.max(2000, state.settings.autoRestorePinMs);
      dequeueRestore(meta);
      ensureLive(meta, 'manual-restore');
      requestUpdate('manual-restore');
    });
    meta.placeholder = placeholder;
    refreshPlaceholderText(meta);
    return placeholder;
  };

  const ensureVirtual = (meta) => {
    if (meta.state === 'virtual') return true;
    if (!(meta.node instanceof HTMLElement) || !meta.node.isConnected) return false;
    clearSafeOptimization(meta);
    const placeholder = getOrCreatePlaceholder(meta);
    placeholder.style.height = `${Math.round(measureHeight(meta))}px`;
    withObserverSuppressed(() => {
      meta.node.replaceWith(placeholder);
    });
    if (state.resizeObserver) {
      state.resizeObserver.unobserve(meta.node);
    }
    meta.state = 'virtual';
    observePlaceholder(meta);
    return true;
  };

  const queueCodeProcessing = (root) => {
    if (!(root instanceof HTMLElement) || !root.isConnected) return;
    state.pendingCodeRoots.add(root);
    if (state.codeProcessingScheduled) return;
    state.codeProcessingScheduled = true;
    schedule(() => {
      state.codeProcessingScheduled = false;
      const roots = Array.from(state.pendingCodeRoots);
      state.pendingCodeRoots.clear();
      for (const entry of roots) {
        processCodeBlocksIn(entry);
      }
    }, 300);
  };

  function ensureLive(meta, reason = 'restore') {
    if (meta.state === 'live') {
      clearSafeOptimization(meta);
      queueCodeProcessing(meta.node);
      return true;
    }
    if (!(meta.placeholder instanceof HTMLElement) || !meta.placeholder.isConnected) return false;
    unobservePlaceholder(meta);
    withObserverSuppressed(() => {
      meta.placeholder.replaceWith(meta.node);
    });
    meta.state = 'live';
    clearSafeOptimization(meta);
    ensureResizeObserver();
    state.resizeObserver.observe(meta.node);
    queueCodeProcessing(meta.node);
    if (reason === 'auto-restore') {
      state.stats.autoRestores += 1;
    }
    return true;
  }

  const onEditableEvent = (event) => {
    if (!isEditableTarget(event.target)) return;
    state.lastInputTs = performance.now();
    if (state.delayedUpdateTimer) clearTimeout(state.delayedUpdateTimer);
    state.delayedUpdateTimer = setTimeout(() => {
      requestUpdate('post-input');
    }, state.settings.freezeAfterInputMs + 60);
  };

  const wireEditableGuards = () => {
    if (state.editableGuardsInstalled) return;
    document.addEventListener('keydown', onEditableEvent, true);
    document.addEventListener('beforeinput', onEditableEvent, true);
    document.addEventListener('input', onEditableEvent, true);
    document.addEventListener('compositionstart', onEditableEvent, true);
    document.addEventListener('compositionupdate', onEditableEvent, true);
    state.editableGuardsInstalled = true;
  };

  const processCodeBlocksIn = (root) => {
    if (!state.settings.foldCodeBlocks) return;
    if (!(root instanceof Element)) return;
    const candidates = new Set();
    if (root.matches?.('pre:not([data-cgwd-code-processed])')) {
      candidates.add(root);
    }
    for (const pre of root.querySelectorAll?.('pre:not([data-cgwd-code-processed])') || []) {
      candidates.add(pre);
    }

    for (const pre of candidates) {
      if (!(pre instanceof HTMLElement)) continue;
      pre.dataset.cgwdCodeProcessed = '1';
      const lines = (pre.innerText || '').split('\n').length;
      if (lines < state.settings.foldCodeLineCount) continue;

      withObserverSuppressed(() => {
        const wrap = document.createElement('div');
        wrap.className = 'cgwd-code-wrap cgwd-code-collapsed';
        wrap.dataset.cgwdCodeWrap = '1';
        const previewHeight = clamp(state.settings.codePreviewLines * 22, 240, 720);
        wrap.style.setProperty('--cgwd-code-preview-height', `${previewHeight}px`);
        pre.replaceWith(wrap);
        wrap.appendChild(pre);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'cgwd-code-toggle';
        toggle.textContent = `Expand code (${lines} lines)`;
        toggle.addEventListener('click', () => {
          const collapsed = wrap.classList.toggle('cgwd-code-collapsed');
          toggle.textContent = collapsed ? `Expand code (${lines} lines)` : 'Collapse code';
        });
        wrap.appendChild(toggle);
      });
    }
  };

  const buildDebugOverlay = () => {
    if (!state.settings.debugOverlay) return;
    if (state.debugEl?.isConnected) return;
    const panel = document.createElement('div');
    panel.className = 'cgwd-debug-overlay';
    document.documentElement.appendChild(panel);
    state.debugEl = panel;
    renderDebugOverlay();
  };

  const renderDebugOverlay = () => {
    if (!state.settings.debugOverlay) {
      if (state.debugEl) {
        state.debugEl.remove();
        state.debugEl = null;
      }
      return;
    }
    buildDebugOverlay();
    if (!state.debugEl) return;
    state.debugEl.innerHTML = `
      <div><strong>CGWD</strong> ${state.settings.enabled ? 'enabled' : 'disabled'}</div>
      <div>messages: ${state.stats.messageCount}</div>
      <div>live: ${state.stats.live} / virtual: ${state.stats.virtual}</div>
      <div>updates: ${state.stats.updates} · scans: ${state.stats.scans}</div>
      <div>reason: ${state.stats.lastReason}</div>
      <div>detector: ${state.stats.detector}</div>
      <div>restore: ${state.stats.autoRestores} auto / ${state.stats.queuedRestores} queued</div>
      <div>update: ${state.stats.lastUpdateMs.toFixed(1)}ms (avg ${state.stats.avgUpdateMs.toFixed(1)}ms)</div>
      <div>mode: ${state.settings.contentVisibilityOnly ? 'safe' : (state.settings.aggressiveMode ? 'aggressive' : 'balanced')}</div>
    `;
  };

  const refreshMetaIndex = () => {
    state.metaById = new Map(state.messages.map((meta) => [meta.id, meta]));
  };

  const clearRestoreQueue = () => {
    state.restoreQueue = [];
    state.restoreQueuedIds.clear();
    if (state.restoreRaf) {
      cancelAnimationFrame(state.restoreRaf);
      state.restoreRaf = 0;
    }
  };

  const resetState = () => {
    state.scrollRoot = null;
    state.transcriptRoot = null;
    state.observerRoot = null;
    state.messages = [];
    state.metaById = new Map();
    clearRestoreQueue();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    if (state.placeholderObserver) {
      state.placeholderObserver.disconnect();
      state.placeholderObserver = null;
      state.placeholderObserverConfigKey = '';
    }
    clearTimeout(state.rescanTimer);
    clearTimeout(state.delayedUpdateTimer);
    if (state.debugEl) {
      state.debugEl.remove();
      state.debugEl = null;
    }
    state.pendingCodeRoots.clear();
    state.codeProcessingScheduled = false;
    state.stats = {
      live: 0,
      virtual: 0,
      messageCount: 0,
      updates: 0,
      scans: 0,
      autoRestores: 0,
      queuedRestores: 0,
      lastReason: 'reset',
      detector: 'none',
      lastUpdateMs: 0,
      avgUpdateMs: 0
    };
  };

  const buildOrderedMetas = (liveNodes, root) => {
    const prevById = new Map(state.messages.map((meta) => [meta.id, meta]));
    const placeholders = root instanceof HTMLElement
      ? Array.from(root.querySelectorAll('.cgwd-placeholder[data-cgwd-placeholder-for]'))
      : [];

    const combined = [...liveNodes, ...placeholders]
      .filter((node) => node instanceof HTMLElement)
      .sort(compareDomOrder);

    const next = [];
    const seenIds = new Set();

    for (const node of combined) {
      if (!(node instanceof HTMLElement)) continue;

      if (node.classList.contains('cgwd-placeholder')) {
        const id = node.dataset.cgwdPlaceholderFor;
        if (!id || seenIds.has(id)) continue;
        const prev = prevById.get(id);
        if (!prev) continue;
        prev.placeholder = node;
        prev.state = 'virtual';
        prev.index = next.length;
        next.push(prev);
        seenIds.add(id);
        continue;
      }

      const id = node.dataset.cgwdId || `cgwd-${Date.now().toString(36)}-${next.length}-${Math.random().toString(36).slice(2, 8)}`;
      if (seenIds.has(id)) continue;
      const prev = prevById.get(id) || null;
      const meta = createMeta(node, next.length, prev);
      meta.placeholder = null;
      meta.state = 'live';
      next.push(meta);
      seenIds.add(meta.id);
    }

    return next;
  };

  const scan = () => {
    state.stats.scans += 1;
    const selectorResult = findMessageNodesBySelectors();
    let nodes = selectorResult.nodes;
    let detector = selectorResult.detector;

    if (nodes.length) {
      state.transcriptRoot = commonAncestor(nodes);
      state.observerRoot = state.transcriptRoot || document.querySelector('main') || document.body;
      state.scrollRoot = findScrollRoot(nodes);
    } else {
      const fallbackScrollRoot = findScrollRoot();
      const fallbackTranscriptRoot = detectTranscriptRootHeuristic(fallbackScrollRoot);
      nodes = findMessageNodesHeuristic(fallbackTranscriptRoot);
      detector = nodes.length ? 'heuristic' : 'none';
      state.transcriptRoot = fallbackTranscriptRoot;
      state.observerRoot = fallbackTranscriptRoot || document.querySelector('main') || document.body;
      state.scrollRoot = fallbackScrollRoot;
    }

    const uniqueLiveNodes = [];
    const seen = new Set();
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      uniqueLiveNodes.push(node);
    }

    const root = state.transcriptRoot || state.observerRoot || document.querySelector('main') || document.body;
    state.messages = buildOrderedMetas(uniqueLiveNodes, root);
    refreshMetaIndex();
    state.restoreQueue = state.restoreQueue.filter((entry) => state.metaById.has(entry.id));
    state.restoreQueuedIds = new Set(state.restoreQueue.map((entry) => entry.id));
    syncResizeObserver();
    syncPlaceholderObserver();
    state.stats.messageCount = state.messages.length;
    state.stats.detector = detector;

    for (const meta of state.messages) {
      if (meta.state === 'live') {
        queueCodeProcessing(meta.node);
      }
    }

    if (!state.messages.length) {
      state.stats.lastReason = 'messages-not-found';
      log('No message nodes found');
    }

    renderDebugOverlay();
  };

  const getViewportBounds = () => {
    if (
      state.scrollRoot === document.scrollingElement ||
      state.scrollRoot === document.documentElement ||
      state.scrollRoot === document.body ||
      state.scrollRoot === window ||
      !state.scrollRoot
    ) {
      return { top: 0, bottom: window.innerHeight };
    }
    const rect = state.scrollRoot.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  };

  const getDistanceToViewport = (rect, viewport) => {
    if (rect.bottom < viewport.top) return viewport.top - rect.bottom;
    if (rect.top > viewport.bottom) return rect.top - viewport.bottom;
    return 0;
  };

  const dequeueRestore = (meta) => {
    if (!meta || !state.restoreQueuedIds.has(meta.id)) return;
    state.restoreQueuedIds.delete(meta.id);
    state.restoreQueue = state.restoreQueue.filter((item) => item.id !== meta.id);
    refreshPlaceholderText(meta);
  };

  const flushRestoreQueue = () => {
    state.restoreRaf = 0;
    if (!state.restoreQueue.length) return;

    const viewport = getViewportBounds();
    state.restoreQueue.sort((a, b) => {
      if (Boolean(a.immediate) !== Boolean(b.immediate)) {
        return a.immediate ? -1 : 1;
      }
      const metaA = state.metaById.get(a.id);
      const metaB = state.metaById.get(b.id);
      const distA = metaA ? getDistanceToViewport(getRectForMessage(metaA), viewport) : Infinity;
      const distB = metaB ? getDistanceToViewport(getRectForMessage(metaB), viewport) : Infinity;
      return distA - distB;
    });

    const batchSize = clamp(Number(state.settings.restoreBatchPerFrame) || 2, 1, 8);
    const batch = state.restoreQueue.splice(0, batchSize);
    const now = performance.now();

    for (const entry of batch) {
      state.restoreQueuedIds.delete(entry.id);
      const meta = state.metaById.get(entry.id);
      if (!meta || meta.state !== 'virtual') continue;
      meta.manualPinUntil = now + Math.max(800, state.settings.autoRestorePinMs);
      ensureLive(meta, 'auto-restore');
    }

    state.stats.queuedRestores = state.restoreQueue.length;
    renderDebugOverlay();

    if (state.restoreQueue.length) {
      state.restoreRaf = requestAnimationFrame(flushRestoreQueue);
    }

    requestUpdate('auto-restore');
  };

  const queueRestore = (meta, immediate = false) => {
    if (!state.settings.autoRestoreNearViewport) return;
    if (!meta || meta.state !== 'virtual') return;
    if (state.restoreQueuedIds.has(meta.id)) return;
    state.restoreQueuedIds.add(meta.id);
    state.restoreQueue.push({ id: meta.id, queuedAt: performance.now(), immediate: Boolean(immediate) });
    refreshPlaceholderText(meta);
    state.stats.queuedRestores = state.restoreQueue.length;
    if (immediate && !state.restoreRaf) {
      state.restoreRaf = requestAnimationFrame(flushRestoreQueue);
      return;
    }
    if (!state.restoreRaf) {
      state.restoreRaf = requestAnimationFrame(flushRestoreQueue);
    }
  };

  const requestUpdate = (reason = 'unknown') => {
    if (state.scrollTicking) return;
    state.scrollTicking = true;
    requestAnimationFrame(() => {
      state.scrollTicking = false;
      update(reason);
    });
  };

  const update = (reason = 'unknown') => {
    const startedAt = performance.now();
    state.stats.lastReason = reason;
    state.stats.updates += 1;

    if (!state.settings.enabled) {
      clearRestoreQueue();
      for (const meta of state.messages) {
        dequeueRestore(meta);
        ensureLive(meta, 'disabled');
        clearSafeOptimization(meta);
      }
      state.stats.live = state.messages.length;
      state.stats.virtual = 0;
      state.stats.lastUpdateMs = performance.now() - startedAt;
      state.stats.avgUpdateMs = state.stats.avgUpdateMs === 0
        ? state.stats.lastUpdateMs
        : (state.stats.avgUpdateMs * 0.8) + (state.stats.lastUpdateMs * 0.2);
      renderDebugOverlay();
      return;
    }

    if (!state.settings.autoRestoreNearViewport) {
      clearRestoreQueue();
      if (state.placeholderObserver) {
        state.placeholderObserver.disconnect();
      }
    }

    const ageSinceInput = performance.now() - state.lastInputTs;
    if (ageSinceInput < state.settings.freezeAfterInputMs) {
      state.stats.lastUpdateMs = performance.now() - startedAt;
      state.stats.avgUpdateMs = state.stats.avgUpdateMs === 0
        ? state.stats.lastUpdateMs
        : (state.stats.avgUpdateMs * 0.8) + (state.stats.lastUpdateMs * 0.2);
      renderDebugOverlay();
      return;
    }

    const viewport = getViewportBounds();
    const restoreAbovePx = Math.max(120, Number(state.settings.restoreAbovePx) || 0);
    const restoreBelowPx = Math.max(180, Number(state.settings.restoreBelowPx) || 0);
    const virtualizeAbovePx = Math.max(restoreAbovePx + 300, Number(state.settings.virtualizeAbovePx) || 0);
    const virtualizeBelowPx = Math.max(restoreBelowPx + 300, Number(state.settings.virtualizeBelowPx) || 0);

    const shouldWindow = state.messages.length >= state.settings.minMessagesForVirtualization;
    const shouldVirtualize = shouldWindow && !state.settings.contentVisibilityOnly;
    const recentStart = Math.max(0, state.messages.length - Math.max(1, state.settings.keepRecentMessages));

    let firstInRange = -1;
    let lastInRange = -1;
    const rects = new Array(state.messages.length);

    for (let i = 0; i < state.messages.length; i += 1) {
      const rect = getRectForMessage(state.messages[i]);
      rects[i] = rect;
      if (rect.bottom >= viewport.top - restoreAbovePx && rect.top <= viewport.bottom + restoreBelowPx) {
        if (firstInRange === -1) firstInRange = i;
        lastInRange = i;
      }
    }

    if (firstInRange === -1) {
      const fallbackStart = Math.max(0, state.messages.length - state.settings.keepRecentMessages - 1);
      firstInRange = fallbackStart;
      lastInRange = state.messages.length - 1;
    }

    const overscan = Math.max(1, state.settings.overscanMessages);
    const keepStart = Math.max(0, firstInRange - overscan);
    const keepEnd = Math.min(state.messages.length - 1, lastInRange + overscan);

    let live = 0;
    let virtual = 0;
    const now = performance.now();

    for (let i = 0; i < state.messages.length; i += 1) {
      const meta = state.messages[i];
      const rect = rects[i];
      const pinned = meta.manualPinUntil && now < meta.manualPinUntil;
      const inKeepIndexWindow = i >= keepStart && i <= keepEnd;
      const inRestoreZone = rect.bottom >= viewport.top - restoreAbovePx && rect.top <= viewport.bottom + restoreBelowPx;
      const farOutside = rect.bottom < viewport.top - virtualizeAbovePx || rect.top > viewport.bottom + virtualizeBelowPx;
      const shouldBeLive = pinned || i >= recentStart || inKeepIndexWindow || inRestoreZone;

      if (shouldBeLive) {
        if (meta.state === 'virtual') {
          queueRestore(meta);
          virtual += 1;
        } else {
          ensureLive(meta, 'keep-live');
          clearSafeOptimization(meta);
          live += 1;
        }
        continue;
      }

      if (state.settings.contentVisibilityOnly && shouldWindow) {
        ensureLive(meta, 'safe-mode');
        if (farOutside) {
          applySafeOptimization(meta);
        } else {
          clearSafeOptimization(meta);
        }
        live += 1;
        continue;
      }

      if (shouldVirtualize && farOutside) {
        if (ensureVirtual(meta)) {
          virtual += 1;
        } else {
          ensureLive(meta, 'virtualize-failed');
          live += 1;
        }
        continue;
      }

      if (meta.state === 'live') {
        clearSafeOptimization(meta);
        live += 1;
      } else {
        virtual += 1;
      }
    }

    state.stats.live = live;
    state.stats.virtual = virtual;
    state.stats.queuedRestores = state.restoreQueue.length;
    state.stats.lastUpdateMs = performance.now() - startedAt;
    state.stats.avgUpdateMs = state.stats.avgUpdateMs === 0
      ? state.stats.lastUpdateMs
      : (state.stats.avgUpdateMs * 0.8) + (state.stats.lastUpdateMs * 0.2);
    renderDebugOverlay();
  };

  const isMessageLikeNode = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.classList.contains('cgwd-debug-overlay')) return false;
    if (node.className?.toString().includes('cgwd-')) return false;
    if (node.dataset?.cgwdId || node.dataset?.cgwdPlaceholderFor) return true;
    if (node.matches(MESSAGE_SELECTOR)) return true;
    return Boolean(node.querySelector?.(`${MESSAGE_SELECTOR}, .cgwd-placeholder[data-cgwd-placeholder-for]`));
  };

  const hasCodeOrMedia = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.matches?.('pre, table, img, svg, canvas, video, audio')) return true;
    return Boolean(node.querySelector?.('pre, table, img, svg, canvas, video, audio'));
  };

  const scheduleRescan = (reason, delay = 120) => {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = setTimeout(() => {
      scan();
      requestUpdate(reason);
    }, delay);
  };

  const installObserver = () => {
    const root = state.observerRoot || state.transcriptRoot || document.querySelector('main') || document.body;
    if (!(root instanceof HTMLElement)) return;
    if (state.observer) state.observer.disconnect();

    state.observer = new MutationObserver((mutations) => {
      if (state.observerSuppressCount > 0 || performance.now() < state.ignoreObserverUntil) {
        return;
      }

      let needsRescan = false;
      let needsCodeProcessing = false;

      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;

        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (isMessageLikeNode(node)) {
            needsRescan = true;
            break;
          }
          if (hasCodeOrMedia(node)) {
            needsCodeProcessing = true;
            queueCodeProcessing(node.closest('[data-cgwd-id]') || node);
          }
        }
        if (needsRescan) break;

        for (const node of mutation.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.dataset?.cgwdId || node.dataset?.cgwdPlaceholderFor || isMessageLikeNode(node)) {
            needsRescan = true;
            break;
          }
        }
        if (needsRescan) break;
      }

      if (needsRescan) {
        scheduleRescan('mutation', 120);
      } else if (needsCodeProcessing) {
        requestUpdate('code-media-mutation');
      }
    });

    state.observer.observe(root, {
      childList: true,
      subtree: true
    });
  };

  const scrollHandler = () => requestUpdate('scroll');
  const resizeHandler = () => requestUpdate('resize');

  const installScrollListeners = () => {
    const target = state.scrollRoot === document.scrollingElement ? window : (state.scrollRoot || window);
    if (state.installedScrollTarget === target) return;
    if (state.installedScrollTarget) {
      state.installedScrollTarget.removeEventListener('scroll', scrollHandler);
    }
    state.installedScrollTarget = target;
    state.installedScrollTarget.addEventListener('scroll', scrollHandler, { passive: true });
    window.removeEventListener('resize', resizeHandler);
    window.addEventListener('resize', resizeHandler, { passive: true });
  };

  const handleRouteMaybeChanged = () => {
    if (location.href === state.url) return;
    state.url = location.href;
    state.booted = false;
    resetState();
    boot();
  };

  const installRouteHooks = () => {
    if (state.routeHooksInstalled) return;
    state.routeHooksInstalled = true;

    const wrapHistoryMethod = (name) => {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        setTimeout(handleRouteMaybeChanged, 0);
        return result;
      };
    };

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('popstate', handleRouteMaybeChanged, true);
    window.addEventListener('hashchange', handleRouteMaybeChanged, true);

    if (state.routeTimer) clearInterval(state.routeTimer);
    state.routeTimer = setInterval(handleRouteMaybeChanged, 2500);
  };

  const boot = async () => {
    if (state.booted) return;
    state.booted = true;
    state.settings = await getSettings();
    buildDebugOverlay();
    wireEditableGuards();
    installRouteHooks();
    schedule(() => {
      scan();
      installObserver();
      installScrollListeners();
      requestUpdate('boot');
    });
  };

  boot();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in state.settings)) continue;
      state.settings[key] = value.newValue;
      touched = true;
    }
    if (!touched) return;
    renderDebugOverlay();
    schedule(() => {
      scan();
      installObserver();
      installScrollListeners();
      requestUpdate('settings-changed');
    });
  });
})();
