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
  'ACTIVE_GAME_INDEX',
  'SECURITY_ENABLED',
  'PASSWORD',
  'THEME'
];

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
const SCAN_THROTTLE_MS = 800;

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