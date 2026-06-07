// content.js
(async function() {
  // ------------------------------------------------------------------
  // 🛑 1. INSTANT SYNCHRONOUS BARRIER (THE FLASH FIX)
  // Hide the page immediately BEFORE any network requests or DOM parsing
  // ------------------------------------------------------------------
  const securityBarrier = document.createElement('style');
  securityBarrier.id = 'blockx-security-barrier';
  securityBarrier.textContent = 'html { visibility: hidden !important; opacity: 0 !important; background: #ffffff !important; }';
  if (document.documentElement) {
    document.documentElement.appendChild(securityBarrier);
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

  function isWhitelisted() {
    if (!CONFIG || !CONFIG.ALLOWED_DOMAINS || CONFIG.ALLOWED_DOMAINS.length === 0) return false;
    const currentHost = window.location.hostname.toLowerCase();
    return CONFIG.ALLOWED_DOMAINS.some(domain => {
      const cleanDomain = domain.trim().toLowerCase();
      return currentHost === cleanDomain || currentHost.endsWith('.' + cleanDomain);
    });
  }

  // If the site is whitelisted, drop the barrier and shut down completely.
  if (isWhitelisted()) {
    console.log('🛡️ [BlockX] Site is whitelisted. Removing barrier.');
    if (securityBarrier.parentNode) securityBarrier.parentNode.removeChild(securityBarrier);
    return; 
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
    return false;
  }

  const cleanup = () => {
    if (!verifyPageSafety()) {
      if (securityBarrier && securityBarrier.parentNode) {
          securityBarrier.parentNode.removeChild(securityBarrier);
      }
    }
    if (typeof observer !== 'undefined' && isWhitelisted()) {
      observer.disconnect();
    }
  };

  const observer = new MutationObserver(() => {
    if (document.title) verifyPageSafety();
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    cleanup();
  } else {
    window.addEventListener('DOMContentLoaded', cleanup);
  }
})();