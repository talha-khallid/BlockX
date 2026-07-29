// content.js
(async function() {
  // ------------------------------------------------------------------
  // 🛑 1. INSTANT SYNCHRONOUS BARRIER (THE FLASH FIX)
  // Hide the page immediately BEFORE any network requests or DOM parsing
  // ------------------------------------------------------------------
  // Loading state: nothing is painted at all.
  const BARRIER_OPAQUE = 'html { visibility: hidden !important; opacity: 0 !important; background: #ffffff !important; }';

  // Prompt state: the page paints again so it can sit behind the frosted
  // overlay, but it is frozen — no scrolling, no clicks, no text selection.
  const BARRIER_FROZEN = `
    html { overflow: hidden !important; }
    body { pointer-events: none !important; user-select: none !important; }
  `;

  const securityBarrier = document.createElement('style');
  securityBarrier.id = 'blockx-security-barrier';
  securityBarrier.textContent = BARRIER_OPAQUE;
  if (document.documentElement) {
    document.documentElement.appendChild(securityBarrier);
  }

  const isTopFrame = window.top === window.self;

  function raiseBarrier(css) {
    securityBarrier.textContent = css;
    if (!securityBarrier.parentNode && document.documentElement) {
      document.documentElement.appendChild(securityBarrier);
    }
  }

  function dropBarrier() {
    if (securityBarrier.parentNode) securityBarrier.parentNode.removeChild(securityBarrier);
  }

  // --- 2. YOUTUBE SHORTS CSS INJECTION ---
  if (window.location.hostname.includes('youtube.com')) {
    const shortsStyle = document.createElement('style');
    shortsStyle.textContent = `
      ytd-guide-entry-renderer:has(a[href="/shorts"]),
      ytd-mini-guide-entry-renderer[aria-label="Shorts"],
      ytd-mini-guide-entry-renderer[title="Shorts"],
      a[path="shorts"],
      ytd-rich-shelf-renderer[is-shorts],
      ytd-reel-shelf-renderer,
      ytd-item-section-renderer:has(ytd-reel-shelf-renderer),
      ytd-shelf-renderer:has(a[href*="/shorts/"]),
      ytd-rich-item-renderer:has(a[href*="/shorts/"]),
      ytd-video-renderer:has(a[href*="/shorts/"]),
      [title="Shorts"],
      [aria-label="Shorts"] {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(shortsStyle);
  }

  // ------------------------------------------------------------------
  // 🛡️ 3. CONFIG & OMNI-WHITELIST
  // ------------------------------------------------------------------
  await loadConfig();

  // A pass belongs to one tab, and only the service worker knows which tab
  // this is, so it is asked once per page load.
  let tabUnlocked = false;
  try {
    const reply = await chrome.runtime.sendMessage({
      action: 'isTabUnlocked',
      host: window.location.hostname
    });
    tabUnlocked = !!(reply && reply.unlocked);
  } catch { /* service worker asleep or reloading */ }

  function isWhitelisted() {
    if (!CONFIG) return false;
    if (tabUnlocked) return true;
    return matchesAnyHostEntry(window.location.hostname, window.location.port, CONFIG.ALLOWED_DOMAINS);
  }

  // If the site is whitelisted, drop the barrier and shut down completely.
  if (isWhitelisted()) {
    console.log('🛡️ [BlockX] Site is whitelisted. Removing barrier.');
    dropBarrier();
    return;
  }

  function isScanExcluded() {
    if (!CONFIG || !CONFIG.SCAN_EXCLUDED || CONFIG.SCAN_EXCLUDED.length === 0) return false;
    const currentHost = window.location.hostname.toLowerCase();
    return CONFIG.SCAN_EXCLUDED.some(domain => {
      const cleanDomain = domain.trim().toLowerCase();
      return currentHost === cleanDomain || currentHost.endsWith('.' + cleanDomain);
    });
  }

  // --- 4. LISTEN FOR MAIN WORLD SPA BLOCKED NOTIFICATIONS & POPSTATE ---
  window.addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'SHORTS_BLOCKED' || event.data.type === 'URL_CHANGED')) {
      verifyPageSafety();
    }
  });

  window.addEventListener('popstate', () => { verifyPageSafety(); });
  document.addEventListener('yt-navigate-finish', () => { verifyPageSafety(); });
  
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      loadConfig().then(() => verifyPageSafety());
    }
  });

  let filterRegex = null;
  const storage = chrome.storage.session || chrome.storage.local;

  async function prepareFilter() {
    return new Promise((resolve) => {
      storage.get(['CACHED_BADWORDS'], async (result) => {
        let badwords = null;
        if (result && result.CACHED_BADWORDS) {
          badwords = result.CACHED_BADWORDS;
        }
        if (!badwords) {
          try {
            const r = await fetch(chrome.runtime.getURL('assets/data/badwords.json'));
            badwords = await r.json();
            storage.set({ CACHED_BADWORDS: badwords });
          } catch (e) {
            badwords = [];
          }
        }
        const allKeywords = CONFIG.KEYWORDS.concat(badwords);
        filterRegex = createOptimizedFilter(allKeywords);
        scanRegex = createBoundedFilter(allKeywords);
        resolve();
      });
    });
  }

  function handleBlock() {
    if (isWhitelisted()) return;

    const hostname = window.location.hostname;
    const targetUrl = getBlockUrl(CONFIG.BLOCK_METHOD, hostname);

    if (window.location.href.includes('chrome-extension://')) return;

    if (window.top === window.self) {
        if (CONFIG.BLOCK_METHOD === 'blocked_page') {
          chrome.runtime.sendMessage({ action: 'triggerBlock' });
        }
    }
    
    window.location.href = targetUrl;
  }

  function isExplicit(text) {
    if (!text || !filterRegex) return false;
    return filterRegex.test(text);
  }

  // ------------------------------------------------------------------
  // 🔍 ON-PAGE CONTENT SCAN
  // ------------------------------------------------------------------
  // Walks the visible text once, counting DISTINCT flagged terms and bailing
  // out the moment the threshold is met. Distinct-term counting is what keeps
  // an article that says one word twenty times from tripping the warning.

  let scanRegex = null;
  let scanPrompted = false;
  let scanAcknowledged = false;
  let scanThrottleId = null;
  let scanUrl = window.location.href;

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };

  function countFlaggedTerms(text, found, threshold) {
    if (!text) return false;
    scanRegex.lastIndex = 0;
    let match;
    while ((match = scanRegex.exec(text)) !== null) {
      found.add(match[0].toLowerCase());
      if (found.size >= threshold) return true;
    }
    return false;
  }

  function scanPage() {
    if (!scanRegex || !document.body) return null;

    const threshold = Math.max(1, parseInt(CONFIG.SCAN_SENSITIVITY, 10) || 2);
    const found = new Set();

    // Metadata first — porn pages give themselves away here and it is cheap.
    // Scoped to <head> on purpose: querying the whole document would walk the
    // entire body before the text pass even starts.
    if (countFlaggedTerms(document.title, found, threshold)) return found;
    if (countFlaggedTerms(extractSearchQuery(window.location.href), found, threshold)) return found;
    if (document.head) {
      for (const meta of document.head.querySelectorAll('meta[name="description"], meta[name="keywords"], meta[property^="og:"]')) {
        if (countFlaggedTerms(meta.getAttribute('content'), found, threshold)) return found;
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < SCAN_MIN_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (parent && SKIP_TAGS[parent.nodeName]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let visited = 0;
    let node;
    while ((node = walker.nextNode()) !== null) {
      if (++visited > SCAN_NODE_LIMIT) break;
      if (countFlaggedTerms(node.nodeValue, found, threshold)) return found;
    }

    return found.size >= threshold ? found : null;
  }

  function runContentScan() {
    if (!isTopFrame || scanPrompted || scanAcknowledged) return false;
    if (isWhitelisted() || isScanExcluded()) return false;

    const hits = scanPage();
    if (!hits) return false;

    console.log(`[BlockX] Content scan flagged ${hits.size} distinct terms.`);
    showScanPrompt();
    return true;
  }

  function scheduleRescan() {
    if (scanPrompted || scanAcknowledged || scanThrottleId) return;
    scanThrottleId = setTimeout(() => {
      scanThrottleId = null;
      if (runContentScan()) return;
    }, SCAN_THROTTLE_MS);
  }

  const PROMPT_STYLES = `
    :host { all: initial; }

    .wrap {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;

      /* The page stays behind this, blurred past the point of being readable.
         The 64px radius is what destroys detail; the tint only sets the mood,
         so it stays light enough that you can tell a page is still there. */
      -webkit-backdrop-filter: blur(64px) saturate(0.4) brightness(0.72);
      backdrop-filter: blur(64px) saturate(0.4) brightness(0.72);
      background: rgba(9, 9, 11, 0.55);
      animation: blockx-fade 220ms ease-out;
    }

    .card {
      box-sizing: border-box;
      width: 100%;
      max-width: 440px;
      padding: 40px 36px;
      text-align: center;
      border-radius: 20px;
      border: 1px solid #3f3f46;
      background: #1c1c1c;
      color: #f9fafb;
      box-shadow: 0 32px 64px -12px rgba(0, 0, 0, 0.7);
      animation: blockx-rise 260ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .mark {
      width: 56px;
      height: 56px;
      margin: 0 auto 22px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(25, 0, 255, 0.14);
      color: #8b7cff;
    }
    .mark svg { width: 26px; height: 26px; }

    h2 {
      margin: 0 0 12px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: inherit;
    }

    p {
      margin: 0 0 30px;
      font-size: 15px;
      line-height: 1.6;
      color: #a1a1aa;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    button {
      display: block;
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 13px 20px;
      border-radius: 12px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    button:focus-visible { outline: 2px solid #1900FF; outline-offset: 2px; }

    .leave { background: #f9fafb; color: #111827; margin-bottom: 10px; }
    .leave:hover { background: #ffffff; }

    .show { background: transparent; color: #71717a; border-color: #3f3f46; }
    .show:hover { color: #f9fafb; border-color: #71717a; }

    /* Light dashboard theme */
    :host([data-theme="light"]) .wrap {
      background: rgba(249, 250, 251, 0.72);
      -webkit-backdrop-filter: blur(64px) saturate(0.35) brightness(1.15);
      backdrop-filter: blur(64px) saturate(0.35) brightness(1.15);
    }
    :host([data-theme="light"]) .card {
      background: #ffffff;
      border-color: #e5e7eb;
      color: #111827;
      box-shadow: 0 32px 64px -12px rgba(0, 0, 0, 0.18);
    }
    :host([data-theme="light"]) .mark { background: rgba(25, 0, 255, 0.06); color: #1900FF; }
    :host([data-theme="light"]) p { color: #4b5563; }
    :host([data-theme="light"]) .leave { background: #111827; color: #ffffff; }
    :host([data-theme="light"]) .leave:hover { background: #000000; }
    :host([data-theme="light"]) .show { color: #6b7280; border-color: #e5e7eb; }
    :host([data-theme="light"]) .show:hover { color: #111827; border-color: #9ca3af; }

    @keyframes blockx-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes blockx-rise {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .wrap, .card { animation: none; }
    }
  `;

  // Audio keeps playing behind a blur, so anything already running is stopped.
  const mutedMedia = [];
  function freezeMedia() {
    for (const el of document.querySelectorAll('video, audio')) {
      mutedMedia.push([el, el.muted]);
      el.muted = true;
      try { el.pause(); } catch { /* ignore */ }
    }
  }
  function thawMedia() {
    for (const [el, wasMuted] of mutedMedia) el.muted = wasMuted;
    mutedMedia.length = 0;
  }

  function resolveTheme() {
    const theme = CONFIG.THEME || 'system';
    if (theme === 'light' || theme === 'dark') return theme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  /**
   * Renders the warning inside a closed shadow root so page CSS cannot reach
   * it. The host is attached to <html> rather than <body> so the page itself
   * sits behind the overlay's backdrop-filter and gets blurred out.
   */
  function showScanPrompt() {
    scanPrompted = true;

    const host = document.createElement('div');
    host.id = 'blockx-scan-prompt';
    host.setAttribute('data-theme', resolveTheme());
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('visibility', 'visible', 'important');

    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = PROMPT_STYLES;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const card = document.createElement('div');
    card.className = 'card';

    const mark = document.createElement('div');
    mark.className = 'mark';
    const shield = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    shield.setAttribute('viewBox', '0 0 24 24');
    shield.setAttribute('fill', 'none');
    shield.setAttribute('stroke', 'currentColor');
    shield.setAttribute('stroke-width', '2');
    shield.setAttribute('stroke-linecap', 'round');
    shield.setAttribute('stroke-linejoin', 'round');
    const shieldPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shieldPath.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
    shield.appendChild(shieldPath);
    mark.appendChild(shield);

    const heading = document.createElement('h2');
    heading.textContent = 'Explicit content detected';

    const message = document.createElement('p');
    message.textContent = (CONFIG.SCAN_MESSAGE || '').trim()
      || 'This page looks explicit. Do you still want to open it?';

    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'leave';
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'No, close this tab';
    leaveBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'closeTab' });
    });

    const showBtn = document.createElement('button');
    showBtn.className = 'show';
    showBtn.type = 'button';
    showBtn.textContent = 'Yes, show it';
    showBtn.addEventListener('click', () => {
      scanAcknowledged = true;
      scanPrompted = false;
      if (host.parentNode) host.parentNode.removeChild(host);
      thawMedia();
      dropBarrier();
    });

    card.appendChild(mark);
    card.appendChild(heading);
    card.appendChild(message);
    card.appendChild(leaveBtn);
    card.appendChild(showBtn);
    wrap.appendChild(card);
    root.appendChild(style);
    root.appendChild(wrap);

    // Order matters: the overlay is in place before the page is allowed to
    // paint, so the content is never briefly visible unblurred.
    document.documentElement.appendChild(host);
    raiseBarrier(BARRIER_FROZEN);
    freezeMedia();
    leaveBtn.focus();
  }

  function isBlockedDomain(hostname) {
    if (!hostname || !CONFIG.DOMAINS) return false;
    const lowerHost = hostname.toLowerCase();
    return CONFIG.DOMAINS.some(d => {
      const cleanDomain = d.trim().toLowerCase();
      return lowerHost === cleanDomain || lowerHost.endsWith('.' + cleanDomain);
    });
  }

  function isBlockedPage(url) {
    if (!url || !CONFIG.PAGE_URLS) return false;
    const lowerUrl = url.toLowerCase();
    return CONFIG.PAGE_URLS.some(p => {
      const cleanPattern = p.trim().toLowerCase();
      return lowerUrl.includes(cleanPattern);
    });
  }

  function isExactBlockedPage(url) {
    if (!url || !CONFIG.EXACT_PAGE_URLS) return false;
    try {
      const parsedUrl = new URL(url);
      const hostAndPath = (parsedUrl.hostname.replace(/^www\./i, '') + parsedUrl.pathname).toLowerCase();
      const hostPathAndQuery = (parsedUrl.hostname.replace(/^www\./i, '') + parsedUrl.pathname + parsedUrl.search).toLowerCase();
      
      return CONFIG.EXACT_PAGE_URLS.some(p => {
        const clean = p.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, '');
        if (clean.includes('?')) {
            return hostPathAndQuery === clean || hostPathAndQuery === clean + '/';
        } else {
            return hostAndPath === clean || hostAndPath === clean + '/';
        }
      });
    } catch { return false; }
  }

  // --- PHASE 1: Instant synchronous checks ---
  const currentHostname = window.location.hostname;
  if (!isWhitelisted() && (isBlockedDomain(currentHostname) || isBlockedPage(window.location.href) || isExactBlockedPage(window.location.href))) {
    handleBlock();
    return;
  }

  // --- PHASE 2: Check master domain list via background ---
  try {
    const masterCheck = await chrome.runtime.sendMessage({
      action: 'isMasterBlocked',
      domain: currentHostname
    });
    if (masterCheck?.blocked && !isWhitelisted()) {
      handleBlock();
      return;
    }
  } catch (e) {
    console.warn('[BlockX] Could not check master domain list:', e);
  }

  // --- PHASE 3: Prepare keyword filter and do full page verification ---
  await prepareFilter();

  function verifyPageSafety() {
    if (isWhitelisted()) return false;

    const currentUrl = window.location.href;
    const currentHost = window.location.hostname;

    // A route change is a fresh page as far as the scan is concerned.
    if (currentUrl !== scanUrl) {
      scanUrl = currentUrl;
      scanAcknowledged = false;
    }

    if (
      isBlockedDomain(currentHost) ||
      isBlockedPage(currentUrl) ||
      isExactBlockedPage(currentUrl) ||
      isExplicit(document.title) ||
      isExplicit(currentUrl)
    ) {
      if (typeof observer !== 'undefined') observer.disconnect();
      handleBlock();
      return true;
    }

    return runContentScan();
  }

  const cleanup = () => {
    if (!verifyPageSafety()) {
      dropBarrier();
    }
    if (typeof observer !== 'undefined' && isWhitelisted()) {
      observer.disconnect();
    }
  };

  const observer = new MutationObserver(() => {
    if (document.title) verifyPageSafety();
    // Late-loading content (infinite scroll, SPA routes) gets a throttled pass.
    scheduleRescan();
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    cleanup();
  } else {
    window.addEventListener('DOMContentLoaded', cleanup);
  }
})();