// background.js
importScripts('config.js', 'settings-sync.js');

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

// ------------------------------------------------------------------
// KEYWORD LIST
// ------------------------------------------------------------------
// The service worker used to check config.KEYWORDS only, which is the user's
// own list and empty by default — the 349 bundled terms were never consulted
// outside the content script. That left an explicit search reaching the page
// before anything looked at it.
let badwordsCache = null;
let badwordsPromise = null;

function ensureBadwordsLoaded() {
  if (badwordsPromise) return badwordsPromise;
  badwordsPromise = (async () => {
    try {
      const resp = await fetch(chrome.runtime.getURL('assets/data/badwords.json'));
      badwordsCache = await resp.json();
    } catch (e) {
      console.error('[BlockX] Failed to load badwords.json:', e);
      badwordsCache = [];
    }
  })();
  return badwordsPromise;
}

let searchFilter = null;
let searchFilterKey = '';

function getSearchFilter(customKeywords) {
  const key = (customKeywords || []).join(' ');
  if (searchFilter && key === searchFilterKey) return searchFilter;
  searchFilterKey = key;
  searchFilter = createBoundedFilter((badwordsCache || []).concat(customKeywords || []));
  return searchFilter;
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

async function getPendingChanges() {
  const { PENDING_CHANGES } = await chrome.storage.local.get({ PENDING_CHANGES: [] });
  return Array.isArray(PENDING_CHANGES) ? PENDING_CHANGES : [];
}

function setPendingChanges(pending) {
  return chrome.storage.local.set({ PENDING_CHANGES: pending });
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

async function schedulePendingChange(listKey, value, op, tabId) {
  const direction = op === 'add' ? 'add' : 'remove';
  if (!isDelayed(listKey, direction)) return null;
  if (typeof tabId !== 'number' || typeof value !== 'string') return null;

  const pending = await getPendingChanges();
  const existing = pending.find(p => p.listKey === listKey && p.value === value);
  if (existing) return existing;

  const now = Date.now();
  const record = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    listKey,
    value,
    op: direction,
    tabId,
    scheduledAt: now,
    expiresAt: now + REMOVAL_DELAY_MS
  };

  pending.push(record);
  await setPendingChanges(pending);
  chrome.alarms.create(PENDING_ALARM_PREFIX + record.id, { when: record.expiresAt });
  return record;
}

async function cancelPendingChange(id) {
  const pending = await getPendingChanges();
  const remaining = pending.filter(p => p.id !== id);
  if (remaining.length === pending.length) return;
  await setPendingChanges(remaining);
  await chrome.alarms.clear(PENDING_ALARM_PREFIX + id);
}

async function cancelPendingForTab(tabId) {
  const pendingImport = await getPendingImport();
  if (pendingImport && pendingImport.tabId === tabId) {
    await clearPendingImport();
    console.log('[BlockX] Dashboard left — voided the pending settings import.');
  }

  const pending = await getPendingChanges();
  const voided = pending.filter(p => p.tabId === tabId);
  if (voided.length === 0) return;

  await setPendingChanges(pending.filter(p => p.tabId !== tabId));
  await Promise.all(voided.map(p => chrome.alarms.clear(PENDING_ALARM_PREFIX + p.id)));
  console.log(`[BlockX] Dashboard left — voided ${voided.length} pending removal(s).`);
}

async function executePendingChange(id) {
  const pending = await getPendingChanges();
  const record = pending.find(p => p.id === id);
  if (!record) return;

  if (!(await isOwnerTabAlive(record.tabId))) {
    await cancelPendingChange(id);
    return;
  }

  // Alarms can fire early; re-arm rather than letting the wait be cut short.
  if (Date.now() < record.expiresAt) {
    chrome.alarms.create(PENDING_ALARM_PREFIX + id, { when: record.expiresAt });
    return;
  }

  await setPendingChanges(pending.filter(p => p.id !== id));
  await chrome.alarms.clear(PENDING_ALARM_PREFIX + id);

  const stored = await chrome.storage.local.get({ [record.listKey]: [] });
  const list = Array.isArray(stored[record.listKey]) ? stored[record.listKey] : [];

  const next = record.op === 'add'
    ? (list.includes(record.value) ? list : [...list, record.value])
    : list.filter(item => item !== record.value);

  if (next.length !== list.length) {
    // This write trips the storage listener below, which rebuilds the DNR rules.
    await chrome.storage.local.set({ [record.listKey]: next });
    const verb = record.op === 'add' ? 'added' : 'removed';
    console.log(`[BlockX] Cooling-off elapsed — ${verb} "${record.value}" ${verb === 'added' ? 'to' : 'from'} ${record.listKey}.`);
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
  const pending = await getPendingChanges();
  await Promise.all(pending.map(p => chrome.alarms.clear(PENDING_ALARM_PREFIX + p.id)));
  await clearPendingImport();
  await chrome.storage.local.set({ ...clean, PENDING_CHANGES: [] });
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
async function reconcilePendingState() {
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

  const pending = await getPendingChanges();
  if (pending.length === 0) return;

  const survivors = [];
  for (const record of pending) {
    if (await isOwnerTabAlive(record.tabId)) {
      survivors.push(record);
    } else {
      await chrome.alarms.clear(PENDING_ALARM_PREFIX + record.id);
    }
  }

  if (survivors.length !== pending.length) await setPendingChanges(survivors);

  for (const record of survivors) {
    if (Date.now() >= record.expiresAt) {
      await executePendingChange(record.id);
    } else {
      chrome.alarms.create(PENDING_ALARM_PREFIX + record.id, { when: record.expiresAt });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TEMP_GRANT_ALARM) {
    expireGrants();
  } else if (alarm.name === 'blockx-settings-poll') {
    reconcileSettings('poll');
  } else if (alarm.name.startsWith(PENDING_ALARM_PREFIX)) {
    executePendingChange(alarm.name.slice(PENDING_ALARM_PREFIX.length));
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
let ruleUpdateChain = Promise.resolve();

function queueRuleUpdate() {
  ruleUpdateChain = ruleUpdateChain
    .catch(() => {})
    .then(() => updateBlockingRules());
  return ruleUpdateChain;
}

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

      const entry = normaliseHostEntry(filter);
      if (!entry) return false;

      const asciiHost = toPunycode(entry.host);
      if (!isAscii(asciiHost)) return false;

      // The || anchor only understands plain domain names, so a port or an
      // address literal needs an explicit pattern instead.
      const condition = (entry.port || entry.kind === 'ipv6')
        ? {
            regexFilter: `^https?://${escapeRegExp(asciiHost)}`
              + (entry.port ? `:${entry.port}` : '(?::\\d+)?')
              + '(?:[/?#]|$)',
            resourceTypes: ['main_frame', 'sub_frame']
          }
        : { urlFilter: `||${asciiHost}^`, resourceTypes: ['main_frame', 'sub_frame'] };

      rules.push({ id: ruleId++, priority, action: { type: 'allow' }, condition });
      return true;
    };

    if (config.ALLOWED_DOMAINS) {
      [...new Set(config.ALLOWED_DOMAINS)].forEach(d => addAllowRule(100, d));
    }

    // Temporary passes outrank the permanent whitelist so they cannot be
    // shadowed by a lower-priority block on the same host.
    activeGrants(config.TEMP_GRANTS)
      .filter(g => !g.consumed)
      .forEach(g => addAllowRule(200, g.host));

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
async function bootstrap(reason) {
  ensureDomainListLoaded();
  ensureBadwordsLoaded();
  await reconcileSettings(reason);
  await queueRuleUpdate();
  await reconcilePendingState();
}

chrome.runtime.onInstalled.addListener(() => { bootstrap('installed'); });
chrome.runtime.onStartup.addListener(() => { bootstrap('startup'); });

// Settings the extension itself changed still need fanning out to the other
// stores, but the revision stamp must not itself retrigger a publish.
let publishTimer = null;
function schedulePublish() {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishSettings();
  }, 400);
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  const shouldUpdate = [
    'CUSTOM_DOMAINS', 'CUSTOM_KEYWORDS', 'CUSTOM_PAGES',
    'CUSTOM_EXACT_PAGES', 'CUSTOM_ALLOWED_DOMAINS', 'BLOCK_METHOD', 'ACTIVE_GAME_INDEX',
    'TEMP_GRANTS'
  ].some(key => changes[key] !== undefined);

  if (shouldUpdate) await queueRuleUpdate();

  if (SETTINGS_KEYS.some(key => changes[key] !== undefined)) schedulePublish();
});

// Another profile on the same account changed something.
chrome.storage.sync.onChanged.addListener(() => { reconcileSettings('sync-change'); });

// The settings file can be changed by a profile that is not running right now,
// so it is re-read periodically rather than only at startup.
chrome.alarms.create('blockx-settings-poll', { periodInMinutes: 5 });

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
      loadConfig().then(async (config) => {
        const url = new URL(sender.tab.url);
        await rememberBlocked(sender.tab.id, sender.tab.url,
          blockReason(sender.tab.url, config, sender.tab.id) || 'content');
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

  if (request.action === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
    return true;
  }

  if (request.action === 'schedulePendingChange') {
    schedulePendingChange(request.listKey, request.value, request.op, sender.tab?.id)
      .then((record) => sendResponse({ record }));
    return true;
  }

  if (request.action === 'cancelPendingChange') {
    cancelPendingChange(request.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === 'getPendingChanges') {
    reconcilePendingState()
      .then(async () => sendResponse({
        pending: await getPendingChanges(),
        pendingImport: await getPendingImport()
      }));
    return true;
  }

  if (request.action === 'getUnlockContext') {
    (async () => {
      await Promise.all([ensureDomainListLoaded(), ensureBadwordsLoaded()]);
      const config = await loadConfig();
      const grants = activeGrants(config.TEMP_GRANTS);
      const { BLOCKED_ORIGINS = {} } = await chrome.storage.session.get({ BLOCKED_ORIGINS: {} });

      // Whatever the tab is showing now — our block page, a game, a data: URI
      // or a connection error — the thing to unlock is what it was sent away
      // from. Falling back to the tab's own address covers a page the content
      // script stopped after it had already loaded.
      let target = null;
      const url = request.url || '';

      if (/^https?:/i.test(url)) {
        try {
          const parsed = new URL(url);
          const reason = blockReason(url, config, request.tabId);
          if (reason) target = { host: parsed.hostname, url, reason };
        } catch { /* ignore */ }
      }
      if (!target) {
        const recorded = BLOCKED_ORIGINS[request.tabId];
        if (recorded && Date.now() - recorded.at < 60 * 60 * 1000) target = recorded;
      }

      const active = target
        ? grants.find(g => isGrantedTab(target.host, [g], request.tabId)) || null
        : null;

      // A domain on the user's own restricted list was a deliberate decision.
      // No pass is offered for it at any price.
      const refused = !!target && target.reason === 'custom_domain';

      sendResponse({
        phrase: config.UNLOCK_PHRASE || '',
        durationMs: TEMP_GRANT_MS,
        target: refused ? null : target,
        refusedHost: refused ? target.host : null,
        active
      });
    })();
    return true;
  }

  if (request.action === 'verifyUnlockPhrase') {
    (async () => {
      const config = await loadConfig();
      sendResponse({ ok: unlockPhraseMatches(config.UNLOCK_PHRASE, request.typed) });
    })();
    return true;
  }

  if (request.action === 'grantTempPass') {
    (async () => {
      const config = await loadConfig();
      if (!unlockPhraseMatches(config.UNLOCK_PHRASE, request.typed)) {
        sendResponse({ ok: false, reason: 'mismatch' });
        return;
      }

      // Never issue a pass for the user's own restricted domains, even if the
      // request is crafted rather than coming from the popup.
      if (blockReason(`https://${request.host}/`, config, -1) === 'custom_domain') {
        sendResponse({ ok: false, reason: 'restricted' });
        return;
      }

      const record = await grantTempPass(request.host, request.tabId);
      if (!record) {
        sendResponse({ ok: false, reason: 'badhost' });
        return;
      }
      // Wait for the allow rule to be live. Answering sooner lets the popup
      // navigate into the old ruleset, which redirects straight back.
      await queueRuleUpdate();
      sendResponse({ ok: true, record });
    })();
    return true;
  }

  if (request.action === 'isTabUnlocked') {
    (async () => {
      const config = await loadConfig();
      sendResponse({
        unlocked: isGrantedTab(request.host, config.TEMP_GRANTS, sender.tab?.id)
      });
    })();
    return true;
  }

  if (request.action === 'revokeTempPass') {
    (async () => {
      const grants = (await readGrants()).filter(g => g.host !== request.host);
      await chrome.storage.local.set({ TEMP_GRANTS: grants });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'getSyncStatus') {
    settingsSyncStatus().then((status) => sendResponse({ status }));
    return true;
  }

  if (request.action === 'reconcileSettings') {
    reconcileSettings('dashboard').then((result) => sendResponse({ result }));
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

function shouldBlockUrl(urlStr, config, tabId) {
  return blockReason(urlStr, config, tabId) !== null;
}

/**
 * Why a URL is blocked, or null when it is not. The reason matters because a
 * domain the user put on their own restricted list is a deliberate decision
 * and is never offered a temporary pass.
 */
function blockReason(urlStr, config, tabId) {
  if (!urlStr) return null;
  const urlLower = urlStr.toLowerCase();

  if (urlLower.startsWith('chrome-extension://') || urlLower.startsWith('chrome://') || urlLower.startsWith('about:')) return null;

  // A pass earned in the popup outranks every block below, but only in the one
  // tab it was granted for and only until that tab loads the page once.
  try {
    const parsed = new URL(urlStr);
    if (hasTempGrant(parsed.hostname, config.TEMP_GRANTS, tabId)) return null;
  } catch { /* ignore */ }

  // Search terms are judged BEFORE the whitelist, which is the whole point.
  // Allowing google.com is how you keep mail, drive and ordinary searching;
  // it is not permission to use Google to look for this. Checked with word
  // boundaries so "analysis" and "scunthorpe" pass and "porn" does not.
  const query = extractSearchQuery(urlStr);
  if (query) {
    const filter = getSearchFilter(config.KEYWORDS);
    if (filter) {
      filter.lastIndex = 0;
      if (filter.test(query)) {
        console.log(`[BlockX] Blocked search: ${JSON.stringify(query)}`);
        return 'search';
      }
    }
  }

  // Everything from here down can be waived by an allowed destination.
  try {
    const parsed = new URL(urlStr);
    if (matchesAnyHostEntry(parsed.hostname, parsed.port, config.ALLOWED_DOMAINS)) return null;
  } catch { /* ignore */ }

  if (config.DOMAINS && config.DOMAINS.length > 0) {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();
      const domainMatch = config.DOMAINS.some(d => {
        const clean = d.trim().toLowerCase();
        return hostname === clean || hostname.endsWith('.' + clean);
      });
      if (domainMatch) return 'custom_domain';
    } catch {
      if (config.DOMAINS.some(d => urlLower.includes(d.trim().toLowerCase()))) return 'custom_domain';
    }
  }

  if (config.PAGE_URLS && config.PAGE_URLS.length > 0) {
    const pageMatch = config.PAGE_URLS.some(p => {
      const clean = p.trim().toLowerCase().replace(/^https?:\/\//i, '');
      return urlLower.includes(clean);
    });
    if (pageMatch) return 'page';
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
      if (exactMatch) return 'exact_page';
    } catch { /* ignore */ }
  }

  if (config.KEYWORDS && config.KEYWORDS.length > 0) {
    if (config.KEYWORDS.some(k => urlLower.includes(k.trim().toLowerCase()))) return 'keyword';
  }

  try {
    const hostname = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    if (isMasterBlocked(hostname)) return 'master_list';
  } catch { /* ignore */ }

  return null;
}

// A pass is spent the moment its page commits. Anything after that — a reload,
// a second tab, a link back later — is blocked again even with time left.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const { TEMP_GRANTS = [] } = await chrome.storage.local.get({ TEMP_GRANTS: [] });
  if (TEMP_GRANTS.length === 0) return;

  let host;
  try {
    host = new URL(details.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return;
  }

  let changed = false;
  const next = TEMP_GRANTS.map(g => {
    if (g.consumed || g.tabId !== details.tabId) return g;
    const granted = g.host.toLowerCase().replace(/^www\./, '');
    if (host !== granted && !host.endsWith('.' + granted)) return g;
    changed = true;
    return { ...g, consumed: true };
  });

  if (changed) {
    await chrome.storage.local.set({ TEMP_GRANTS: next });
    console.log('[BlockX] Temporary pass spent.');
  }
});

// A pass belongs to its tab and dies with it.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { TEMP_GRANTS = [] } = await chrome.storage.local.get({ TEMP_GRANTS: [] });
  const remaining = TEMP_GRANTS.filter(g => g.tabId !== tabId);
  if (remaining.length !== TEMP_GRANTS.length) {
    await chrome.storage.local.set({ TEMP_GRANTS: remaining });
  }
});

// Remembers what a tab was sent away from, so the popup can offer to unlock it
// even once the tab is showing the block page or a game.
async function rememberBlocked(tabId, url, reason) {
  try {
    const parsed = new URL(url);
    const { BLOCKED_ORIGINS = {} } = await chrome.storage.session.get({ BLOCKED_ORIGINS: {} });
    BLOCKED_ORIGINS[tabId] = { host: parsed.hostname, url, reason: reason || null, at: Date.now() };
    await chrome.storage.session.set({ BLOCKED_ORIGINS });
  } catch { /* ignore */ }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { BLOCKED_ORIGINS = {} } = await chrome.storage.session.get({ BLOCKED_ORIGINS: {} });
  if (BLOCKED_ORIGINS[tabId]) {
    delete BLOCKED_ORIGINS[tabId];
    await chrome.storage.session.set({ BLOCKED_ORIGINS });
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = details.url;

  if (url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) return;

  await Promise.all([ensureDomainListLoaded(), ensureBadwordsLoaded()]);
  const config = await loadConfig();
  if (config.BLOCK_METHOD === 'none') return;

  const reason = blockReason(url, config, details.tabId);
  if (reason) {
    console.log(`[BlockX] Blocked via onBeforeNavigate (${reason}): ${url}`);
    await rememberBlocked(details.tabId, url, reason);
    try {
      const hostname = new URL(url).hostname;
      chrome.tabs.update(details.tabId, { url: getBlockUrl(config.BLOCK_METHOD, hostname) });
    } catch {
      chrome.tabs.update(details.tabId, { url: getBlockUrl(config.BLOCK_METHOD, '') });
    }
  }
});

// ------------------------------------------------------------------
// TEMPORARY PASSES
// ------------------------------------------------------------------

async function readGrants() {
  const { TEMP_GRANTS = [] } = await chrome.storage.local.get({ TEMP_GRANTS: [] });
  return activeGrants(TEMP_GRANTS);
}

/**
 * The single place the unlock phrase is judged. It lives in the service worker
 * on purpose: a page inspector can rewrite anything in a tab, including a
 * button's disabled attribute, so no decision that matters may be taken from
 * the state of the DOM.
 */
function unlockPhraseMatches(expected, typed) {
  const want = String(expected || '').trim().replace(/\s+/g, ' ');
  const got = String(typed || '').trim().replace(/\s+/g, ' ');
  return want.length > 0 && want === got;
}

async function grantTempPass(host, tabId) {
  const entry = normaliseHostEntry(host);
  if (!entry || typeof tabId !== 'number') return null;

  const grants = (await readGrants()).filter(g => !(g.host === entry.host && g.tabId === tabId));
  const record = { host: entry.host, tabId, consumed: false, expiresAt: Date.now() + TEMP_GRANT_MS };
  grants.push(record);

  await chrome.storage.local.set({ TEMP_GRANTS: grants });
  chrome.alarms.create(TEMP_GRANT_ALARM, { when: record.expiresAt + 500 });
  console.log(`[BlockX] Temporary pass for ${record.host} in tab ${tabId}, one visit.`);
  return record;
}

async function expireGrants() {
  const { TEMP_GRANTS = [] } = await chrome.storage.local.get({ TEMP_GRANTS: [] });
  const live = activeGrants(TEMP_GRANTS);
  if (live.length !== TEMP_GRANTS.length) await chrome.storage.local.set({ TEMP_GRANTS: live });
  if (live.length > 0) {
    chrome.alarms.create(TEMP_GRANT_ALARM, { when: Math.min(...live.map(g => g.expiresAt)) + 500 });
  }
}