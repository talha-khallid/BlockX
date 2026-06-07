// background.js
importScripts('config.js');

const DYNAMIC_RULE_LIMIT = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 30000;

// ------------------------------------------------------------------
// MASTER DOMAIN LIST (Simple JSON Set — O(1) lookup, service-worker safe)
// ------------------------------------------------------------------

/** Set of all blocked domains from domains.json */
let masterDomainSet = new Set();

/**
 * Single promise that resolves once the domain list is loaded.
 * Re-used across all callers so we never load twice in one worker lifetime.
 */
let domainListPromise = null;

/**
 * Loads domains.json and stores every entry in a Set for O(1) lookup.
 * Safe to call multiple times — subsequent calls return the same promise.
 */
function ensureDomainListLoaded() {
  if (domainListPromise) return domainListPromise;
  domainListPromise = (async () => {
    try {
      const resp = await fetch(chrome.runtime.getURL('assets/data/domains.json'));
      const domains = await resp.json();
      masterDomainSet = new Set(domains.map(d => d.toLowerCase().replace(/^www\./, '')));
      console.log(`[BlockX] Domain list loaded: ${masterDomainSet.size} entries`);
    } catch (e) {
      console.error('[BlockX] Failed to load domains.json:', e);
      masterDomainSet = new Set();
    }
  })();
  return domainListPromise;
}

/**
 * Returns true if the given domain (or any of its parent domains) is in the master list.
 * @param {string} domain - normalised hostname, e.g. "sub.pornhub.com"
 * @returns {boolean}
 */
function isMasterBlocked(domain) {
  if (!domain || masterDomainSet.size === 0) return false;
  const clean = domain.toLowerCase().replace(/^www\./, '');

  // Exact match
  if (masterDomainSet.has(clean)) return true;

  // Walk up the subdomain chain: sub.example.com → example.com
  const parts = clean.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (masterDomainSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ------------------------------------------------------------------
// DNR RULES UPDATE (user-defined custom domains / keywords / pages)
// ------------------------------------------------------------------
async function updateBlockingRules() {
  try {
    const config = await loadConfig();
    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(rule => rule.id);

    if (config.BLOCK_METHOD === 'none') {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRuleIds });
      return;
    }

    const rules = [];
    // Start dynamic rules from ID 10000 to prevent collisions with static rulesets
    let ruleId = 10000;

    const action = (() => {
      switch (config.BLOCK_METHOD) {
        case 'infinite_hang':
          return { type: 'redirect', redirect: { url: 'http://1.1.1.1:81' } };
        case 'data_uri':
          return { type: 'redirect', redirect: { url: 'data:text/plain,Blocked' } };
        case 'custom_url':
          let custom = config.CUSTOM_REDIRECT_URL;
          if (custom && custom.trim() !== '') {
            if (!/^https?:\/\//i.test(custom)) custom = 'http://' + custom;
            return { type: 'redirect', redirect: { url: custom } };
          }
          // Fall through to default if empty
        default:
          if (config.SHOW_GAME_INSTANTLY && config.GAMES.length > 0) {
            let index = config.ACTIVE_GAME_INDEX;
            if (index === -1) index = Math.floor(Math.random() * config.GAMES.length);
            return { type: 'redirect', redirect: { extensionPath: '/' + config.GAMES[index].path } };
          }
          return { type: 'redirect', redirect: { extensionPath: '/assets/blocked-pages/blocked.html' } };
      }
    })();

    const isAscii = (str) => /^[\x00-\x7F]*$/.test(str);

    function toPunycode(domain) {
      try { return new URL('http://' + domain).hostname; } catch { return domain; }
    }

    const addRule = (priority, filter, isDomain = false) => {
      if (rules.length >= DYNAMIC_RULE_LIMIT) return false;
      const clean = filter.trim().toLowerCase();
      if (!clean) return false;

      if (isDomain) {
        const asciiDomain = toPunycode(clean);
        if (!isAscii(asciiDomain)) return false;
        rules.push({
          id: ruleId++,
          priority,
          action,
          condition: { urlFilter: `||${asciiDomain}^`, resourceTypes: ['main_frame', 'sub_frame'] }
        });
        return true;
      }

      if (!isAscii(clean)) return false;
      rules.push({
        id: ruleId++,
        priority,
        action,
        condition: { urlFilter: clean, resourceTypes: ['main_frame', 'sub_frame'] }
      });
      return true;
    };

    [...new Set(config.DOMAINS)].forEach(d => addRule(10, d, true));
    
    await ensureDomainListLoaded();
    [...masterDomainSet].forEach(d => addRule(10, d, true));

    [...new Set(config.KEYWORDS)].forEach(k => addRule(9, k));
    config.PAGE_URLS.forEach(p => addRule(8, p));

    const addExactPageRule = (priority, filter) => {
      if (rules.length >= DYNAMIC_RULE_LIMIT) return false;
      let clean = filter.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, '');
      if (!clean || !isAscii(clean)) return false;
      
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      rules.push({
        id: ruleId++,
        priority,
        action,
        condition: { 
            regexFilter: `^https?://(www\\.)?${escapeRegExp(clean)}/?([\\?#].*)?$`,
            resourceTypes: ['main_frame', 'sub_frame'] 
        }
      });
      return true;
    };

    const addAllowRule = (priority, filter) => {
      if (rules.length >= DYNAMIC_RULE_LIMIT) return false;
      const clean = filter.trim().toLowerCase();
      if (!clean) return false;
      const asciiDomain = toPunycode(clean);
      if (!isAscii(asciiDomain)) return false;
      rules.push({
        id: ruleId++,
        priority,
        action: { type: 'allow' },
        condition: { urlFilter: `||${asciiDomain}^`, resourceTypes: ['main_frame', 'sub_frame'] }
      });
      return true;
    };

    if (config.ALLOWED_DOMAINS) {
      [...new Set(config.ALLOWED_DOMAINS)].forEach(d => addAllowRule(100, d));
    }

    if (config.EXACT_PAGE_URLS) {
      config.EXACT_PAGE_URLS.forEach(p => addExactPageRule(8, p));
    }

    console.log(`[BlockX] Applying ${rules.length}/${DYNAMIC_RULE_LIMIT} dynamic user rules starting at ID 10000.`);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRuleIds,
      addRules: rules
    });

    chrome.storage.session.remove('CACHED_BADWORDS');

  } catch (err) {
    console.error('[BlockX] Fatal error in updateBlockingRules:', err);
  }
}

// ------------------------------------------------------------------
// EVENT LISTENERS
// ------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  ensureDomainListLoaded();
  updateBlockingRules();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDomainListLoaded();
  updateBlockingRules();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    const shouldUpdate = [
      'CUSTOM_DOMAINS',
      'CUSTOM_KEYWORDS',
      'CUSTOM_PAGES',
      'CUSTOM_EXACT_PAGES',
      'CUSTOM_ALLOWED_DOMAINS',
      'BLOCK_METHOD',
      'ACTIVE_GAME_INDEX'
    ].some(key => changes[key] !== undefined);

    if (shouldUpdate) {
      console.log('[BlockX] Storage config changed. Re-synchronizing rules...');
      await updateBlockingRules();
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getConfig') {
    loadConfig().then(() => sendResponse({ config: CONFIG }));
    return true;
  }

  if (request.action === 'triggerBlock' && sender.tab) {
    loadConfig().then(() => {
      const url = new URL(sender.tab.url);
      const targetUrl = getBlockUrl(CONFIG.BLOCK_METHOD, url.hostname);
      chrome.tabs.update(sender.tab.id, { url: targetUrl });
    });
    return true;
  }

  if (request.action === 'isMasterBlocked') {
    // Ensure domain list is loaded before answering — handles cold service worker wake-ups
    const domain = request.domain?.toLowerCase().replace(/^www\./, '');
    ensureDomainListLoaded().then(() => {
      sendResponse({ blocked: isMasterBlocked(domain) });
    });
    return true; // keep message channel open for async reply
  }

  return true;
});

// ------------------------------------------------------------------
// SPA NAVIGATION INTERCEPTION (webNavigation.onCommitted)
// ------------------------------------------------------------------

/**
 * Checks if the URL matches custom domains, pages, keywords, or master blocked list.
 */
function shouldBlockUrl(urlStr, config) {
  if (!urlStr) return false;
  const urlLower = urlStr.toLowerCase();

  if (
    urlLower.startsWith('chrome-extension://') ||
    urlLower.startsWith('chrome://') ||
    urlLower.startsWith('about:')
  ) return false;

  // 0. Allowed Domains (Whitelist override)
  if (config.ALLOWED_DOMAINS && config.ALLOWED_DOMAINS.length > 0) {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();
      const isAllowed = config.ALLOWED_DOMAINS.some(d => {
        const clean = d.trim().toLowerCase();
        return hostname === clean || hostname.endsWith('.' + clean);
      });
      if (isAllowed) return false; // Bypass all blocking
    } catch { /* ignore */ }
  }

  // 1. Custom domains
  if (config.DOMAINS && config.DOMAINS.length > 0) {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();
      const domainMatch = config.DOMAINS.some(d => {
        const clean = d.trim().toLowerCase();
        return hostname === clean || hostname.endsWith('.' + clean);
      });
      if (domainMatch) return true;
    } catch {
      if (config.DOMAINS.some(d => urlLower.includes(d.trim().toLowerCase()))) return true;
    }
  }

  // 2. Custom pages
  if (config.PAGE_URLS && config.PAGE_URLS.length > 0) {
    const pageMatch = config.PAGE_URLS.some(p => {
      const clean = p.trim().toLowerCase().replace(/^https?:\/\//i, '');
      return urlLower.includes(clean);
    });
    if (pageMatch) return true;
  }

  // 2.5 Custom exact pages
  if (config.EXACT_PAGE_URLS && config.EXACT_PAGE_URLS.length > 0) {
    try {
      const parsedUrl = new URL(urlStr);
      const hostAndPath = (parsedUrl.hostname.replace(/^www\./i, '') + parsedUrl.pathname).toLowerCase();
      const hostPathAndQuery = (parsedUrl.hostname.replace(/^www\./i, '') + parsedUrl.pathname + parsedUrl.search).toLowerCase();
      
      const exactMatch = config.EXACT_PAGE_URLS.some(p => {
        const clean = p.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, '');
        if (clean.includes('?')) {
            return hostPathAndQuery === clean || hostPathAndQuery === clean + '/';
        } else {
            return hostAndPath === clean || hostAndPath === clean + '/';
        }
      });
      if (exactMatch) return true;
    } catch { /* ignore */ }
  }

  // 3. Custom keywords
  if (config.KEYWORDS && config.KEYWORDS.length > 0) {
    if (config.KEYWORDS.some(k => urlLower.includes(k.trim().toLowerCase()))) return true;
  }

  // 4. Master domain list
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    if (isMasterBlocked(hostname)) return true;
  } catch { /* ignore */ }

  return false;
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  const url = details.url;

  if (
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://') ||
    url.startsWith('about:')
  ) return;

  // Ensure the domain list is ready before we evaluate — critical on service worker wake-up
  await ensureDomainListLoaded();

  const config = await loadConfig();
  if (config.BLOCK_METHOD === 'none') return;

  if (shouldBlockUrl(url, config)) {
    console.log(`[BlockX] Blocked via onBeforeNavigate: ${url}`);
    try {
      const hostname = new URL(url).hostname;
      chrome.tabs.update(details.tabId, { url: getBlockUrl(config.BLOCK_METHOD, hostname) });
    } catch {
      chrome.tabs.update(details.tabId, { url: getBlockUrl(config.BLOCK_METHOD, '') });
    }
  }
});