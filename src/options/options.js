// options.js

const sections = {
    general: { title: "General Settings", subtitle: "Configure your core protection parameters." },
    lists: { title: "Domain Management", subtitle: "Manage the database of restricted hostnames." },
    keywords: { title: "Content Filtering", subtitle: "Define patterns to block based on page content." },
    pages: { title: "Page Link Restriction", subtitle: "Filter traffic to specific URLs and paths." },
    security: { title: "Security Protection", subtitle: "Secure your configuration with a dashboard password." }
};

const LIST_BINDINGS = [
    { inputId: 'domain-input', btnId: 'add-domain-btn', listId: 'domain-list', stateKey: 'CUSTOM_DOMAINS' },
    { inputId: 'keyword-input', btnId: 'add-keyword-btn', listId: 'keyword-list', stateKey: 'CUSTOM_KEYWORDS' },
    { inputId: 'page-input', btnId: 'add-page-btn', listId: 'page-list', stateKey: 'CUSTOM_PAGES' },
    { inputId: 'exact-page-input', btnId: 'add-exact-page-btn', listId: 'exact-page-list', stateKey: 'CUSTOM_EXACT_PAGES' },
    { inputId: 'allowed-domain-input', btnId: 'add-allowed-domain-btn', listId: 'allowed-domain-list', stateKey: 'CUSTOM_ALLOWED_DOMAINS' }
];

let pendingRemovals = [];
let pendingImport = null;
let stagedImport = null;
let countdownTimer = null;

let state = {
    BLOCK_METHOD: 'blocked_page',
    CUSTOM_REDIRECT_URL: '',
    CUSTOM_DOMAINS: [],
    CUSTOM_KEYWORDS: [],
    CUSTOM_PAGES: [],
    CUSTOM_EXACT_PAGES: [],
    CUSTOM_ALLOWED_DOMAINS: [],
    ACTIVE_GAME_INDEX: -1,
    SECURITY_ENABLED: false,
    PASSWORD: '',
    THEME: 'system' // 'light', 'dark', 'system'
};

async function init() {
    await loadConfig();
    await restore_options();
    
    // 0. Apply Theme
    applyTheme(state.THEME);
    setupThemeSelector();

    // 1. Initial lock state
    if (state.SECURITY_ENABLED) {
        document.body.classList.add('is-locked');
    }

    // 2. Setup Gateway & Listeners
    handleSecurityGateway();
    setupNavigation();
    setupEnforcementCards();
    setupSecurityLogic();
    
    // 3. Populate dynamic elements
    populateGames();
    LIST_BINDINGS.forEach(b => setupListManager(b.inputId, b.btnId, b.listId, b.stateKey));

    const customUrlInput = document.getElementById('custom-redirect-input');
    const customUrlBtn = document.getElementById('save-custom-url-btn');
    if (customUrlBtn && customUrlInput) {
        const saveCustomUrl = () => {
            let val = customUrlInput.value.trim();
            if (val && !/^https?:\/\//i.test(val));
            state.CUSTOM_REDIRECT_URL = val;
            saveState();
            if (val) showToast('Custom URL saved.');
        };

        customUrlBtn.addEventListener('click', saveCustomUrl);
        customUrlInput.addEventListener('blur', saveCustomUrl);
        customUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveCustomUrl();
        });
    }

    // 4. Load scheduled removals and start their countdowns
    setupImportOath();
    await refreshPendingRemovals();
    renderAllLists();
    renderPendingImport();
    startCountdownTicker();
    watchExternalChanges();
    warnBeforeLeaving();

    // 5. Prevention: Tamper-proof the gateway
    monitorGatewayTampering();

    // 6. Setup Import/Export Listeners
    setupBackupListeners();
}

// ------------------------------------------------------------------
// DELAYED REMOVAL
// ------------------------------------------------------------------

function renderAllLists() {
    LIST_BINDINGS.forEach(b => renderList(b.listId, b.stateKey));
}

function pendingFor(stateKey, value) {
    return pendingRemovals.find(p => p.listKey === stateKey && p.value === value) || null;
}

function refreshPendingRemovals() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'getPendingRemovals' }, (response) => {
            pendingRemovals = (response && response.pending) || [];
            pendingImport = (response && response.pendingImport) || null;
            resolve();
        });
    });
}

/**
 * Blocklist entries go through a cooling-off period before they actually leave
 * the list. Whitelist entries are removed straight away — that only ever
 * tightens protection.
 */
function requestRemoval(listId, stateKey, item) {
    if (!DELAYED_REMOVAL_LISTS.includes(stateKey)) {
        const index = state[stateKey].indexOf(item);
        if (index === -1) return;
        state[stateKey].splice(index, 1);
        renderList(listId, stateKey);
        saveState();
        return;
    }

    chrome.runtime.sendMessage(
        { action: 'schedulePendingRemoval', listKey: stateKey, value: item },
        async (response) => {
            if (!response || !response.record) {
                showToast('Could not schedule that removal.');
                return;
            }
            await refreshPendingRemovals();
            renderList(listId, stateKey);
            showToast(`Removal scheduled. Keep this tab open for ${formatCountdown(REMOVAL_DELAY_MS)}.`);
        }
    );
}

function cancelRemoval(listId, stateKey, id) {
    chrome.runtime.sendMessage({ action: 'cancelPendingRemoval', id }, async () => {
        await refreshPendingRemovals();
        renderList(listId, stateKey);
        showToast('Removal cancelled — the entry stays blocked.');
    });
}

function startCountdownTicker() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        if (pendingRemovals.length === 0 && !pendingImport) return;
        document.querySelectorAll('.pending-timer').forEach(el => {
            const expiresAt = parseInt(el.getAttribute('data-expires-at'), 10);
            const remaining = expiresAt - Date.now();
            const elapsed = el.closest('.pending-import-banner') ? 'applying…' : 'removing…';
            const text = remaining > 0 ? formatCountdown(remaining) : elapsed;
            // Only touch the DOM on a real change — the gateway's tamper observer
            // watches this subtree.
            if (el.textContent !== text) el.textContent = text;
        });
    }, 1000);
}

/**
 * The service worker applies removals directly to storage, so mirror any change
 * it makes back into the dashboard.
 */
function watchExternalChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        let dirty = false;

        LIST_BINDINGS.forEach(({ stateKey }) => {
            if (changes[stateKey]) {
                state[stateKey] = changes[stateKey].newValue || [];
                dirty = true;
            }
        });

        if (changes.PENDING_REMOVALS) {
            pendingRemovals = changes.PENDING_REMOVALS.newValue || [];
            dirty = true;
        }

        if (changes.PENDING_IMPORT) {
            pendingImport = changes.PENDING_IMPORT.newValue || null;
            renderPendingImport();
        }

        if (dirty) renderAllLists();
    });

    // A deferred import rewrites every setting at once, so start clean.
    chrome.runtime.onMessage.addListener((request) => {
        if (request && request.action === 'importApplied') {
            window.location.reload();
        }
    });
}

function warnBeforeLeaving() {
    window.addEventListener('beforeunload', (e) => {
        if (pendingRemovals.length === 0 && !pendingImport) return;
        e.preventDefault();
        e.returnValue = '';
    });
}

/**
 * Ensures the security gateway cannot be deleted or hidden via DevTools.
 */
function monitorGatewayTampering() {
    if (!state.SECURITY_ENABLED) return;

    const observer = new MutationObserver((mutations) => {
        const gateway = document.getElementById('security-gateway');
        const isLocked = document.body.classList.contains('is-locked');
        
        // Safety: check if body still has the class before accessing gateway
        if (isLocked) {
            if (!gateway || (gateway.classList && gateway.classList.contains('hidden'))) {
                // Tampering detected: either element deleted or hidden manually
                window.location.reload(); 
            }
        }
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, attributes: true, subtree: true });
    }
}

function handleSecurityGateway() {
    const gateway = document.getElementById('security-gateway');
    const title = document.getElementById('gateway-title');
    const desc = document.getElementById('gateway-desc');
    const unlockBtn = document.getElementById('gateway-unlock-btn');
    const passInput = document.getElementById('gateway-password');
    const errorMsg = document.getElementById('gateway-error');

    if (!gateway) return;

    if (!state.SECURITY_ENABLED) {
        gateway.classList.add('hidden');
        document.body.classList.remove('is-locked');
        return;
    }

    if (!state.PASSWORD) {
        if (title) title.textContent = "Setup Security";
        if (desc) desc.textContent = "Please set an initial password for your dashboard.";
        if (unlockBtn) unlockBtn.textContent = "Set & Unlock";
    }

    gateway.classList.remove('hidden');

    const attemptUnlock = () => {
        const input = passInput ? passInput.value : '';
        if (!state.PASSWORD) {
            if (input.length < 1) return;
            state.PASSWORD = input;
            saveState();
            unlock();
        } else if (input === state.PASSWORD) {
            unlock();
        } else {
            if (errorMsg) errorMsg.classList.remove('hidden');
        }
    };

    const unlock = () => {
        gateway.classList.add('hidden');
        document.body.classList.remove('is-locked');
        if (errorMsg) errorMsg.classList.add('hidden');
    };

    if (unlockBtn) unlockBtn.addEventListener('click', attemptUnlock);
    if (passInput) {
        passInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') attemptUnlock();
        });
    }
}

function setupSecurityLogic() {
    const toggle = document.getElementById('security-toggle');
    const setupBox = document.getElementById('password-management');
    const updateBtn = document.getElementById('set-password-btn');
    const newPassInput = document.getElementById('new-password');

    if (toggle) {
        toggle.checked = state.SECURITY_ENABLED;
        toggle.addEventListener('change', () => {
            state.SECURITY_ENABLED = toggle.checked;
            if (setupBox) {
                if (state.SECURITY_ENABLED) {
                    setupBox.classList.remove('hidden');
                } else {
                    setupBox.classList.add('hidden');
                }
            }
            saveState();
        });
    }

    if (state.SECURITY_ENABLED && setupBox) setupBox.classList.remove('hidden');

    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            const pass = newPassInput ? newPassInput.value : '';
            if (pass) {
                state.PASSWORD = pass;
                saveState();
                showToast('Password updated successfully.');
                if (newPassInput) newPassInput.value = '';
            }
        });
    }
}

function applyTheme(theme) {
    state.THEME = theme;
    document.body.setAttribute('data-user-theme', theme);
    
    // Update button active state
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
    });
}

function setupThemeSelector() {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.getAttribute('data-theme');
            applyTheme(theme);
            saveState();
        });
    });
}

function saveState() {
    const activeGameRadio = document.querySelector('input[name="activeGame"]:checked');
    state.ACTIVE_GAME_INDEX = activeGameRadio ? parseInt(activeGameRadio.value) : -1;

    chrome.storage.local.set({
        BLOCK_METHOD: state.BLOCK_METHOD,
        CUSTOM_REDIRECT_URL: state.CUSTOM_REDIRECT_URL,
        CUSTOM_DOMAINS: state.CUSTOM_DOMAINS,
        CUSTOM_KEYWORDS: state.CUSTOM_KEYWORDS,
        CUSTOM_PAGES: state.CUSTOM_PAGES,
        CUSTOM_EXACT_PAGES: state.CUSTOM_EXACT_PAGES,
        CUSTOM_ALLOWED_DOMAINS: state.CUSTOM_ALLOWED_DOMAINS,
        ACTIVE_GAME_INDEX: state.ACTIVE_GAME_INDEX,
        SECURITY_ENABLED: state.SECURITY_ENABLED,
        PASSWORD: state.PASSWORD,
        THEME: state.THEME
    }, () => {
        if (!chrome.runtime.lastError) {
            showToast('Settings auto-saved.');
        }
    });
}

function setupNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = link.getAttribute('data-section');
            if (!sections[sectionId]) return;

            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            const titleEl = document.getElementById('page-title');
            const subEl = document.getElementById('page-subtitle');
            if (titleEl) titleEl.textContent = sections[sectionId].title;
            if (subEl) subEl.textContent = sections[sectionId].subtitle;

            document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
            const targetSec = document.getElementById(`section-${sectionId}`);
            if (targetSec) targetSec.classList.add('active');
        });
    });
}

function updateHubVisibility(method) {
    const gameSection = document.getElementById('game-selection');
    const urlSection = document.getElementById('custom-url-selection');
    if (gameSection) {
        if (method === 'blocked_page') gameSection.classList.remove('hidden');
        else gameSection.classList.add('hidden');
    }
    if (urlSection) {
        if (method === 'custom_url') urlSection.classList.remove('hidden');
        else urlSection.classList.add('hidden');
    }
}

function setupEnforcementCards() {
    const inputs = document.querySelectorAll('input[name="blockMethod"]');
    inputs.forEach(input => {
        input.addEventListener('change', () => {
            state.BLOCK_METHOD = input.value;
            updateHubVisibility(input.value);
            saveState();
        });
    });
}

function setupListManager(inputId, btnId, listId, stateKey) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!input || !btn) return;

    const addItem = () => {
        let val = input.value.trim().toLowerCase();
        if (!val) return;

        // Domain Sanitization & Strict Validation
        if (stateKey === 'CUSTOM_DOMAINS' || stateKey === 'CUSTOM_ALLOWED_DOMAINS') {
            let cleanVal = val;
            
            // Add a temporary protocol if not present to let the URL parser handle it reliably
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
            
            // Strip leading 'www.' if present (e.g., www.facebook.com -> facebook.com)
            cleanVal = cleanVal.replace(/^www\./i, '');

            // Strict domain check: must have a TLD extension and no spaces/special keywords
            const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9-]{2,})+$/;
            if (!domainPattern.test(cleanVal)) {
                showToast("Invalid domain format! Must be e.g. facebook.com (not a keyword).");
                return;
            }
            val = cleanVal;
        }

        // Page Sanitization & Validation
        if (stateKey === 'CUSTOM_PAGES' || stateKey === 'CUSTOM_EXACT_PAGES') {
            let cleanVal = val;
            
            // Add a temporary protocol if not present to let the URL parser handle it reliably
            let urlToParse = cleanVal;
            if (!/^https?:\/\//i.test(cleanVal)) {
                urlToParse = 'http://' + cleanVal;
            }
            
            try {
                const parsed = new URL(urlToParse);
                const host = parsed.hostname.replace(/^www\./i, '');
                const pathAndQuery = parsed.pathname + parsed.search;
                
                // Reject if it is a plain domain (must have path or query components!)
                if ((pathAndQuery === '/' || pathAndQuery === '') && parsed.search === '') {
                    showToast("Must be a page link, not a plain domain (e.g. site.com/page)!");
                    return;
                }
                
                cleanVal = host + pathAndQuery;
                // Strip trailing slash if present to normalize
                if (cleanVal.endsWith('/')) {
                    cleanVal = cleanVal.slice(0, -1);
                }
            } catch (e) {
                showToast("Invalid page URL format!");
                return;
            }
            val = cleanVal;
        }
        
        const finalizeAdd = (finalVal) => {
            if (!finalVal) return;

            // Re-adding an entry that is counting down just calls the removal off.
            const pending = pendingFor(stateKey, finalVal);
            if (pending) {
                input.value = '';
                cancelRemoval(listId, stateKey, pending.id);
                return;
            }

            if (!state[stateKey].includes(finalVal)) {
                state[stateKey].push(finalVal);
                renderList(listId, stateKey);
                input.value = '';
                saveState();
            }
        };

        if (stateKey === 'CUSTOM_ALLOWED_DOMAINS') {
            if (state.CUSTOM_DOMAINS.includes(val)) {
                showToast("Cannot whitelist a domain that is in your custom blocklist.");
                return;
            }
            chrome.runtime.sendMessage({ action: 'isMasterBlocked', domain: val }, (response) => {
                if (response && response.blocked) {
                    showToast("Cannot whitelist globally restricted sites.");
                } else {
                    finalizeAdd(val);
                }
            });
            return;
        }

        if (stateKey === 'CUSTOM_DOMAINS') {
            if (state.CUSTOM_ALLOWED_DOMAINS && state.CUSTOM_ALLOWED_DOMAINS.includes(val)) {
                showToast("This domain is in your whitelist. Remove it there first.");
                return;
            }
        }

        finalizeAdd(val);
    };

    btn.addEventListener('click', addItem);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addItem();
    });
}

function renderList(listId, stateKey) {
    const container = document.getElementById(listId);
    if (!container) return;
    container.innerHTML = '';

    state[stateKey].forEach((item) => {
        const pending = pendingFor(stateKey, item);

        const el = document.createElement('div');
        el.className = pending ? 'tag-item pending' : 'tag-item';

        const span = document.createElement('span');
        span.className = 'tag-label';
        span.textContent = item;
        el.appendChild(span);

        el.appendChild(pending
            ? buildPendingControls(listId, stateKey, pending)
            : buildDeleteButton(listId, stateKey, item));

        container.appendChild(el);
    });
}

function buildDeleteButton(listId, stateKey, item) {
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'tag-delete';
    deleteBtn.title = DELAYED_REMOVAL_LISTS.includes(stateKey)
        ? `Schedule removal (${formatCountdown(REMOVAL_DELAY_MS)} cooling-off)`
        : 'Remove';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '18'); line1.setAttribute('y1', '6');
    line1.setAttribute('x2', '6'); line1.setAttribute('y2', '18');

    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '6'); line2.setAttribute('y1', '6');
    line2.setAttribute('x2', '18'); line2.setAttribute('y2', '18');

    svg.appendChild(line1);
    svg.appendChild(line2);
    deleteBtn.appendChild(svg);

    deleteBtn.addEventListener('click', () => requestRemoval(listId, stateKey, item));
    return deleteBtn;
}

function buildPendingControls(listId, stateKey, pending) {
    const group = document.createElement('div');
    group.className = 'pending-controls';

    const label = document.createElement('span');
    label.className = 'pending-label';
    label.textContent = 'Removing in';

    const timer = document.createElement('span');
    timer.className = 'pending-timer';
    timer.setAttribute('data-expires-at', pending.expiresAt);
    timer.textContent = formatCountdown(pending.expiresAt - Date.now());

    const keepBtn = document.createElement('button');
    keepBtn.className = 'tag-keep';
    keepBtn.type = 'button';
    keepBtn.textContent = 'Keep blocked';
    keepBtn.addEventListener('click', () => cancelRemoval(listId, stateKey, pending.id));

    group.appendChild(label);
    group.appendChild(timer);
    group.appendChild(keepBtn);
    return group;
}

function populateGames() {
    const gameList = document.getElementById('game-list');
    if (!gameList) return;
    gameList.innerHTML = '';

    const randomRadio = document.querySelector('input[name="activeGame"][value="-1"]');
    if (randomRadio) {
        randomRadio.addEventListener('change', saveState);
    }

    CONFIG.GAMES.forEach((game, index) => {
        const label = document.createElement('label');
        label.className = 'hub-item';
        
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'activeGame';
        input.value = index;
        input.className = 'sr-only';
        if (state.ACTIVE_GAME_INDEX === index) input.checked = true;
        input.addEventListener('change', saveState);

        const box = document.createElement('div');
        box.className = 'hub-item-box';
        
        // Create SVG icon
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('icon');   // <-- FIXED: was svg.className.setNamedItem(…)
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'm10 7 5 5-5 5');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10');
        
        svg.appendChild(path1);
        svg.appendChild(path2);
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = game.name;
        
        box.appendChild(svg);
        box.appendChild(nameSpan);
        
        label.appendChild(input);
        label.appendChild(box);
        
        gameList.appendChild(label);
    });
}


async function restore_options() {
    return new Promise((resolve) => {
        chrome.storage.local.get({
            BLOCK_METHOD: 'blocked_page',
            CUSTOM_REDIRECT_URL: '',
            CUSTOM_DOMAINS: [],
            CUSTOM_KEYWORDS: [],
            CUSTOM_PAGES: [],
            CUSTOM_EXACT_PAGES: [],
            CUSTOM_ALLOWED_DOMAINS: [],
            ACTIVE_GAME_INDEX: -1,
            SECURITY_ENABLED: false,
            PASSWORD: '',
            THEME: 'system'
        }, (items) => {
            state = items;
            applyTheme(state.THEME); // Re-apply theme after load

            const customUrlInput = document.getElementById('custom-redirect-input');
            if (customUrlInput) customUrlInput.value = state.CUSTOM_REDIRECT_URL || '';

            const methodInput = document.querySelector(`input[name="blockMethod"][value="${state.BLOCK_METHOD}"]`);
            if (methodInput) {
                methodInput.checked = true;
                updateHubVisibility(state.BLOCK_METHOD);
            }

            const gameRadio = document.querySelector(`input[name="activeGame"][value="${state.ACTIVE_GAME_INDEX}"]`);
            if (gameRadio) gameRadio.checked = true;

            resolve();
        });
    });
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    if (!toast || !toastText) return;
    toastText.textContent = msg;
    toast.classList.add('show');
    if (window.toastTimeout) clearTimeout(window.toastTimeout);
    window.toastTimeout = setTimeout(() => toast.classList.remove('show'), 2000);
}

function setupBackupListeners() {
    const exportBtn = document.getElementById("export-btn");
    const importFile = document.getElementById("import-file");

    if (exportBtn) {
        exportBtn.addEventListener("click", exportSettings);
    }
    if (importFile) {
        importFile.addEventListener("change", handleImport);
    }
}

function exportSettings() {
    chrome.storage.local.get([
        "BLOCK_METHOD",
        "CUSTOM_DOMAINS",
        "CUSTOM_KEYWORDS",
        "CUSTOM_PAGES",
        "CUSTOM_EXACT_PAGES",
        "CUSTOM_ALLOWED_DOMAINS",
        "ACTIVE_GAME_INDEX",
        "SECURITY_ENABLED",
        "PASSWORD",
        "THEME"
    ], (items) => {
        const backupData = {
            version: "1.0",
            timestamp: new Date().toISOString(),
            settings: items
        };

        const jsonString = JSON.stringify(backupData, null, 2);
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        a.href = url;
        a.download = `elite_shield_backup_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast("Settings exported successfully!");
    });
}

function handleImport(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        // Let the same file be picked again after a cancel.
        input.value = '';
        try {
            const data = JSON.parse(e.target.result);
            if (!data || !data.settings) {
                showToast("Invalid backup file format!");
                return;
            }

            const imported = data.settings;
            stagedImport = {
                BLOCK_METHOD: imported.BLOCK_METHOD || "blocked_page",
                CUSTOM_DOMAINS: Array.isArray(imported.CUSTOM_DOMAINS) ? imported.CUSTOM_DOMAINS : [],
                CUSTOM_KEYWORDS: Array.isArray(imported.CUSTOM_KEYWORDS) ? imported.CUSTOM_KEYWORDS : [],
                CUSTOM_PAGES: Array.isArray(imported.CUSTOM_PAGES) ? imported.CUSTOM_PAGES : [],
                CUSTOM_EXACT_PAGES: Array.isArray(imported.CUSTOM_EXACT_PAGES) ? imported.CUSTOM_EXACT_PAGES : [],
                CUSTOM_ALLOWED_DOMAINS: Array.isArray(imported.CUSTOM_ALLOWED_DOMAINS) ? imported.CUSTOM_ALLOWED_DOMAINS : [],
                ACTIVE_GAME_INDEX: typeof imported.ACTIVE_GAME_INDEX === 'number' ? imported.ACTIVE_GAME_INDEX : -1,
                SECURITY_ENABLED: !!imported.SECURITY_ENABLED,
                PASSWORD: imported.PASSWORD || "",
                THEME: imported.THEME || "system"
            };

            // An imported file can rewrite every list at once, so it never lands
            // without passing the intention check first.
            showImportOath();
        } catch (err) {
            showToast("Failed to parse backup file!");
            console.error("Import error:", err);
        }
    };
    reader.readAsText(file);
}

// ------------------------------------------------------------------
// IMPORT INTENTION CHECK
// ------------------------------------------------------------------

function showImportOath() {
    const overlay = document.getElementById('import-oath');
    if (overlay) overlay.classList.remove('hidden');
}

function hideImportOath() {
    const overlay = document.getElementById('import-oath');
    if (overlay) overlay.classList.add('hidden');
    stagedImport = null;
}

function setupImportOath() {
    const yesBtn = document.getElementById('oath-yes');
    const noBtn = document.getElementById('oath-no');
    const cancelBtn = document.getElementById('oath-cancel');
    const discardBtn = document.getElementById('cancel-import-btn');

    if (yesBtn) {
        yesBtn.addEventListener('click', () => {
            if (!stagedImport) return hideImportOath();
            chrome.runtime.sendMessage({ action: 'applyImportNow', settings: stagedImport }, () => {
                hideImportOath();
                showToast('Settings imported. Reloading…');
                setTimeout(() => window.location.reload(), 1200);
            });
        });
    }

    if (noBtn) {
        noBtn.addEventListener('click', () => {
            if (!stagedImport) return hideImportOath();
            chrome.runtime.sendMessage(
                { action: 'schedulePendingImport', settings: stagedImport },
                async (response) => {
                    hideImportOath();
                    if (!response || !response.record) {
                        showToast('Could not schedule that import.');
                        return;
                    }
                    await refreshPendingRemovals();
                    renderPendingImport();
                    showToast(`Import held. Keep this tab open for ${formatCountdown(REMOVAL_DELAY_MS)}.`);
                }
            );
        });
    }

    if (cancelBtn) cancelBtn.addEventListener('click', hideImportOath);

    if (discardBtn) {
        discardBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'cancelPendingImport' }, async () => {
                await refreshPendingRemovals();
                renderPendingImport();
                showToast('Import discarded — your current settings stay.');
            });
        });
    }
}

function renderPendingImport() {
    const banner = document.getElementById('pending-import-banner');
    const timer = document.getElementById('import-timer');
    if (!banner || !timer) return;

    if (!pendingImport) {
        banner.classList.add('hidden');
        return;
    }

    banner.classList.remove('hidden');
    timer.setAttribute('data-expires-at', pendingImport.expiresAt);
    timer.textContent = formatCountdown(pendingImport.expiresAt - Date.now());
}

document.addEventListener('DOMContentLoaded', init);
