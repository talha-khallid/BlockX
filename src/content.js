// content.js
(async function() {
  // ------------------------------------------------------------------
  // 🛑 1. INSTANT SYNCHRONOUS BARRIER (THE FLASH FIX)
  // Hide the page immediately BEFORE any network requests or DOM parsing
  // ------------------------------------------------------------------
  // Loading state: nothing is painted at all.
  const BARRIER_OPAQUE = 'html { visibility: hidden !important; opacity: 0 !important; background: #ffffff !important; }';

  // Prompt state: an 80px blur & freeze on body — where every bit of page
  // content lives — so it stays completely unreadable even if overlay
  // elements are tampered with. The warning host sits on <html>, outside
  // body, which is what keeps it sharp while the page behind it is not.
  const BARRIER_FROZEN = `
    html { overflow: hidden !important; }
    body {
      filter: blur(80px) saturate(0.2) !important;
      -webkit-filter: blur(80px) saturate(0.2) !important;
      overflow: hidden !important;
      pointer-events: none !important;
      user-select: none !important;
    }
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
    if (document.documentElement && !document.documentElement.contains(securityBarrier)) {
      document.documentElement.appendChild(securityBarrier);
    }
  }

  function dropBarrier() {
    if (securityBarrier.parentNode) securityBarrier.parentNode.removeChild(securityBarrier);
  }

  // ------------------------------------------------------------------
  // ⚡ REAL-TIME INSTANT INPUT & KEYSTROKE SCANNER (MILLISECOND 0)
  // ------------------------------------------------------------------
  const CORE_FLAGGED_WORDS = [
    'porn', 'porno', 'pornography', 'pornhub',
    'sex', 'sexy', 'sexual', 'sexo', 'sexcam', 'sexdoll',
    'nude', 'nudes', 'nudity', 'naked', 'barenaked',
    'nsfw', 'xxx', 'xnxx', 'hentai', 'milf', 'lewd', 'erotic', 'erotica',
    'boobs', 'boob', 'tits', 'titties', 'titty', 'breasts',
    'cock', 'cocks', 'dick', 'pussy', 'vagina', 'penis', 'clit', 'clitoris',
    'ass', 'assmunch', 'butt', 'butthole', 'buttcheeks',
    'blowjob', 'handjob', 'footjob', 'cum', 'cumming', 'cumshot',
    'fuck', 'fucking', 'fuckin', 'masturbat', 'masturbation',
    'dildo', 'vibrator', 'bondage', 'bdsm', 'fetish',
    'orgasm', 'topless', 'upskirt', 'thong', 'lingerie'
  ];

  let badwordsSet = new Set(CORE_FLAGGED_WORDS);
  let testRegex = new RegExp(`\\b(?:${CORE_FLAGGED_WORDS.map(escapeRegExp).join('|')})\\b`, 'i');
  let filterRegex = null;
  let scanRegex = null;
  let pageRegex = null;

  function checkTextForFlaggedKeywords(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();
    if (clean.length < 3) return null;

    if (pageRegex) {
      pageRegex.lastIndex = 0;
      const match = pageRegex.exec(clean);
      if (match) return match[0];
    }

    if (testRegex) {
      const match = testRegex.exec(clean);
      if (match) return match[0];
    }

    if (scanRegex) {
      scanRegex.lastIndex = 0;
      const match = scanRegex.exec(clean);
      scanRegex.lastIndex = 0;
      if (match) return match[0];
    }

    if (badwordsSet && badwordsSet.size > 0) {
      const words = clean.toLowerCase().split(/[\s,._\-+/\\?&=#]+/);
      for (const w of words) {
        if (w.length >= 3 && badwordsSet.has(w)) {
          return w;
        }
      }
    }
    return null;
  }

  function triggerInputBlocked(hit, target) {
    if (scanPrompted || scanAcknowledged) return;
    console.log(`⚡ [BlockX] Flagged keyword "${hit}" detected in input! Prompting immediately.`);
    if (target && target.blur) {
      try { target.blur(); } catch {}
    }
    raiseBarrier(BARRIER_FROZEN);
    try { freezeMedia(); } catch {}
    try {
      showScanPrompt();
    } catch (e) {
      console.warn('[BlockX] Prompt failed; keeping page blurred.', e);
      raiseBarrier(BARRIER_FROZEN);
      try { freezeMedia(); } catch {}
    }
  }

  function checkAllInputsOnPage() {
    if (scanPrompted || scanAcknowledged) return false;
    const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [role="searchbox"], [role="combobox"]');
    for (const el of inputs) {
      const text = el.value || el.innerText || el.textContent || '';
      const hit = checkTextForFlaggedKeywords(text);
      if (hit) {
        triggerInputBlocked(hit, el);
        return true;
      }
    }
    return false;
  }

  function handleRealtimeInput(e) {
    if (scanPrompted || scanAcknowledged) return;
    const target = e.target;
    if (!target) return;

    let text = '';
    if (typeof target.value === 'string') {
      text = target.value;
    } else if (target.isContentEditable) {
      text = target.innerText || target.textContent || '';
    } else {
      return;
    }

    const hit = checkTextForFlaggedKeywords(text);
    if (hit) {
      triggerInputBlocked(hit, target);
    }
  }

  // Attach capture-phase input listeners immediately at script evaluation
  ['input', 'beforeinput', 'keyup', 'change', 'paste', 'focusin'].forEach(type => {
    window.addEventListener(type, handleRealtimeInput, true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const active = document.activeElement;
      const text = active ? (active.value || active.innerText || active.textContent || '') : '';
      const hit = checkTextForFlaggedKeywords(text);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        triggerInputBlocked(hit, active);
      }
    }
  }, true);

  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (form && form.querySelectorAll) {
      const inputs = form.querySelectorAll('input, textarea, [contenteditable]');
      for (const input of inputs) {
        const text = input.value || input.innerText || input.textContent || '';
        const hit = checkTextForFlaggedKeywords(text);
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          triggerInputBlocked(hit, input);
          return;
        }
      }
    }
  }, true);

  window.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    const isSearchBtn = target.closest && target.closest('button, [role="button"], input[type="submit"], [aria-label*="search" i], [aria-label*="Search" i]');
    if (isSearchBtn) {
      if (checkAllInputsOnPage()) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }
  }, true);

  // Active polling: scans the active element and all inputs every 80ms
  setInterval(() => {
    if (scanPrompted || scanAcknowledged) return;
    if (document.activeElement) {
      const el = document.activeElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        const text = el.value || el.innerText || el.textContent || '';
        const hit = checkTextForFlaggedKeywords(text);
        if (hit) {
          triggerInputBlocked(hit, el);
          return;
        }
      }
    }
  }, 80);

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

  function isSearchPage() {
    const at = window.location;
    if (extractSearchQuery(at.href)) return true;
    const host = at.hostname.toLowerCase();
    if (host.includes('google.') || host.includes('bing.com') || host.includes('duckduckgo.com') || host.includes('yahoo.com') || host.includes('yandex.')) {
      if (at.pathname.includes('/search') || at.pathname.includes('/images') || at.pathname.includes('/videos') || at.pathname.includes('/imgres')) {
        return true;
      }
    }
    return false;
  }

  function isWhitelisted(ignoreSearch = false) {
    if (!CONFIG) return false;
    if (tabUnlocked) return true;
    if (!ignoreSearch && isSearchPage()) return false;
    return matchesAnyHostEntry(window.location.hostname, window.location.port, CONFIG.ALLOWED_DOMAINS);
  }

  // Whitelisted sites bypass domain/page blocking rules, but proceed to live scanning below.

  function isScanExcluded() {
    if (!CONFIG) return false;
    const at = window.location;
    return matchesAnyScanExclusion(at.hostname, at.port, at.pathname, at.search, CONFIG.SCAN_EXCLUDED);
  }

  // --- 4. LISTEN FOR MAIN WORLD SPA BLOCKED NOTIFICATIONS & POPSTATE ---
  window.addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'SHORTS_BLOCKED' || event.data.type === 'URL_CHANGED')) {
      const targetUrl = event.data.url || window.location.href;
      checkAllInputsOnPage();
      verifyPageSafety(targetUrl);
    }
  });

  window.addEventListener('popstate', () => {
    checkAllInputsOnPage();
    verifyPageSafety(window.location.href);
  });
  document.addEventListener('yt-navigate-finish', () => { verifyPageSafety(); });
  
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      loadConfig().then(() => prepareFilter()).then(() => verifyPageSafety());
    }
  });

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
        const allKeywords = CONFIG.KEYWORDS.concat(badwords || []).concat(CORE_FLAGGED_WORDS);
        filterRegex = createOptimizedFilter(allKeywords);
        scanRegex = createBoundedFilter(allKeywords);
        pageRegex = createBoundedFilter(CONFIG.PAGE_KEYWORDS || []);
        badwordsSet = new Set(allKeywords.map(k => String(k || '').trim().toLowerCase()).filter(k => k.length >= 3));
        const validForTest = [...badwordsSet].sort((a, b) => b.length - a.length);
        testRegex = new RegExp(`\\b(?:${validForTest.map(escapeRegExp).join('|')})\\b`, 'i');
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

  let scanPrompted = false;
  let scanAcknowledged = false;
  let scanThrottleId = null;
  let scanUrl = window.location.href;

  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };

  function countFlaggedTerms(text, regex, found, threshold) {
    if (!text || !regex) return false;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      found.add(match[0].toLowerCase());
      if (found.size >= threshold) return true;
    }
    return false;
  }

  function scanPage() {
    if ((!scanRegex && !pageRegex) || !document.body) return null;

    const threshold = Math.max(1, parseInt(CONFIG.SCAN_SENSITIVITY, 10) || 2);
    const found = new Set();
    const pageFound = new Set();
    let totalHits = 0;

    function recordMatches(text, regex, set, isMain = true) {
      if (!text || !regex) return false;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        set.add(match[0].toLowerCase());
        if (isMain) totalHits++;
      }
      return set.size > 0;
    }

    const pageHit = (text) => recordMatches(text, pageRegex, pageFound, false);
    const mainHit = (text) => {
      recordMatches(text, scanRegex, found, true);
      return found.size >= threshold || totalHits >= 2;
    };

    // 0. Search query inspection — Intent Rule: 1 hit trips immediately
    const query = extractSearchQuery(window.location.href);
    if (query) {
      if (pageHit(query)) return pageFound;
      recordMatches(query, scanRegex, found, true);
      if (found.size > 0) return found;
    }

    // 1. Metadata and Title — Intent Rule: 1 hit in title or meta description trips immediately
    if (document.title) {
      if (pageHit(document.title)) return pageFound;
      recordMatches(document.title, scanRegex, found, true);
      if (found.size > 0) return found;
    }

    if (document.head) {
      for (const meta of document.head.querySelectorAll('meta[name="description"], meta[name="keywords"], meta[property^="og:"]')) {
        const content = meta.getAttribute('content');
        if (content) {
          if (pageHit(content)) return pageFound;
          recordMatches(content, scanRegex, found, true);
          if (found.size > 0) return found;
        }
      }
    }

    // 2. Active input & search bar values (e.g. search box containing query)
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea');
    for (const input of inputs) {
      const val = input.value;
      if (val && typeof val === 'string') {
        if (pageHit(val)) return pageFound;
        recordMatches(val, scanRegex, found, true);
        if (found.size > 0) return found;
      }
    }

    // 3. Text pass — walks visible body text (titles, descriptions, sidebars, knowledge panels)
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
      if (pageHit(node.nodeValue)) return pageFound;
      if (mainHit(node.nodeValue)) return found;
    }

    // 4. Element attributes pass — checks image alt text, descriptions, pins, cards, and links
    const elementsWithAttrs = document.body.querySelectorAll(
      'img[alt], img[title], img[data-pin-description], img[src], [aria-label], [title], [data-title], [data-alt], [data-test-id], a[href]'
    );
    let attrVisited = 0;
    const ATTR_LIMIT = 3500;
    for (const el of elementsWithAttrs) {
      if (++attrVisited > ATTR_LIMIT) break;

      if (el.tagName === 'IMG') {
        if (el.alt) {
          if (pageHit(el.alt)) return pageFound;
          if (mainHit(el.alt)) return found;
        }
        const imgDesc = el.getAttribute('data-pin-description');
        if (imgDesc) {
          if (pageHit(imgDesc)) return pageFound;
          if (mainHit(imgDesc)) return found;
        }
        const imgTitle = el.getAttribute('title');
        if (imgTitle) {
          if (pageHit(imgTitle)) return pageFound;
          if (mainHit(imgTitle)) return found;
        }
      } else if (el.tagName === 'A') {
        const href = el.getAttribute('href');
        if (href && href.length > 5 && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const decoded = decodeURIComponent(href);
            if (pageHit(decoded)) return pageFound;
            if (mainHit(decoded)) return found;
          } catch {}
        }
      }

      const aria = el.getAttribute('aria-label');
      if (aria) {
        if (pageHit(aria)) return pageFound;
        if (mainHit(aria)) return found;
      }
      const title = el.getAttribute('title');
      if (title) {
        if (pageHit(title)) return pageFound;
        if (mainHit(title)) return found;
      }
      const dataTitle = el.getAttribute('data-title');
      if (dataTitle) {
        if (pageHit(dataTitle)) return pageFound;
        if (mainHit(dataTitle)) return found;
      }
      const dataAlt = el.getAttribute('data-alt');
      if (dataAlt) {
        if (pageHit(dataAlt)) return pageFound;
        if (mainHit(dataAlt)) return found;
      }
    }

    return (found.size >= threshold || totalHits >= 2) ? found : null;
  }

  function runContentScan() {
    if (!isTopFrame || scanPrompted || scanAcknowledged) return false;
    if (isScanExcluded()) return false;

    // Direct check of all inputs on page
    if (checkAllInputsOnPage()) return true;

    const hits = scanPage();
    if (!hits) return false;

    console.log(`[BlockX] Content scan flagged ${hits.size} distinct terms.`);
    try {
      showScanPrompt();
    } catch (e) {
      // If the card can never be built, the page still must not be readable:
      // keep the freeze barrier up so the blur holds without the prompt.
      console.warn('[BlockX] Prompt failed; keeping page blurred.', e);
      raiseBarrier(BARRIER_FROZEN);
      freezeMedia();
    }
    return true;
  }

  let scanDeadline = 0;

  /**
   * Waits for the document to settle before judging it. Each further change
   * pushes the scan back, so a page mid-render is never graded on what it
   * happened to be showing a moment ago — but the deadline caps how long that
   * can be put off, so a page that never stops moving is still checked.
   */
  function scheduleRescan() {
    if (scanPrompted || scanAcknowledged) return;

    const now = Date.now();
    if (!scanDeadline) scanDeadline = now + SCAN_MAX_DEFER_MS;

    if (scanThrottleId) clearTimeout(scanThrottleId);
    const wait = Math.max(0, Math.min(SCAN_THROTTLE_MS, scanDeadline - now));

    scanThrottleId = setTimeout(() => {
      scanThrottleId = null;
      scanDeadline = 0;
      runContentScan();
    }, wait);
  }

  function cancelRescan() {
    if (scanThrottleId) clearTimeout(scanThrottleId);
    scanThrottleId = null;
    scanDeadline = 0;
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
      max-height: calc(100vh - 48px);
      overflow-y: auto;
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
      margin: 0 0 16px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: inherit;
    }

    /* The user's own warning words sit in a soft inset panel, the same
       language the dashboard modal uses, so they read as *their* message,
       not as system text. dir="auto" on the <p> keeps RTL scripts natural. */
    .msg {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 16px 18px;
      margin: 0 0 26px;
      max-height: 38vh;
      overflow-y: auto;
    }
    .msg-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #71717a;
      margin-bottom: 8px;
    }
    .msg p {
      margin: 0;
      font-size: 15.5px;
      line-height: 1.7;
      color: #d4d4d8;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* The card holds two views: the warning, then the "are you sure" gate. */
    .view[hidden] { display: none !important; }

    .hint {
      margin: 0 0 26px;
      font-size: 14.5px;
      line-height: 1.65;
      color: #a1a1aa;
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
    :host([data-theme="light"]) .msg { background: #f9fafb; border-color: #e5e7eb; }
    :host([data-theme="light"]) .msg p { color: #374151; }
    :host([data-theme="light"]) .msg-label { color: #6b7280; }
    :host([data-theme="light"]) .hint { color: #6b7280; }
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

  // Self-healing runs on busy pages whose own scripts constantly touch the
  // DOM; log each kind of repair once so the console is not spammed while
  // the protection quietly holds.
  const tamperNotes = new Set();
  function noteTamper(key, msg) {
    if (tamperNotes.has(key)) return;
    tamperNotes.add(key);
    console.warn(msg);
  }

  // The little rounded icon tile at the top of each card view.
  function makeMark(pathD) {
    const box = document.createElement('div');
    box.className = 'mark';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    box.appendChild(svg);
    return box;
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

    // Stage 1 — the warning itself, carrying the user's own message.
    const view1 = document.createElement('div');
    view1.className = 'view';

    const heading = document.createElement('h2');
    heading.textContent = 'Explicit content detected';

    const message = document.createElement('p');
    message.dir = 'auto';
    message.textContent = (CONFIG.WEAKENING_MESSAGE || '').trim()
      || 'This page looks explicit. Do you still want to open it?';

    const msgBox = document.createElement('div');
    msgBox.className = 'msg';
    const msgLabel = document.createElement('span');
    msgLabel.className = 'msg-label';
    msgLabel.textContent = 'Your warning message';
    msgBox.appendChild(msgLabel);
    msgBox.appendChild(message);

    view1.appendChild(makeMark('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'));
    view1.appendChild(heading);
    view1.appendChild(msgBox);

    // Stage 2 — a second, plainer gate shown after the first "yes".
    const view2 = document.createElement('div');
    view2.className = 'view';
    view2.hidden = true;

    const heading2 = document.createElement('h2');
    heading2.textContent = 'Are you sure?';

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'This page will be unblurred and shown. Only continue if you truly mean to.';

    view2.appendChild(makeMark('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01'));
    view2.appendChild(heading2);
    view2.appendChild(hint);

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

    // Plenty of sites bind bare letters as shortcuts. Our box sits in a
    // shadow root, so from the page's side events are retargeted to the host
    // div and a site shortcut could fire while the user is choosing here.
    // Keep our own events to ourselves: capture on window runs before any
    // page listener.
    const keepKeys = (event) => {
      if (event.composedPath().includes(host)) event.stopPropagation();
    };
    const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
    KEY_EVENTS.forEach(type => window.addEventListener(type, keepKeys, true));

    let tamperObserver = null;
    let tamperInterval = null;

    function enforceOverlayIntegrity() {
      if (!scanPrompted || scanAcknowledged) return;

      // 1. Ensure host overlay is in DOM and attached to documentElement
      if (!host.parentNode || !document.documentElement.contains(host)) {
        noteTamper('host', '[BlockX] Warning overlay removed — re-attaching.');
        document.documentElement.appendChild(host);
      }

      // 2. Re-enforce overlay visibility and position styles if altered
      const style = window.getComputedStyle(host);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
        noteTamper('host-style', '[BlockX] Warning overlay hidden — restoring visibility.');
        host.style.setProperty('all', 'initial', 'important');
        host.style.setProperty('position', 'fixed', 'important');
        host.style.setProperty('inset', '0', 'important');
        host.style.setProperty('z-index', '2147483647', 'important');
        host.style.setProperty('visibility', 'visible', 'important');
        host.style.setProperty('display', 'block', 'important');
        host.style.setProperty('opacity', '1', 'important');
        host.style.setProperty('pointer-events', 'auto', 'important');
      }

      // 3. Ensure the barrier is attached and the page is actually blurred.
      //    Checking the rendered effect instead of the exact CSS text means
      //    a site that re-serialises or tidies style tags cannot trip a
      //    false tamper alarm — only a real loss of the blur heals+logs.
      const bodyStyle = document.body ? window.getComputedStyle(document.body) : null;
      const blurred = !!(bodyStyle && (bodyStyle.filter || bodyStyle.webkitFilter || '').includes('blur'));
      if (!document.documentElement.contains(securityBarrier) || !blurred) {
        noteTamper('barrier', '[BlockX] Security barrier removed or weakened — re-attaching.');
        raiseBarrier(BARRIER_FROZEN);
      }

      // 4. The blur lives on <body>, so dragging a node onto <html> in the
      //    Elements panel would put it outside the blur. Anything that does
      //    not belong directly on <html> is put back inside <body>.
      const HEAD_LEVEL = { STYLE: 1, LINK: 1, META: 1, SCRIPT: 1, TITLE: 1 };
      for (const node of [...document.documentElement.children]) {
        if (node === document.head || node === document.body) continue;
        if (node === securityBarrier || node === host) continue;
        if (HEAD_LEVEL[node.nodeName]) continue;
        noteTamper('stray', '[BlockX] Content moved outside <body> — moving back.');
        if (document.body) document.body.appendChild(node);
      }
    }

    const reveal = () => {
      scanAcknowledged = true;
      scanPrompted = false;
      if (tamperObserver) tamperObserver.disconnect();
      if (tamperInterval) clearInterval(tamperInterval);
      KEY_EVENTS.forEach(type => window.removeEventListener(type, keepKeys, true));
      if (host.parentNode) host.parentNode.removeChild(host);
      thawMedia();
      dropBarrier();
    };

    const sureBtn = document.createElement('button');
    sureBtn.className = 'leave';
    sureBtn.type = 'button';
    sureBtn.textContent = "Yes, I'm sure — show it";

    const backBtn = document.createElement('button');
    backBtn.className = 'show';
    backBtn.type = 'button';
    backBtn.textContent = 'No, go back';

    // The first "yes" only moves to the second question; the page is revealed
    // by the second "yes" alone. "No, go back" returns to the blurred warning.
    showBtn.addEventListener('click', () => {
      view1.hidden = true;
      view2.hidden = false;
      sureBtn.focus();
    });
    backBtn.addEventListener('click', () => {
      view2.hidden = true;
      view1.hidden = false;
      leaveBtn.focus();
    });
    sureBtn.addEventListener('click', reveal);

    view1.appendChild(leaveBtn);
    view1.appendChild(showBtn);
    view2.appendChild(sureBtn);
    view2.appendChild(backBtn);
    card.appendChild(view1);
    card.appendChild(view2);
    wrap.appendChild(card);
    root.appendChild(style);
    root.appendChild(wrap);

    // Order matters: the overlay is in place before the page is allowed to
    // paint, so the content is never briefly visible unblurred.
    document.documentElement.appendChild(host);
    raiseBarrier(BARRIER_FROZEN);
    freezeMedia();
    leaveBtn.focus();

    // DevTools Anti-Tampering Protection: Self-healing observer & heartbeat poll
    setTimeout(() => {
      if (!scanPrompted || scanAcknowledged) return;

      tamperObserver = new MutationObserver(() => {
        enforceOverlayIntegrity();
      });

      tamperObserver.observe(document.documentElement, {
        childList: true,
        attributes: true,
        subtree: true,
        attributeFilter: ['style', 'class', 'hidden', 'id']
      });

      tamperInterval = setInterval(enforceOverlayIntegrity, 300);
    }, 100);
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

  function verifyPageSafety(customUrl) {
    const currentUrl = customUrl || window.location.href;
    const currentHost = window.location.hostname;

    // Check all inputs on the page right now as part of safety check
    if (checkAllInputsOnPage()) return true;

    // A route change is a fresh page as far as the scan is concerned.
    const routeChanged = currentUrl !== scanUrl;
    if (routeChanged) {
      scanUrl = currentUrl;
      scanAcknowledged = false;
      cancelRescan();
    }

    // IMMEDIATE check on search query: if URL has an explicit search query, catch it with 0ms delay!
    const query = extractSearchQuery(currentUrl);
    if (query && checkTextForFlaggedKeywords(query)) {
      console.log(`⚡ [BlockX] Immediate search query flagged on URL: "${query}"`);
      return runContentScan();
    }

    if (
      !isWhitelisted() && (
        isBlockedDomain(currentHost) ||
        isBlockedPage(currentUrl) ||
        isExactBlockedPage(currentUrl) ||
        isExplicit(document.title) ||
        isExplicit(currentUrl)
      )
    ) {
      if (typeof observer !== 'undefined') observer.disconnect();
      handleBlock();
      return true;
    }

    // The URL is the only thing that has changed so far; the body still belongs
    // to the previous view. Let it render, then judge what actually arrived.
    if (routeChanged) {
      scheduleRescan();
      return false;
    }

    return runContentScan();
  }

  // Check immediately upon site arrival (at document_start, no waiting for DOMContentLoaded!)
  verifyPageSafety();

  const cleanup = () => {
    if (!verifyPageSafety()) {
      dropBarrier();
    }
  };

  const observer = new MutationObserver(() => {
    if (scanPrompted || scanAcknowledged) return;
    if (document.title) verifyPageSafety();
    checkAllInputsOnPage();
    // Late-loading content (infinite scroll, SPA routes) gets an ultra-fast throttled pass.
    scheduleRescan();
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    cleanup();
  } else {
    window.addEventListener('DOMContentLoaded', cleanup);
  }
})();