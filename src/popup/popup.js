// popup.js

let currentTab = null;
let currentContext = { type: 'domain', value: '' };

let unlockContext = null;

async function init() {
    await loadConfig();
    await detectContext();
    setupListeners();
    await setupUnlock();
}

// ------------------------------------------------------------------
// ONE-TIME VISIT
// ------------------------------------------------------------------

function sendMessage(payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

async function setupUnlock() {
    if (!currentTab) return;

    const context = await sendMessage({
        action: 'getUnlockContext',
        tabId: currentTab.id,
        url: currentTab.url || ''
    });
    if (!context || !context.target) return;

    if (context.active) {
        showActivePass(context.active);
        return;
    }
    if (!(context.phrase || '').trim()) return;

    showUnlockPanel(context, context.target);
}

function showUnlockPanel(context, target) {
    const panel = document.getElementById('unlock-panel');
    const hostEl = document.getElementById('unlock-host');
    const phraseEl = document.getElementById('unlock-phrase');
    const input = document.getElementById('unlock-input');
    const button = document.getElementById('unlock-btn');
    const errorEl = document.getElementById('unlock-error');
    const note = document.getElementById('unlock-note');
    if (!panel || !input || !button) return;

    const phrase = (context.phrase || '').trim();
    if (!phrase) return;

    // The unlock is the only thing worth showing on a blocked page.
    panel.classList.remove('hidden');
    document.getElementById('context-action')?.classList.add('hidden');
    document.getElementById('toggle-quick-add')?.classList.add('hidden');
    document.getElementById('quick-add-panel')?.classList.add('hidden');

    if (hostEl) hostEl.textContent = target.host;
    if (phraseEl) phraseEl.textContent = phrase;
    if (note) {
        note.textContent = `Grants ${Math.round(context.durationMs / 60000)} minutes on ${target.host}, then it closes again.`;
    }

    const collapse = (text) => text.trim().replace(/\s+/g, ' ');

    input.addEventListener('input', () => {
        errorEl?.classList.add('hidden');
        button.disabled = collapse(input.value) !== collapse(phrase);
    });

    button.addEventListener('click', async () => {
        button.disabled = true;
        const response = await sendMessage({
            action: 'grantTempPass',
            host: target.host,
            typed: input.value
        });

        if (!response || !response.ok) {
            errorEl?.classList.remove('hidden');
            button.disabled = false;
            return;
        }

        // Send the tab back to what it was trying to reach.
        if (target.url) chrome.tabs.update(currentTab.id, { url: target.url });
        window.close();
    });

    input.focus();
}

function showActivePass(grant) {
    const panel = document.getElementById('pass-panel');
    const detail = document.getElementById('pass-detail');
    const endBtn = document.getElementById('pass-end-btn');
    if (!panel) return;

    panel.classList.remove('hidden');

    const render = () => {
        const left = grant.expiresAt - Date.now();
        if (left <= 0) {
            panel.classList.add('hidden');
            return;
        }
        if (detail) detail.textContent = `${grant.host} — ${formatCountdown(left)} remaining`;
    };
    render();
    setInterval(render, 1000);

    if (endBtn) {
        endBtn.addEventListener('click', async () => {
            await sendMessage({ action: 'revokeTempPass', host: grant.host });
            panel.classList.add('hidden');
            if (currentTab) chrome.tabs.reload(currentTab.id);
            window.close();
        });
    }
}

/**
 * Detects if we should block a domain or a search keyword
 */
async function detectContext() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
    if (!currentTab || !currentTab.url) return;

    const url = new URL(currentTab.url);
    const domain = url.hostname;
    const protocol = url.protocol;

    // 1. Check for system pages (chrome://, about:, edge://, etc.)
    const systemProtocols = ['chrome:', 'about:', 'edge:', 'brave:', 'view-source:', 'chrome-extension:'];
    if (systemProtocols.includes(protocol) || domain === 'chrome.google.com') {
        document.getElementById('context-action').classList.add('hidden');
        document.getElementById('display-name').textContent = "System Protected Page";
        return;
    }

    // 2. Detect Google Search Keyword
    if (domain.includes('google.com') && url.pathname.includes('/search')) {
        const params = new URLSearchParams(url.search);
        const query = params.get('q');
        if (query) {
            currentContext = { type: 'keyword', value: query };
            document.getElementById('display-name').textContent = `"${query}"`;
            document.getElementById('context-type').textContent = 'Search Keyword';
            document.getElementById('block-type-label').textContent = 'Keyword';
            return;
        }
    }

    // 3. Default: Domain (strip leading www.)
    const cleanDomain = domain.replace(/^www\./i, '');
    currentContext = { type: 'domain', value: cleanDomain };
    document.getElementById('display-name').textContent = cleanDomain;
    document.getElementById('context-type').textContent = 'Domain';
    document.getElementById('block-type-label').textContent = 'Site';
}

function setupListeners() {
    // Open Settings
    const settingsBtn = document.getElementById('open-settings');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });
    }

    // Block Context Button
    const blockBtn = document.getElementById('block-btn');
    if (blockBtn) {
        blockBtn.addEventListener('click', async () => {
            const { type, value } = currentContext;
            if (!value) return;
            
            chrome.storage.local.get({
                CUSTOM_DOMAINS: [],
                CUSTOM_KEYWORDS: []
            }, (items) => {
                if (type === 'domain') {
                    if (!items.CUSTOM_DOMAINS.includes(value)) {
                        items.CUSTOM_DOMAINS.push(value);
                    }
                } else {
                    if (!items.CUSTOM_KEYWORDS.includes(value)) {
                        items.CUSTOM_KEYWORDS.push(value);
                    }
                }

                chrome.storage.local.set(items, () => {
                    // If it was a domain, redirect them out immediately
                    if (type === 'domain' && currentTab) {
                        const targetUrl = getBlockUrl(CONFIG.BLOCK_METHOD, value);
                        chrome.tabs.update(currentTab.id, { url: targetUrl });
                    } else if (currentTab) {
                        // For keywords, just reload the page to trigger block
                        chrome.tabs.reload(currentTab.id);
                    }
                    window.close();
                });
            });
        });
    }

    // Toggle Quick Add
    const toggleBtn = document.getElementById('toggle-quick-add');
    const panel = document.getElementById('quick-add-panel');
    if (toggleBtn && panel) {
        toggleBtn.addEventListener('click', () => {
            toggleBtn.classList.toggle('active');
            panel.classList.toggle('hidden');
        });
    }

    // Quick Add Logic
    const saveBtn = document.getElementById('quick-save-btn');
    const quickInput = document.getElementById('quick-input');
    if (saveBtn) saveBtn.addEventListener('click', saveQuickAdd);
    if (quickInput) {
        quickInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveQuickAdd();
        });
    }
}

function saveQuickAdd() {
    const input = document.getElementById('quick-input');
    if (!input) return;
    let rawVal = input.value.trim().toLowerCase();
    if (!rawVal) return;

    // Simple auto-detection: if it contains a dot and doesn't have spaces, it's likely a domain
    const isDomain = rawVal.includes('.') && !rawVal.includes(' ');
    const storageKey = isDomain ? 'CUSTOM_DOMAINS' : 'CUSTOM_KEYWORDS';

    if (isDomain) {
        // Sanitization
        let cleanVal = rawVal;
        let urlToParse = cleanVal;
        if (!/^https?:\/\//i.test(cleanVal)) {
            urlToParse = 'http://' + cleanVal;
        }
        try {
            const parsed = new URL(urlToParse);
            cleanVal = parsed.hostname;
        } catch (e) {
            cleanVal = cleanVal.split('/')[0];
        }
        
        // Strip www.
        cleanVal = cleanVal.replace(/^www\./i, '');

        // Validation: Must be a valid domain with TLD and no spaces/special characters
        const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9-]{2,})+$/;
        if (!domainPattern.test(cleanVal)) {
            input.value = '';
            input.placeholder = "Invalid domain format!";
            setTimeout(() => {
                input.placeholder = "Enter domain or keyword...";
            }, 2000);
            return;
        }
        rawVal = cleanVal;
    }

    chrome.storage.local.get({
        CUSTOM_DOMAINS: [],
        CUSTOM_KEYWORDS: []
    }, (items) => {
        if (!items[storageKey].includes(rawVal)) {
            items[storageKey].push(rawVal);
            chrome.storage.local.set(items, () => {
                input.value = '';
                input.placeholder = "Added successfully!";
                setTimeout(() => {
                    input.placeholder = "Enter domain or keyword...";
                    const toggleBtn = document.getElementById('toggle-quick-add');
                    if (toggleBtn) toggleBtn.click(); // close
                }, 1000);
            });
        } else {
            input.value = '';
            input.placeholder = "Already exists!";
            setTimeout(() => {
                input.placeholder = "Enter domain or keyword...";
            }, 2000);
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
