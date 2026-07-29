let CONFIG = {
  // 'blocked_page', 'infinite_hang', 'data_uri'
  BLOCK_METHOD: 'blocked_page',

  // If true, shows the game specified in ACTIVE_GAME_INDEX instead of blocked.html
  SHOW_GAME_INSTANTLY: true,
  ACTIVE_GAME_INDEX: 0, 

  // Custom Redirect URL
  CUSTOM_REDIRECT_URL: '',

  // Custom Keywords (Overridden by badwords.json if loaded)
  KEYWORDS: [],

  // Custom Domains (Overridden by domains.json if loaded)
  DOMAINS: [],

  // Specific Pages or Paths to block
  PAGE_URLS: [
    'reddit.com/r/nsfw',
    'reddit.com/r/porn',
    'twitter.com/search?q=porn',
    'google.com/search?q=porn',
    'bing.com/search?q=porn'
  ],

  // Specific Exact Pages to block (no child pages)
  EXACT_PAGE_URLS: [],

  // Allowed Domains (Whitelist to bypass all blocks)
  ALLOWED_DOMAINS: [],

  // Domains exempt from on-page content scanning
  SCAN_EXCLUDED: [],

  // Message shown by the on-page content warning
  SCAN_MESSAGE: 'This page looks explicit. Remember why you set this up. Do you still want to open it?',

  // How many DISTINCT flagged terms a page needs before the warning appears
  SCAN_SENSITIVITY: 2,

  // Phrase that must be retyped to earn a temporary pass to a blocked site
  UNLOCK_PHRASE: 'I am choosing to break my own rule',

  // Temporary passes earned through the popup
  TEMP_GRANTS: [],

  GAMES: [
    { name: "Tower Blocks", path: "assets/blocked-pages/tower-blocks.html" },
    { name: "Rubiks Cube", path: "assets/blocked-pages/rubiks-cube.html" },
  ]
};

// ------------------------------------------------------------------
// DELAYED REMOVAL (COOLING-OFF PERIOD)
// ------------------------------------------------------------------
// Taking an entry off a blocklist is never immediate. It is scheduled, and it
// only lands if the dashboard tab that asked for it stays open the whole time.
const REMOVAL_DELAY_MS = 12 * 60 * 1000;

// Exempting something from scanning gives up less than dropping it from a
// blocklist, so it is a shorter wait — long enough to be a decision, not so
// long that narrowing a false positive is a chore.
const SCAN_EXCLUSION_DELAY_MS = 4 * 60 * 1000;

// Taking an entry OFF one of these lists weakens protection, so it waits.
const DELAYED_REMOVAL_LISTS = [
  'CUSTOM_DOMAINS',
  'CUSTOM_KEYWORDS',
  'CUSTOM_PAGES',
  'CUSTOM_EXACT_PAGES'
];

// Putting an entry ON one of these lists weakens protection, so it waits.
// The inverse direction on both kinds of list stays instant.
const DELAYED_ADDITION_LISTS = [
  'CUSTOM_SCAN_EXCLUDED'
];

function isDelayed(listKey, op) {
  return op === 'add'
    ? DELAYED_ADDITION_LISTS.includes(listKey)
    : DELAYED_REMOVAL_LISTS.includes(listKey);
}

/**
 * How long a given change has to wait. Every caller asks rather than assuming,
 * so the wait shown in the dashboard is always the wait actually served.
 */
function delayFor(listKey, op) {
  if (op === 'add' && listKey === 'CUSTOM_SCAN_EXCLUDED') return SCAN_EXCLUSION_DELAY_MS;
  return REMOVAL_DELAY_MS;
}

const PENDING_ALARM_PREFIX = 'blockx-pending-change:';
const PENDING_IMPORT_ALARM_PREFIX = 'blockx-pending-import:';

// Settings keys an imported backup is allowed to write.
const IMPORTABLE_KEYS = [
  'BLOCK_METHOD',
  'CUSTOM_DOMAINS',
  'CUSTOM_KEYWORDS',
  'CUSTOM_PAGES',
  'CUSTOM_EXACT_PAGES',
  'CUSTOM_ALLOWED_DOMAINS',
  'CUSTOM_SCAN_EXCLUDED',
  'SCAN_MESSAGE',
  'SCAN_SENSITIVITY',
  'UNLOCK_PHRASE',
  'ACTIVE_GAME_INDEX',
  'SECURITY_ENABLED',
  'PASSWORD',
  'THEME'
];

// ------------------------------------------------------------------
// SHARED SETTINGS
// ------------------------------------------------------------------
// The same settings follow the user across profiles and machines through two
// independent stores, reconciled by revision — highest revision wins:
//
//   chrome.storage.sync   every profile signed into the same Google account.
//                         Always on, nothing to install.
//   the settings file     every profile on this machine regardless of account,
//                         reached through the native host in native/. Only
//                         active once that helper has been installed.
const NATIVE_HOST_NAME = 'com.blockx.settings';
const SETTINGS_FILE_VERSION = 1;

// Keys that make up a shared settings snapshot. Deliberately the same set an
// imported backup may write — pending state is per-tab and never travels.
const SETTINGS_KEYS = IMPORTABLE_KEYS;

// Mixed into the file checksum. Not a secret and not meant to stop a
// determined edit — it exists so a casual hand-edit of the settings file is
// detected rather than silently trusted.
const SETTINGS_CHECKSUM_SALT = 'blockx-settings-v1';

/**
 * Stable stringify: object keys sorted at every level so the same settings
 * always produce the same checksum.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Narrows an arbitrary object to the known settings keys.
 */
function pickSettings(source) {
  if (!source || typeof source !== 'object') return null;
  const picked = {};
  for (const key of SETTINGS_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

/**
 * True when `incoming` would loosen protection relative to `current`:
 * anything dropped from a blocklist, anything added to an exemption list,
 * a coarser scan threshold, or the dashboard lock being switched off.
 */
function weakensProtection(current, incoming) {
  const list = (source, key) => (Array.isArray(source?.[key]) ? source[key] : []);

  for (const key of DELAYED_REMOVAL_LISTS) {
    const before = list(current, key);
    const after = new Set(list(incoming, key));
    if (incoming[key] !== undefined && before.some(item => !after.has(item))) return true;
  }

  for (const key of ['CUSTOM_ALLOWED_DOMAINS', ...DELAYED_ADDITION_LISTS]) {
    const before = new Set(list(current, key));
    if (list(incoming, key).some(item => !before.has(item))) return true;
  }

  if (typeof incoming.SCAN_SENSITIVITY === 'number'
      && incoming.SCAN_SENSITIVITY > (current.SCAN_SENSITIVITY ?? 2)) return true;

  if (current.SECURITY_ENABLED && incoming.SECURITY_ENABLED === false) return true;

  return false;
}

/**
 * Formats a millisecond duration as m:ss.
 */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Loads configuration from chrome.storage.local and merges it into CONFIG.
 */
async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      BLOCK_METHOD: 'blocked_page',
      CUSTOM_REDIRECT_URL: '',
      CUSTOM_KEYWORDS: [],
      CUSTOM_DOMAINS: [],
      CUSTOM_PAGES: [
        'reddit.com/r/nsfw',
        'reddit.com/r/porn',
        'twitter.com/search?q=porn',
        'google.com/search?q=porn',
        'bing.com/search?q=porn'
      ],
      CUSTOM_EXACT_PAGES: [],
      CUSTOM_ALLOWED_DOMAINS: [], // FIXED: Changed from ALLOWED_DOMAINS to CUSTOM_ALLOWED_DOMAINS
      CUSTOM_SCAN_EXCLUDED: [],
      SCAN_MESSAGE: CONFIG.SCAN_MESSAGE,
      SCAN_SENSITIVITY: 2,
      UNLOCK_PHRASE: CONFIG.UNLOCK_PHRASE,
      TEMP_GRANTS: [],
      THEME: 'system',
      ACTIVE_GAME_INDEX: -1
    }, (items) => {
      CONFIG.BLOCK_METHOD = items.BLOCK_METHOD;
      CONFIG.CUSTOM_REDIRECT_URL = items.CUSTOM_REDIRECT_URL;
      CONFIG.KEYWORDS = items.CUSTOM_KEYWORDS;
      CONFIG.DOMAINS = items.CUSTOM_DOMAINS;
      CONFIG.PAGE_URLS = items.CUSTOM_PAGES;
      CONFIG.EXACT_PAGE_URLS = items.CUSTOM_EXACT_PAGES;
      CONFIG.ALLOWED_DOMAINS = items.CUSTOM_ALLOWED_DOMAINS;
      CONFIG.SCAN_EXCLUDED = items.CUSTOM_SCAN_EXCLUDED;
      CONFIG.SCAN_MESSAGE = items.SCAN_MESSAGE;
      CONFIG.SCAN_SENSITIVITY = items.SCAN_SENSITIVITY;
      CONFIG.UNLOCK_PHRASE = items.UNLOCK_PHRASE;
      CONFIG.TEMP_GRANTS = items.TEMP_GRANTS;
      CONFIG.THEME = items.THEME;
      CONFIG.ACTIVE_GAME_INDEX = items.ACTIVE_GAME_INDEX;
      resolve(CONFIG);
    });
  });
}

/**
 * Escapes regex special characters.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates a single optimized RegExp from an array of keywords.
 * Big O: O(N) where N is text length during search, instead of O(N*K).
 */
function createOptimizedFilter(keywords) {
  if (!keywords || keywords.length === 0) return null;
  // Filter out short/empty keywords to prevent over-blocking
  const validKeywords = keywords
    .map(kw => kw.trim().toLowerCase())
    .filter(kw => kw.length >= 3);
  
  if (validKeywords.length === 0) return null;
  
  // Combine into a single alternation: (word1|word2|word3)
  const pattern = validKeywords.map(escapeRegExp).join('|');
  return new RegExp(pattern, 'i');
}

// ------------------------------------------------------------------
// HOST ENTRIES
// ------------------------------------------------------------------
// Allow-list entries are not always registrable domains. A development setup
// needs localhost, a LAN address, a container name or a loopback literal, with
// or without a port.

const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function classifyHost(hostname) {
  if (!hostname) return null;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return 'ipv6';
  if (IPV4_PATTERN.test(hostname)) return 'ipv4';
  const labels = hostname.split('.');
  if (!labels.every(label => HOST_LABEL_PATTERN.test(label))) return null;
  // A single label is a bare host such as localhost or a container name.
  return labels.length > 1 ? 'domain' : 'host';
}

/**
 * Parses anything a user might paste — with or without a scheme, path or port —
 * into { host, port, kind, value }, or null when it is not a host at all.
 */
function normaliseHostEntry(raw) {
  if (typeof raw !== 'string') return null;

  let text = raw.trim().toLowerCase();
  if (!text) return null;

  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');       // scheme
  text = text.split('/')[0].split('?')[0].split('#')[0];    // path, query, hash
  text = text.replace(/^[^@]*@/, '');                       // credentials
  if (!text) return null;

  // A bare IPv6 literal has to be bracketed before the URL parser will take it.
  if (!text.startsWith('[') && (text.match(/:/g) || []).length > 1) text = `[${text}]`;

  let parsed;
  try {
    parsed = new URL('http://' + text);
  } catch {
    return null;
  }

  let host = parsed.hostname;
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);

  const kind = classifyHost(host);
  if (!kind) return null;

  const port = parsed.port || '';
  return { host, port, kind, value: port ? `${host}:${port}` : host };
}

/**
 * Does a location match a stored entry?
 *
 * Only real multi-label domains extend to their subdomains. Bare hosts and
 * literal addresses match exactly — otherwise an entry of "com" would whitelist
 * every .com site, and "0.1" would match 127.0.0.1. An entry without a port
 * matches any port; one with a port matches only that port.
 */
function hostMatchesEntry(hostname, port, entry) {
  const parsed = (entry && typeof entry === 'object') ? entry : normaliseHostEntry(entry);
  if (!parsed) return false;

  if (parsed.port && String(port || '') !== parsed.port) return false;

  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (host === parsed.host) return true;

  return parsed.kind === 'domain' && host.endsWith('.' + parsed.host);
}

function matchesAnyHostEntry(hostname, port, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.some(entry => hostMatchesEntry(hostname, port, entry));
}

// ------------------------------------------------------------------
// SCAN EXCLUSIONS
// ------------------------------------------------------------------
// An exclusion can name a whole site, one branch of it, or a single page.
// The three are told apart by what is written:
//
//   example.com                a whole site, subdomains included
//   example.com/docs/*         that section and everything under it
//   example.com/docs/intro     that one page only
//
// A section or page pins the host exactly. Only a whole-site rule reaches
// subdomains, because an exclusion weakens protection and should not spread
// further than it looks like it does.

const SCAN_EXCLUSION_LABELS = {
  site: 'Whole site',
  section: 'Section',
  page: 'Single page'
};

function parseScanExclusion(raw) {
  if (typeof raw !== 'string') return null;

  let text = raw.trim().toLowerCase();
  if (!text) return null;

  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  text = text.replace(/^[^@/]*@/, '');                  // credentials
  text = text.split('#')[0];                            // fragment
  if (!text) return null;

  // An exclusion has to name a host. Without this a bare path slips through:
  // the URL parser tolerates the extra slashes in "http:///just/a/path" and
  // reads "just" as the hostname.
  if (/^[/?]/.test(text)) return null;

  const wildcard = /\/\*$|(?:^|[^*])\*$/.test(text);
  if (wildcard) text = text.replace(/\/?\*+$/, '');
  if (!text) return null;

  let parsed;
  try {
    parsed = new URL('http://' + text);
  } catch {
    return null;
  }

  const host = normaliseHostEntry(parsed.host);
  if (!host) return null;

  const path = (parsed.pathname || '/').replace(/\/+$/, '');
  const query = parsed.search || '';

  if (!path && !query) {
    return { kind: 'site', host: host.host, port: host.port, path: '/', query: '', value: host.value };
  }

  const kind = wildcard ? 'section' : 'page';
  return {
    kind,
    host: host.host,
    port: host.port,
    path: path || '/',
    query,
    value: `${host.value}${path}${query}${wildcard ? '/*' : ''}`
  };
}

function scanExclusionMatches(hostname, port, pathname, search, entry) {
  const rule = (entry && typeof entry === 'object') ? entry : parseScanExclusion(entry);
  if (!rule) return false;

  if (rule.port && String(port || '') !== rule.port) return false;

  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return false;

  if (rule.kind === 'site') {
    if (host === rule.host) return true;
    return classifyHost(rule.host) === 'domain' && host.endsWith('.' + rule.host);
  }

  if (host !== rule.host) return false;

  const path = (String(pathname || '/')).replace(/\/+$/, '') || '/';

  if (rule.kind === 'section') {
    return path === rule.path || path.startsWith(rule.path.replace(/\/$/, '') + '/');
  }

  if (path !== rule.path) return false;
  return !rule.query || String(search || '') === rule.query;
}

function matchesAnyScanExclusion(hostname, port, pathname, search, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.some(e => scanExclusionMatches(hostname, port, pathname, search, e));
}

// ------------------------------------------------------------------
// TEMPORARY PASSES
// ------------------------------------------------------------------
// Earned by retyping the unlock phrase in the popup. Deliberately short —
// long enough to do the thing you meant to do, not long enough to settle in.
const TEMP_GRANT_MS = 5 * 60 * 1000;
const TEMP_GRANT_ALARM = 'blockx-grant-expiry';

function activeGrants(grants) {
  if (!Array.isArray(grants)) return [];
  const now = Date.now();
  return grants.filter(g => g && typeof g.host === 'string' && g.expiresAt > now);
}

/**
 * A pass covers one host in one tab, and only until that tab has actually
 * loaded the page once. Reloading, or opening the same site anywhere else,
 * gets nothing — the timer is an upper bound on a single visit, not a window
 * during which the site is open.
 */
function hasTempGrant(hostname, grants, tabId) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return false;

  return activeGrants(grants).some(g => {
    if (typeof tabId === 'number' && g.tabId !== tabId) return false;
    if (g.consumed) return false;
    const granted = g.host.toLowerCase().replace(/^www\./, '');
    return host === granted || host.endsWith('.' + granted);
  });
}

/**
 * Whether a tab is currently sitting on the page a pass was spent on. Used by
 * the content script, which must not re-block the page the pass just opened.
 */
function isGrantedTab(hostname, grants, tabId) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host || typeof tabId !== 'number') return false;

  return activeGrants(grants).some(g => {
    if (g.tabId !== tabId) return false;
    const granted = g.host.toLowerCase().replace(/^www\./, '');
    return host === granted || host.endsWith('.' + granted);
  });
}

// ------------------------------------------------------------------
// SEARCH QUERIES
// ------------------------------------------------------------------
// A blocklist entry like "google.com/search?q=porn" only matches when the
// query happens to be the first parameter and is exactly that word. Real
// searches put the terms anywhere, url-encode them, and mix them with other
// words, so the query is pulled out and checked on its own.
const SEARCH_QUERY_PARAMS = {
  'google.': ['q'],
  'bing.com': ['q'],
  'duckduckgo.com': ['q'],
  'search.yahoo.': ['p'],
  'yandex.': ['text'],
  'search.brave.com': ['q'],
  'ecosia.org': ['q'],
  'startpage.com': ['q', 'query'],
  'searx': ['q'],
  'mojeek.com': ['q'],
  'youtube.com': ['search_query', 'q'],
  'reddit.com': ['q'],
  'x.com': ['q'],
  'twitter.com': ['q'],
  'pinterest.': ['q'],
  'tumblr.com': ['q'],
  'vimeo.com': ['q'],
  'dailymotion.com': ['search']
};

/**
 * Returns the human-readable search terms for a URL, or '' when it is not a
 * recognised search. Separators become spaces so word boundaries still apply.
 */
function extractSearchQuery(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return '';
  }

  const host = parsed.hostname.toLowerCase();
  const params = [];
  for (const [needle, keys] of Object.entries(SEARCH_QUERY_PARAMS)) {
    if (host.includes(needle)) params.push(...keys);
  }
  // Unknown host: still worth checking the usual suspects on any /search path.
  if (params.length === 0 && /(^|\/)(search|results|find)(\/|$)/.test(parsed.pathname)) {
    params.push('q', 'query', 'search', 'p', 'term', 'keyword');
  }
  if (params.length === 0) return '';

  const found = [];
  for (const key of new Set(params)) {
    const value = parsed.searchParams.get(key);
    if (value) found.push(value);
  }

  // Some sites carry the terms in the path, e.g. /search/free+porn
  const pathMatch = parsed.pathname.match(/\/(?:search|results|tag|tags|q)\/([^/]+)/i);
  if (pathMatch) {
    try { found.push(decodeURIComponent(pathMatch[1])); } catch { found.push(pathMatch[1]); }
  }

  return found.join(' ').replace(/[+_\-.]+/g, ' ').trim();
}

// ------------------------------------------------------------------
// CONTENT SCAN FILTER
// ------------------------------------------------------------------
// Page scanning needs word boundaries. A bare substring alternation matches
// "anal" inside "analysis", "butt" inside "button" and "rape" inside "grape",
// which would flag ordinary pages constantly.
function createBoundedFilter(keywords) {
  if (!keywords || keywords.length === 0) return null;

  const valid = [...new Set(
    keywords
      .map(kw => kw.trim().toLowerCase())
      .filter(kw => kw.length >= 3)
  )].sort((a, b) => b.length - a.length); // longest alternative wins

  if (valid.length === 0) return null;
  return new RegExp(`\\b(?:${valid.map(escapeRegExp).join('|')})\\b`, 'gi');
}

// Work budget for a single scan pass. Bounds the cost on huge documents.
const SCAN_NODE_LIMIT = 6000;
const SCAN_MIN_TEXT_LENGTH = 3;

// How long the document must stop changing before it is judged. After a route
// change the page still holds the previous view for a moment, so scanning
// straight away would grade the page being left rather than the one arriving.
const SCAN_THROTTLE_MS = 800;

// ...but a page that never stops mutating still has to be looked at.
const SCAN_MAX_DEFER_MS = 4000;

function getBlockUrl(method, hostname, extensionUrl) {
  if (method === 'blocked_page' && CONFIG.SHOW_GAME_INSTANTLY && CONFIG.GAMES.length > 0) {
    let gameIndex = CONFIG.ACTIVE_GAME_INDEX;
    if (gameIndex === -1) {
      gameIndex = Math.floor(Math.random() * CONFIG.GAMES.length);
    }
    const game = CONFIG.GAMES[gameIndex];
    return chrome.runtime.getURL(game.path);
  }

  switch (method) {
    case 'infinite_hang':
      return "http://1.1.1.1:81";
    case 'data_uri':
      return "data:" + (hostname || "Blocked");
    case 'custom_url':
      let url = CONFIG.CUSTOM_REDIRECT_URL;
      if (url && url.trim() !== '') {
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url;
      }
      // Fallback to interactive hub if URL is empty
      if (CONFIG.SHOW_GAME_INSTANTLY && CONFIG.GAMES.length > 0) {
        let gameIndex = CONFIG.ACTIVE_GAME_INDEX;
        if (gameIndex === -1) gameIndex = Math.floor(Math.random() * CONFIG.GAMES.length);
        return chrome.runtime.getURL(CONFIG.GAMES[gameIndex].path);
      }
    case 'blocked_page':
    default:
      return extensionUrl || chrome.runtime.getURL("assets/blocked-pages/blocked.html");
  }
}