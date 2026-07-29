// background.js
importScripts('config.js');

const DYNAMIC_RULE_LIMIT = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES || 30000;

// ------------------------------------------------------------------
// MASTER DOMAIN LIST (Simple JSON Set — O(1) lookup, service-worker safe)
// ------------------------------------------------------------------

let masterDomainSet = new Set();
let domainListPromise = null;

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

function isMasterBlocked(domain) {
  if (!domain || masterDomainSet.size === 0) return false;
  const clean = domain.toLowerCase().replace(/^www\./, '');

  if (masterDomainSet.has(clean)) return true;

  const parts = clean.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (masterDomainSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ------------------------------------------------------------------
// DELAYED REMOVAL ENGINE
// ------------------------------------------------------------------
// A removal is recorded as a pending record and only applied once its alarm
// fires. The record is voided the moment the dashboard tab that created it is
// closed or navigated away, so unblocking costs an uninterrupted 12 minutes.

const OPTIONS_URL = chrome.runtime.getURL('src/options/options.html');

async function getPendingRemovals() {
  const { PENDING_REMOVALS } = await chrome.storage.local.get({ PENDING_REMOVALS: [] });
  return Array.isArray(PENDING_REMOVALS) ? PENDING_REMOVALS : [];
}

function setPendingRemovals(pending) {
  return chrome.storage.local.set({ PENDING_REMOVALS: pending });
}

// The tab counts as alive only while it exists AND is still on the dashboard.
async function isOwnerTabAlive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab && typeof tab.url === 'string' && tab.url.startsWith(OPTIONS_URL);
  } catch {
    return false;
  }
}

async function schedulePendingRemoval(listKey, value, tabId) {
  if (!DELAYED_REMOVAL_LISTS.includes(listKey)) return null;
  if (typeof tabId !== 'number' || typeof value !== 'string') return null;

  const pending = await getPendingRemovals();
  const existing = pending.find(p => p.listKey === listKey && p.value === value);
  if (existing) return existing;

  const now = Date.now();
  const record = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    listKey,
    value,
    tabId,
    scheduledAt: now,
    expiresAt: now + REMOVAL_DELAY_MS
  };

  pending.push(record);
  await setPendingRemovals(pending);
  chrome.alarms.create(PENDING_ALARM_PREFIX + record.id, { when: record.expiresAt });
  return record;
}

async function cancelPendingRemoval(id) {
  const pending = await getPendingRemovals();
  const remaining = pending.filter(p => p.id !== id);
  if (remaining.length === pending.length) return;
  await setPendingRemovals(remaining);
  await chrome.alarms.clear(PENDING_ALARM_PREFIX + id);
}

async function cancelPendingForTab(tabId) {
  const pendingImport = await getPendingImport();
  if (pendingImport && pendingImport.tabId === tabId) {
    await clearPendingImport();
    console.log('[BlockX] Dashboard left — voided the pending settings import.');
  }

  const pending = await getPendingRemovals();
  const voided = pending.filter(p => p.tabId === tabId);
  if (voided.length === 0) return;

  await setPendingRemovals(pending.filter(p => p.tabId !== tabId));
  await Promise.all(voided.map(p => chrome.alarms.clear(PENDING_ALARM_PREFIX + p.id)));
  console.log(`[BlockX] Dashboard left — voided ${voided.length} pending removal(s).`);
}

async function executePendingRemoval(id) {
  const pending = await getPendingRemovals();
  const record = pending.find(p => p.id === id);
  if (!record) return;

  if (!(await isOwnerTabAlive(record.tabId))) {
    await cancelPendingRemoval(id);
    return;
  }

  // Alarms can fire early; re-arm rather than letting the wait be cut short.
  if (Date.now() < record.expiresAt) {
    chrome.alarms.create(PENDING_ALARM_PREFIX + id, { when: record.expiresAt });
    return;
  }

  await setPendingRemovals(pending.filter(p => p.id !== id));
  await chrome.alarms.clear(PENDING_ALARM_PREFIX + id);

  const stored = await chrome.storage.local.get({ [record.listKey]: [] });
  const list = Array.isArray(stored[record.listKey]) ? stored[record.listKey] : [];
  const remaining = list.filter(item => item !== record.value);

  if (remaining.length !== list.length) {
    // This write trips the storage listener below, which rebuilds the DNR rules.
    await chrome.storage.local.set({ [record.listKey]: remaining });
    console.log(`[BlockX] Cooling-off elapsed — removed "${record.value}" from ${record.listKey}.`);
  }
}

// ------------------------------------------------------------------
// DEFERRED SETTINGS IMPORT
// ------------------------------------------------------------------
// An imported backup can rewrite every list at once, so it gets the same
// cooling-off treatment unless the user affirms their intention.

async function getPendingImport() {
  const { PENDING_IMPORT } = await chrome.storage.local.get({ PENDING_IMPORT: null });
  return PENDING_IMPORT;
}

async function clearPendingImport() {
  const record = await getPendingImport();
  if (!record) return;
  await chrome.storage.local.remove('PENDING_IMPORT');
  await chrome.alarms.clear(PENDING_IMPORT_ALARM_PREFIX + record.id);
}

// Only the known settings keys are ever written back, so a hand-edited file
// cannot inject anything the dashboard does not manage.
function sanitiseImport(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const clean = {};
  for (const key of IMPORTABLE_KEYS) {
    if (settings[key] !== undefined) clean[key] = settings[key];
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

async function applyImportNow(settings) {
  const clean = sanitiseImport(settings);
  if (!clean) return false;

  // The lists are replaced wholesale, so any in-flight removal is moot.
  const pending = await getPendingRemovals();
  await Promise.all(pending.map(p => chrome.alarms.clear(PENDING_ALARM_PREFIX + p.id)));
  await clearPendingImport();
  await chrome.storage.local.set({ ...clean, PENDING_REMOVALS: [] });
  return true;
}

async function schedulePendingImport(settings, tabId) {
  const clean = sanitiseImport(settings);
  if (!clean || typeof tabId !== 'number') return null;

  await clearPendingImport();

  const now = Date.now();
  const record = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    settings: clean,
    tabId,
    scheduledAt: now,
    expiresAt: now + REMOVAL_DELAY_MS
  };

  await chrome.storage.local.set({ PENDING_IMPORT: record });
  chrome.alarms.create(PENDING_IMPORT_ALARM_PREFIX + record.id, { when: record.expiresAt });
  return record;
}

async function executePendingImport(id) {
  const record = await getPendingImport();
  if (!record || record.id !== id) return;

  if (!(await isOwnerTabAlive(record.tabId))) {
    await clearPendingImport();
    return;
  }

  if (Date.now() < record.expiresAt) {
    chrome.alarms.create(PENDING_IMPORT_ALARM_PREFIX + id, { when: record.expiresAt });
    return;
  }

  await applyImportNow(record.settings);
  console.log('[BlockX] Cooling-off elapsed — imported settings applied.');

  // Only extension pages receive this; the dashboard reloads onto the new state.
  chrome.runtime.sendMessage({ action: 'importApplied' }).catch(() => {});
}

// Drops records whose dashboard tab is gone and re-arms the ones that survived.
// After a browser restart every tab id is new, so everything pending is voided.
async function reconcilePendingRemovals() {
  const pendingImport = await getPendingImport();
  if (pendingImport) {
    if (!(await isOwnerTabAlive(pendingImport.tabId))) {
      await clearPendingImport();
    } else if (Date.now() >= pendingImport.expiresAt) {
      await executePendingImport(pendingImport.id);
    } else {
      chrome.alarms.create(PENDING_IMPORT_ALARM_PREFIX + pendingImport.id, { when: pendingImport.expiresAt });
    }
  }

  const pending = await getPendingRemovals();
  if (pending.length === 0) return;

  const survivors = [];
  for (const record of pending) {
    if (await isOwnerTabAlive(record.tabId)) {
      survivors.push(record);
    } else {
      await chrome.alarms.clear(PENDING_ALARM_PREFIX + record.id);
    }
  }

  if (survivors.length !== pending.length) await setPendingRemovals(survivors);

  for (const record of survivors) {
    if (Date.now() >= record.expiresAt) {
      await executePendingRemoval(record.id);
    } else {
      chrome.alarms.create(PENDING_ALARM_PREFIX + record.id, { when: record.expiresAt });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(PENDING_ALARM_PREFIX)) {
    executePendingRemoval(alarm.name.slice(PENDING_ALARM_PREFIX.length));
  } else if (alarm.name.startsWith(PENDING_IMPORT_ALARM_PREFIX)) {
    executePendingImport(alarm.name.slice(PENDING_IMPORT_ALARM_PREFIX.length));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelPendingForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !changeInfo.url.startsWith(OPTIONS_URL)) {
    cancelPendingForTab(tabId);
  }
});

// ------------------------------------------------------------------
// DNR RULES UPDATE
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

    console.log(`[BlockX] Applying ${rules.length}/${DYNAMIC_RULE_LIMIT} dynamic rules.`);

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
  reconcilePendingRemovals();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDomainListLoaded();
  updateBlockingRules();
  reconcilePendingRemovals();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    const shouldUpdate = [
      'CUSTOM_DOMAINS', 'CUSTOM_KEYWORDS', 'CUSTOM_PAGES',
      'CUSTOM_EXACT_PAGES', 'CUSTOM_ALLOWED_DOMAINS', 'BLOCK_METHOD', 'ACTIVE_GAME_INDEX'
    ].some(key => changes[key] !== undefined);

    if (shouldUpdate) {
      await updateBlockingRules();
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getConfig') {
    loadConfig().then((config) => sendResponse({ config: config }));
    return true;
  }

  if (request.action === 'triggerBlock' && sender.tab) {
    // 🛡️ THE NATIVE IFRAME FIX: 
    // frameId 0 means the message came from the main parent window.
    // If an iframe tries to trigger a block on a whitelisted site, we ignore it natively here.
    if (sender.frameId === 0) {
      loadConfig().then((config) => {
        const url = new URL(sender.tab.url);
        const targetUrl = getBlockUrl(config.BLOCK_METHOD, url.hostname);
        chrome.tabs.update(sender.tab.id, { url: targetUrl });
      });
    }
    return true;
  }

  if (request.action === 'isMasterBlocked') {
    const domain = request.domain?.toLowerCase().replace(/^www\./, '');
    ensureDomainListLoaded().then(() => {
      sendResponse({ blocked: isMasterBlocked(domain) });
    });
    return true;
  }

  if (request.action === 'schedulePendingRemoval') {
    schedulePendingRemoval(request.listKey, request.value, sender.tab?.id)
      .then((record) => sendResponse({ record }));
    return true;
  }

  if (request.action === 'cancelPendingRemoval') {
    cancelPendingRemoval(request.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === 'getPendingRemovals') {
    reconcilePendingRemovals()
      .then(async () => sendResponse({
        pending: await getPendingRemovals(),
        pendingImport: await getPendingImport()
      }));
    return true;
  }

  if (request.action === 'applyImportNow') {
    applyImportNow(request.settings).then((ok) => sendResponse({ ok }));
    return true;
  }

  if (request.action === 'schedulePendingImport') {
    schedulePendingImport(request.settings, sender.tab?.id)
      .then((record) => sendResponse({ record }));
    return true;
  }

  if (request.action === 'cancelPendingImport') {
    clearPendingImport().then(() => sendResponse({ ok: true }));
    return true;
  }

  return true;
});

// ------------------------------------------------------------------
// SPA NAVIGATION INTERCEPTION (webNavigation.onCommitted)
// ------------------------------------------------------------------

function shouldBlockUrl(urlStr, config) {
  if (!urlStr) return false;
  const urlLower = urlStr.toLowerCase();

  if (urlLower.startsWith('chrome-extension://') || urlLower.startsWith('chrome://') || urlLower.startsWith('about:')) return false;

  if (config.ALLOWED_DOMAINS && config.ALLOWED_DOMAINS.length > 0) {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();
      const isAllowed = config.ALLOWED_DOMAINS.some(d => {
        const clean = d.trim().toLowerCase();
        return hostname === clean || hostname.endsWith('.' + clean);
      });
      if (isAllowed) return false; 
    } catch { /* ignore */ }
  }

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

  if (config.PAGE_URLS && config.PAGE_URLS.length > 0) {
    const pageMatch = config.PAGE_URLS.some(p => {
      const clean = p.trim().toLowerCase().replace(/^https?:\/\//i, '');
      return urlLower.includes(clean);
    });
    if (pageMatch) return true;
  }

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

  if (config.KEYWORDS && config.KEYWORDS.length > 0) {
    if (config.KEYWORDS.some(k => urlLower.includes(k.trim().toLowerCase()))) return true;
  }

  try {
    const hostname = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    if (isMasterBlocked(hostname)) return true;
  } catch { /* ignore */ }

  return false;
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; 
  const url = details.url;

  if (url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) return;

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