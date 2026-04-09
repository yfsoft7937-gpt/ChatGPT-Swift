(() => {
  'use strict';

  const FALLBACK_SETTINGS = {
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

  const state = {
    settings: { ...FALLBACK_SETTINGS },
    url: location.href,
    scrollRoot: null,
    transcriptRoot: null,
    observerRoot: null,
    messages: [],
    lastInputTs: 0,
    booted: false,
    editableGuardsInstalled: false,
    rescanTimer: null,
    delayedUpdateTimer: null,
    scrollTicking: false,
    observer: null,
    routeTimer: null,
    debugEl: null,
    observerSuppressCount: 0,
    ignoreObserverUntil: 0,
    stats: {
      live: 0,
      virtual: 0,
      messageCount: 0,
      updates: 0,
      lastReason: 'boot',
      detector: 'none'
    }
  };

  const log = (...args) => {
    if (state.settings.debugOverlay) {
      console.debug('[CGWD]', ...args);
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

  const schedule = (fn) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 50);
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
    const overflowY = style.overflowY;
    if (!/(auto|scroll|overlay)/.test(overflowY)) return false;
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
    const directChildren = Array.from(root.children).filter((child) => child instanceof HTMLElement).filter((child) => childScore(child) >= 2);
    if (directChildren.length >= 2) return directChildren;

    const nested = Array.from(root.querySelectorAll(':scope > div, :scope > section, :scope > article, :scope > li'))
      .filter((child) => child instanceof HTMLElement)
      .filter((child) => childScore(child) >= 2);
    return nested;
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

  const createMeta = (node, index, previous = null) => {
    const id = node.dataset.cgwdId || previous?.id || `cgwd-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    node.dataset.cgwdId = id;
    node.classList.add('cgwd-message');
    return {
      id,
      node,
      placeholder: null,
      measuredHeight: previous?.measuredHeight || 0,
      state: 'live',
      index,
      manualPinUntil: previous?.manualPinUntil || 0
    };
  };

  const getRectForMessage = (meta) => {
    const node = meta.state === 'live' ? meta.node : meta.placeholder;
    if (!(node instanceof Element)) {
      return { top: Infinity, bottom: Infinity, height: 0 };
    }
    return node.getBoundingClientRect();
  };

  const measureHeight = (meta) => {
    const target = meta.state === 'live' ? meta.node : meta.placeholder;
    if (!(target instanceof HTMLElement)) return meta.measuredHeight || 120;
    const rect = target.getBoundingClientRect();
    const measured = Math.max(rect.height || 0, target.offsetHeight || 0, Math.min(target.scrollHeight || 0, 2400), 60);
    meta.measuredHeight = Math.min(measured, 2400);
    return meta.measuredHeight;
  };

  const createPlaceholder = (meta) => {
    const ph = document.createElement('button');
    ph.type = 'button';
    ph.className = 'cgwd-placeholder';
    ph.dataset.cgwdPlaceholderFor = meta.id;
    const height = measureHeight(meta);
    ph.style.height = `${height}px`;
    ph.innerHTML = '<span class="cgwd-placeholder-label">History message virtualized</span><span class="cgwd-placeholder-hint">Click to restore</span>';
    ph.addEventListener('click', () => {
      meta.manualPinUntil = performance.now() + 5000;
      ensureLive(meta);
      requestUpdate('manual-restore');
    });
    return ph;
  };

  const ensureVirtual = (meta) => {
    if (meta.state === 'virtual') return true;
    if (!(meta.node instanceof HTMLElement) || !meta.node.isConnected) return false;
    measureHeight(meta);
    const placeholder = createPlaceholder(meta);
    withObserverSuppressed(() => {
      meta.node.replaceWith(placeholder);
    });
    meta.placeholder = placeholder;
    meta.state = 'virtual';
    return true;
  };

  function ensureLive(meta) {
    if (meta.state === 'live') return true;
    if (!(meta.placeholder instanceof HTMLElement)) return false;
    if (!meta.placeholder.isConnected) return false;
    withObserverSuppressed(() => {
      meta.placeholder.replaceWith(meta.node);
    });
    meta.placeholder = null;
    meta.state = 'live';
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

  const foldHeavyCodeBlocks = () => {
    if (!state.settings.foldCodeBlocks) return;
    const blocks = document.querySelectorAll('pre:not([data-cgwd-code-processed])');
    for (const pre of blocks) {
      if (!(pre instanceof HTMLElement)) continue;
      pre.dataset.cgwdCodeProcessed = '1';
      const lines = (pre.innerText || '').split('\n').length;
      if (lines < state.settings.foldCodeLineCount) continue;

      withObserverSuppressed(() => {
        const wrap = document.createElement('div');
        wrap.className = 'cgwd-code-wrap cgwd-code-collapsed';
        wrap.dataset.cgwdCodeWrap = '1';
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
      <div>updates: ${state.stats.updates}</div>
      <div>reason: ${state.stats.lastReason}</div>
      <div>detector: ${state.stats.detector}</div>
      <div>mode: ${state.settings.contentVisibilityOnly ? 'safe' : (state.settings.aggressiveMode ? 'aggressive' : 'balanced')}</div>
    `;
  };

  const resetState = () => {
    state.scrollRoot = null;
    state.transcriptRoot = null;
    state.observerRoot = null;
    state.messages = [];
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.rescanTimer);
    clearTimeout(state.delayedUpdateTimer);
    if (state.debugEl) {
      state.debugEl.remove();
      state.debugEl = null;
    }
    state.stats = {
      live: 0,
      virtual: 0,
      messageCount: 0,
      updates: 0,
      lastReason: 'reset',
      detector: 'none'
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
    state.stats.messageCount = state.messages.length;
    state.stats.detector = detector;

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
      state.scrollRoot === window
    ) {
      return { top: 0, bottom: window.innerHeight };
    }
    const rect = state.scrollRoot.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  };

  const requestUpdate = (reason = 'unknown') => {
    if (!state.settings.enabled) return;
    if (state.scrollTicking) return;
    state.scrollTicking = true;
    requestAnimationFrame(() => {
      state.scrollTicking = false;
      update(reason);
    });
  };

  const update = (reason = 'unknown') => {
    state.stats.lastReason = reason;
    state.stats.updates += 1;

    if (!state.settings.enabled) {
      for (const meta of state.messages) ensureLive(meta);
      state.stats.live = state.messages.length;
      state.stats.virtual = 0;
      renderDebugOverlay();
      return;
    }

    const ageSinceInput = performance.now() - state.lastInputTs;
    if (ageSinceInput < state.settings.freezeAfterInputMs) {
      renderDebugOverlay();
      return;
    }

    foldHeavyCodeBlocks();

    const viewport = getViewportBounds();
    const marginPx = state.settings.aggressiveMode ? 250 : 400;
    let firstInRange = -1;
    let lastInRange = -1;

    for (let i = 0; i < state.messages.length; i += 1) {
      const rect = getRectForMessage(state.messages[i]);
      if (rect.bottom >= viewport.top - marginPx && rect.top <= viewport.bottom + marginPx) {
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
    const recentStart = Math.max(0, state.messages.length - state.settings.keepRecentMessages);
    const shouldVirtualize = !state.settings.contentVisibilityOnly && state.messages.length >= state.settings.minMessagesForVirtualization;

    let live = 0;
    let virtual = 0;
    const now = performance.now();

    for (let i = 0; i < state.messages.length; i += 1) {
      const meta = state.messages[i];
      const pinned = meta.manualPinUntil && now < meta.manualPinUntil;
      const keepLive = pinned || (i >= keepStart && i <= keepEnd) || i >= recentStart;
      if (!shouldVirtualize || keepLive) {
        if (ensureLive(meta)) live += 1;
      } else {
        if (ensureVirtual(meta)) virtual += 1;
        else live += 1;
      }
    }

    state.stats.live = live;
    state.stats.virtual = virtual;
    renderDebugOverlay();
  };

  const installObserver = () => {
    const root = state.observerRoot || state.transcriptRoot || document.querySelector('main') || document.body;
    if (!(root instanceof HTMLElement)) return;
    if (state.observer) state.observer.disconnect();

    state.observer = new MutationObserver((mutations) => {
      if (state.observerSuppressCount > 0 || performance.now() < state.ignoreObserverUntil) {
        return;
      }
      let significant = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          significant = true;
          break;
        }
      }
      if (!significant) return;
      clearTimeout(state.rescanTimer);
      state.rescanTimer = setTimeout(() => {
        scan();
        requestUpdate('mutation');
      }, 200);
    });

    state.observer.observe(root, {
      childList: true,
      subtree: true
    });
  };

  let installedScrollTarget = null;
  const scrollHandler = () => requestUpdate('scroll');
  const resizeHandler = () => requestUpdate('resize');

  const installScrollListeners = () => {
    const target = state.scrollRoot === document.scrollingElement ? window : (state.scrollRoot || window);
    if (installedScrollTarget === target) return;
    if (installedScrollTarget) {
      installedScrollTarget.removeEventListener('scroll', scrollHandler);
    }
    installedScrollTarget = target;
    installedScrollTarget.addEventListener('scroll', scrollHandler, { passive: true });
    window.removeEventListener('resize', resizeHandler);
    window.addEventListener('resize', resizeHandler, { passive: true });
  };

  const monitorRouteChanges = () => {
    if (state.routeTimer) clearInterval(state.routeTimer);
    state.routeTimer = setInterval(() => {
      if (location.href === state.url) return;
      state.url = location.href;
      state.booted = false;
      resetState();
      boot();
    }, 600);
  };

  const boot = async () => {
    if (state.booted) return;
    state.booted = true;
    state.settings = await getSettings();
    buildDebugOverlay();
    wireEditableGuards();
    schedule(() => {
      scan();
      installObserver();
      installScrollListeners();
      requestUpdate('boot');
      monitorRouteChanges();
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
