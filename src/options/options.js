// options.js

const sections = {
    general: { title: "General Settings", subtitle: "Configure your core protection parameters." },
    lists: { title: "Domain Management", subtitle: "Manage the database of restricted hostnames." },
    whitelist: { title: "Whitelist", subtitle: "Destinations that bypass every rule." },
    keywords: { title: "Content Filtering", subtitle: "Define patterns to block based on page content." },
    pages: { title: "Page Link Restriction", subtitle: "Filter traffic to specific URLs and paths." },
    scanning: { title: "Content Scanning", subtitle: "Catch explicit pages on sites that are not on any list." },
    friction: { title: "Friction", subtitle: "The warning message you must read before loosening your own protection." },
    security: { title: "Security Protection", subtitle: "Secure your configuration with a dashboard password." }
};

const LIST_BINDINGS = [
    { inputId: 'domain-input', btnId: 'add-domain-btn', listId: 'domain-list', stateKey: 'CUSTOM_DOMAINS' },
    { inputId: 'keyword-input', btnId: 'add-keyword-btn', listId: 'keyword-list', stateKey: 'CUSTOM_KEYWORDS' },
    { inputId: 'page-keyword-input', btnId: 'add-page-keyword-btn', listId: 'page-keyword-list', stateKey: 'CUSTOM_PAGE_KEYWORDS' },
    { inputId: 'page-input', btnId: 'add-page-btn', listId: 'page-list', stateKey: 'CUSTOM_PAGES' },
    { inputId: 'exact-page-input', btnId: 'add-exact-page-btn', listId: 'exact-page-list', stateKey: 'CUSTOM_EXACT_PAGES' },
    { inputId: 'allowed-domain-input', btnId: 'add-allowed-domain-btn', listId: 'allowed-domain-list', stateKey: 'CUSTOM_ALLOWED_DOMAINS' },
    { inputId: 'scan-excluded-input', btnId: 'add-scan-excluded-btn', listId: 'scan-excluded-list', stateKey: 'CUSTOM_SCAN_EXCLUDED' }
];

let stagedImport = null;
let stagedWeakening = null;

let state = {
    BLOCK_METHOD: 'blocked_page',
    CUSTOM_REDIRECT_URL: '',
    CUSTOM_DOMAINS: [],
    CUSTOM_KEYWORDS: [],
    CUSTOM_PAGE_KEYWORDS: [],
    CUSTOM_PAGES: [],
    CUSTOM_EXACT_PAGES: [],
    CUSTOM_ALLOWED_DOMAINS: [],
    CUSTOM_SCAN_EXCLUDED: [],
    SCAN_SENSITIVITY: 2,
    UNLOCK_PHRASE: '',
    WEAKENING_MESSAGE: '',
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

    // 4. Settings UI
    setupScanSettings();
    setupWeakeningSettings();
    setupImportOath();
    setupSyncStatus();
    renderAllLists();
    watchExternalChanges();

    // 5. Prevention: Tamper-proof the gateway and UI modals
    monitorUiTampering();

    // 6. Setup Import/Export Listeners
    setupBackupListeners();
    setupWeakeningModal();
}

// ------------------------------------------------------------------
// LISTS
// ------------------------------------------------------------------

function renderAllLists() {
    LIST_BINDINGS.forEach(b => renderList(b.listId, b.stateKey));
}

function setupScanSettings() {
    const phraseInput = document.getElementById('unlock-phrase');
    const phraseBtn = document.getElementById('save-unlock-phrase-btn');
    if (phraseInput) {
        phraseInput.value = state.UNLOCK_PHRASE || '';

        const savePhrase = () => {
            const value = phraseInput.value.trim();
            if (!value) {
                showToast('The phrase cannot be empty.');
                phraseInput.value = state.UNLOCK_PHRASE || '';
                return;
            }
            if (value === (state.UNLOCK_PHRASE || '')) return;
            state.UNLOCK_PHRASE = value;
            saveState();
        };

        phraseInput.addEventListener('blur', savePhrase);
        if (phraseBtn) {
            phraseBtn.addEventListener('click', () => {
                savePhrase();
                showToast('Unlock phrase saved.');
            });
        }
    }

    const sensitivity = String(state.SCAN_SENSITIVITY || 2);
    const selected = document.querySelector(`input[name="scanSensitivity"][value="${sensitivity}"]`);
    if (selected) selected.checked = true;

    document.querySelectorAll('input[name="scanSensitivity"]').forEach(input => {
        input.addEventListener('change', () => {
            state.SCAN_SENSITIVITY = parseInt(input.value, 10);
            saveState();
        });
    });
}

// ------------------------------------------------------------------
// SHARED SETTINGS STATUS
// ------------------------------------------------------------------

function setupSyncStatus() {
    const refreshBtn = document.getElementById('sync-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'reconcileSettings' }, () => {
                renderSyncStatus();
                showToast('Settings checked across all stores.');
            });
        });
    }
    renderSyncStatus();
}

function renderSyncStatus() {
    chrome.runtime.sendMessage({ action: 'getSyncStatus' }, (response) => {
        const status = response && response.status;
        if (!status) return;

        const accountDot = document.getElementById('sync-account-dot');
        if (accountDot) accountDot.className = 'sync-dot on';

        const fileDot = document.getElementById('sync-file-dot');
        const fileDesc = document.getElementById('sync-file-desc');
        if (fileDot && fileDesc) {
            if (status.file.available) {
                fileDot.className = 'sync-dot on';
                fileDesc.textContent = status.file.path || 'Active on this machine.';
            } else {
                fileDot.className = 'sync-dot off';
                fileDesc.textContent = 'Not set up. Run native/install.py once to share settings '
                    + 'with every profile on this machine, including ones on other accounts.';
            }
        }

        const revision = document.getElementById('sync-revision');
        if (revision) {
            revision.textContent = status.revision
                ? `Last change ${new Date(status.revision).toLocaleString()}`
                : 'No changes recorded yet';
        }
    });
}

// ------------------------------------------------------------------
// WARNING-MESSAGE FRICTION
// ------------------------------------------------------------------
// A change that loosens protection is never applied silently: the user's
// own message pops up and the change applies the moment it is confirmed.
// No timer and nothing to retype anywhere in that path.

const LIST_LABELS = {
    CUSTOM_DOMAINS: 'Restricted Domains',
    CUSTOM_KEYWORDS: 'Keywords',
    CUSTOM_PAGE_KEYWORDS: 'Page-Only Keywords',
    CUSTOM_PAGES: 'Restricted Pages',
    CUSTOM_EXACT_PAGES: 'Exact Pages',
    CUSTOM_ALLOWED_DOMAINS: 'Whitelist',
    CUSTOM_SCAN_EXCLUDED: 'Scan Exclusions'
};

function describeWeakeningAction(staged) {
    if (staged.op === 'remove') {
        const label = LIST_LABELS[staged.stateKey] || staged.stateKey;
        return `You are removing "${staged.value}" from ${label}. This weakens your protection.`;
    }
    if (staged.stateKey === 'CUSTOM_ALLOWED_DOMAINS') {
        return `You are adding "${staged.value}" to the whitelist. It will bypass every blocking rule, but will still be scanned by the live scanner.`;
    }
    return `You are exempting "${staged.value}" from content scanning.`;
}

function promptWeakeningWarning(staged) {
    stagedWeakening = staged;

    const modal = document.getElementById('weakening-modal');
    const textEl = document.getElementById('weakening-warning-text');
    const descEl = document.getElementById('weakening-action-desc');

    if (!modal) {
        applyWeakeningChange(staged);
        stagedWeakening = null;
        return;
    }

    const message = (state.WEAKENING_MESSAGE || CONFIG.WEAKENING_MESSAGE || '').trim()
        || 'Remember why you set this protection up.';
    if (textEl) textEl.textContent = message;
    if (descEl) descEl.textContent = describeWeakeningAction(staged);

    modal.classList.remove('hidden');
}

function hideWeakeningModal() {
    const modal = document.getElementById('weakening-modal');
    if (modal) modal.classList.add('hidden');
    stagedWeakening = null;
}

function applyWeakeningChange(staged) {
    const { listId, stateKey, value, op } = staged;
    if (op === 'add') {
        if (state[stateKey].includes(value)) return;
        state[stateKey].push(value);
    } else {
        const index = state[stateKey].indexOf(value);
        if (index === -1) return;
        state[stateKey].splice(index, 1);
    }
    renderList(listId, stateKey);
    saveState();
}

function setupWeakeningModal() {
    const proceedBtn = document.getElementById('weakening-proceed-btn');
    const goBackBtn = document.getElementById('weakening-goback-btn');
    const modal = document.getElementById('weakening-modal');

    if (proceedBtn) {
        proceedBtn.addEventListener('click', () => {
            if (!stagedWeakening) return hideWeakeningModal();
            const staged = stagedWeakening;
            hideWeakeningModal();
            applyWeakeningChange(staged);
            showToast('Change applied.');
        });
    }

    if (goBackBtn) {
        goBackBtn.addEventListener('click', () => {
            hideWeakeningModal();
            showToast('Nothing changed — protection stays as it was.');
        });
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideWeakeningModal();
                showToast('Nothing changed — protection stays as it was.');
            }
        });
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            hideWeakeningModal();
            showToast('Nothing changed — protection stays as it was.');
        }
    });
}

function setupWeakeningSettings() {
    const messageInput = document.getElementById('weakening-message');
    const saveBtn = document.getElementById('save-weakening-message-btn');
    if (messageInput) {
        messageInput.value = state.WEAKENING_MESSAGE || '';

        const saveMessage = () => {
            const value = messageInput.value.trim();
            if (value === (state.WEAKENING_MESSAGE || '')) return;
            state.WEAKENING_MESSAGE = value;
            saveState();
        };

        messageInput.addEventListener('blur', saveMessage);
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                saveMessage();
                showToast('Warning message saved.');
            });
        }
    }
}

/**
 * Changes to storage land from the sync reconciliation too, so mirror any
 * change back into the dashboard.
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

        if (dirty) renderAllLists();
    });
}

/**
 * Ensures the security gateway and the weakening warning modal cannot be
 * deleted, hidden, or bypassed via DevTools.
 */
function monitorUiTampering() {
    const checkIntegrity = () => {
        // 1. Security Gateway Lock Integrity
        if (state.SECURITY_ENABLED) {
            const gateway = document.getElementById('security-gateway');
            const isLocked = document.body.classList.contains('is-locked');

            if (!window._dashUnlocked && state.PASSWORD) {
                if (!isLocked) {
                    document.body.classList.add('is-locked');
                }
                if (!gateway || !document.body.contains(gateway)) {
                    window.location.reload();
                    return;
                }
                const style = window.getComputedStyle(gateway);
                if (gateway.classList.contains('hidden') || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
                    window.location.reload();
                    return;
                }
            }
        }

        // 2. Weakening Warning Modal Tamper Protection
        if (stagedWeakening) {
            const weakeningModal = document.getElementById('weakening-modal');
            if (!weakeningModal || !document.body.contains(weakeningModal)) {
                stagedWeakening = null;
                return;
            }
            const style = window.getComputedStyle(weakeningModal);
            if (weakeningModal.classList.contains('hidden') || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                stagedWeakening = null;
            }
        }
    };

    const observer = new MutationObserver(() => {
        checkIntegrity();
    });

    if (document.body) {
        observer.observe(document.body, {
            childList: true,
            attributes: true,
            subtree: true,
            attributeFilter: ['class', 'style', 'hidden', 'type']
        });
    }

    // Continuous heartbeat ticker to prevent DevTools breakpoint/pause bypasses
    setInterval(checkIntegrity, 400);
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
        window._dashUnlocked = true;
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
        CUSTOM_PAGE_KEYWORDS: state.CUSTOM_PAGE_KEYWORDS,
        CUSTOM_PAGES: state.CUSTOM_PAGES,
        CUSTOM_EXACT_PAGES: state.CUSTOM_EXACT_PAGES,
        CUSTOM_ALLOWED_DOMAINS: state.CUSTOM_ALLOWED_DOMAINS,
        CUSTOM_SCAN_EXCLUDED: state.CUSTOM_SCAN_EXCLUDED,
        SCAN_SENSITIVITY: state.SCAN_SENSITIVITY,
        UNLOCK_PHRASE: state.UNLOCK_PHRASE,
        WEAKENING_MESSAGE: state.WEAKENING_MESSAGE,
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
    // Scoped to the section nav on purpose. The Help link shares the .nav-link
    // look but is a real link, and this handler used to swallow its click.
    document.querySelectorAll('.app-nav .nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            const sectionId = link.getAttribute('data-section');
            if (!sections[sectionId]) return;
            e.preventDefault();

            document.querySelectorAll('.app-nav .nav-link').forEach(l => l.classList.remove('active'));
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

        // A scan exclusion may be a whole site, one section of it, or a single
        // page, so it is parsed rather than validated as a bare domain.
        if (stateKey === 'CUSTOM_SCAN_EXCLUDED') {
            const rule = parseScanExclusion(val);
            if (!rule) {
                showToast('Not a valid site, section or page.');
                return;
            }
            val = rule.value;
        }

        // The whitelist accepts any host you can actually navigate to, not just
        // registrable domains: localhost, a LAN address, a container name, an
        // IPv6 literal, each with an optional port.
        if (stateKey === 'CUSTOM_ALLOWED_DOMAINS') {
            const entry = normaliseHostEntry(val);
            if (!entry) {
                showToast('Not a valid host. Try example.com, localhost:3000 or 192.168.1.10.');
                return;
            }
            val = entry.value;
        }

        // Domain Sanitization & Strict Validation
        if (stateKey === 'CUSTOM_DOMAINS') {
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
            if (state[stateKey].includes(finalVal)) return;

            // Adding here weakens protection, so the user reads their own
            // warning message first; the change applies the moment they say yes.
            if (WEAKENING_ADDITION_LISTS.includes(stateKey)) {
                input.value = '';
                promptWeakeningWarning({ listId, stateKey, value: finalVal, op: 'add' });
                return;
            }

            state[stateKey].push(finalVal);
            renderList(listId, stateKey);
            input.value = '';
            saveState();
        };

        // Exempting a blocked site from scanning makes no sense and reads like
        // a loophole, so it is refused the same way the whitelist is.
        if (stateKey === 'CUSTOM_SCAN_EXCLUDED') {
            const rule = parseScanExclusion(val);
            const host = rule ? rule.host : val;

            if (matchesAnyHostEntry(host, rule && rule.port, state.CUSTOM_DOMAINS)) {
                showToast('That site is on your restricted list. It is already blocked.');
                return;
            }
            chrome.runtime.sendMessage({ action: 'isMasterBlocked', domain: host }, (response) => {
                if (response && response.blocked) {
                    showToast('That site is blocked by the built-in list.');
                } else {
                    finalizeAdd(val);
                }
            });
            return;
        }

        if (stateKey === 'CUSTOM_ALLOWED_DOMAINS') {
            if (state.CUSTOM_DOMAINS.includes(val)) {
                showToast("Cannot whitelist a domain that is in your custom blocklist.");
                return;
            }
            // The master list is keyed by hostname, so ask about the host alone.
            const bareHost = (normaliseHostEntry(val) || {}).host || val;
            chrome.runtime.sendMessage({ action: 'isMasterBlocked', domain: bareHost }, (response) => {
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
        container.appendChild(buildRow(listId, stateKey, item));
    });
}

function buildRow(listId, stateKey, item) {
    const el = document.createElement('div');
    el.className = 'tag-item';

    const span = document.createElement('span');
    span.className = 'tag-label';
    span.textContent = item;
    el.appendChild(span);

    const kind = describeEntry(stateKey, item);
    if (kind) {
        const badge = document.createElement('span');
        badge.className = 'tag-kind';
        badge.textContent = kind;
        el.appendChild(badge);
    }

    el.appendChild(buildDeleteButton(listId, stateKey, item));
    return el;
}

/**
 * Short label saying how broadly an entry reaches, so a whole-site exclusion
 * cannot be mistaken for a single page at a glance.
 */
function describeEntry(stateKey, item) {
    if (stateKey !== 'CUSTOM_SCAN_EXCLUDED') return null;
    const rule = parseScanExclusion(item);
    return rule ? SCAN_EXCLUSION_LABELS[rule.kind] : null;
}

function buildDeleteButton(listId, stateKey, item) {
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'tag-delete';
    deleteBtn.title = 'Remove';

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

    deleteBtn.addEventListener('click', () => {
        // Removing from a blocklist weakens protection: warning message and
        // an explicit yes/no first. Anything else applies at once.
        if (WEAKENING_REMOVAL_LISTS.includes(stateKey)) {
            promptWeakeningWarning({ listId, stateKey, value: item, op: 'remove' });
            return;
        }
        const index = state[stateKey].indexOf(item);
        if (index === -1) return;
        state[stateKey].splice(index, 1);
        renderList(listId, stateKey);
        saveState();
    });
    return deleteBtn;
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
            CUSTOM_PAGE_KEYWORDS: [],
            CUSTOM_PAGES: [],
            CUSTOM_EXACT_PAGES: [],
            CUSTOM_ALLOWED_DOMAINS: [],
            CUSTOM_SCAN_EXCLUDED: [],
            SCAN_SENSITIVITY: 2,
            UNLOCK_PHRASE: CONFIG.UNLOCK_PHRASE,
            WEAKENING_MESSAGE: CONFIG.WEAKENING_MESSAGE,
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
        "CUSTOM_PAGE_KEYWORDS",
        "CUSTOM_PAGES",
        "CUSTOM_EXACT_PAGES",
        "CUSTOM_ALLOWED_DOMAINS",
        "CUSTOM_SCAN_EXCLUDED",
        "SCAN_SENSITIVITY",
        "UNLOCK_PHRASE",
        "WEAKENING_MESSAGE",
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
                CUSTOM_PAGE_KEYWORDS: Array.isArray(imported.CUSTOM_PAGE_KEYWORDS) ? imported.CUSTOM_PAGE_KEYWORDS : [],
                CUSTOM_PAGES: Array.isArray(imported.CUSTOM_PAGES) ? imported.CUSTOM_PAGES : [],
                CUSTOM_EXACT_PAGES: Array.isArray(imported.CUSTOM_EXACT_PAGES) ? imported.CUSTOM_EXACT_PAGES : [],
                CUSTOM_ALLOWED_DOMAINS: Array.isArray(imported.CUSTOM_ALLOWED_DOMAINS) ? imported.CUSTOM_ALLOWED_DOMAINS : [],
                CUSTOM_SCAN_EXCLUDED: Array.isArray(imported.CUSTOM_SCAN_EXCLUDED) ? imported.CUSTOM_SCAN_EXCLUDED : [],
                SCAN_SENSITIVITY: typeof imported.SCAN_SENSITIVITY === 'number' ? imported.SCAN_SENSITIVITY : 2,
                UNLOCK_PHRASE: (typeof imported.UNLOCK_PHRASE === 'string' && imported.UNLOCK_PHRASE.trim()) ? imported.UNLOCK_PHRASE : CONFIG.UNLOCK_PHRASE,
                // Old backups stored the message under SCAN_MESSAGE.
                WEAKENING_MESSAGE: typeof imported.WEAKENING_MESSAGE === 'string'
                    ? imported.WEAKENING_MESSAGE
                    : (typeof imported.SCAN_MESSAGE === 'string' ? imported.SCAN_MESSAGE : CONFIG.WEAKENING_MESSAGE),
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
            hideImportOath();
            showToast('Import cancelled — your current settings stay.');
        });
    }
}

document.addEventListener('DOMContentLoaded', init);
