// help.js

const selected = new Set();
let currentOs = 'linux';
let currentBrowser = 'chrome';

// The page is served by the extension, so this is always the real id — no need
// to trust the one pinned in the manifest.
const EXTENSION_ID = chrome.runtime.id;

function init() {
    applyTheme();
    setupTabs();
    setupBackButton();
    renderOptions();
    renderBrowserPicker();
    setupPickers();
    setupCopyButtons();
    render();
}

function applyTheme() {
    chrome.storage.local.get({ THEME: 'system' }, (items) => {
        document.body.setAttribute('data-user-theme', items.THEME || 'system');
    });
}

function setupTabs() {
    document.querySelectorAll('.help-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.help-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.help-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
            window.scrollTo({ top: 0 });
        });
    });
}

function setupBackButton() {
    document.getElementById('back-btn')?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

function renderOptions() {
    const container = document.getElementById('option-list');
    if (!container) return;
    container.innerHTML = '';

    for (const option of HARDENING_OPTIONS) {
        const label = document.createElement('label');
        label.className = option.advanced ? 'option advanced' : 'option';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = option.id;
        input.addEventListener('change', () => {
            if (input.checked) selected.add(option.id);
            else selected.delete(option.id);
            render();
        });

        const box = document.createElement('div');
        box.className = 'option-body';

        const title = document.createElement('span');
        title.className = 'option-title';
        title.textContent = option.label;
        if (option.advanced) {
            const tag = document.createElement('span');
            tag.className = 'option-tag';
            tag.textContent = 'needs hosting';
            title.appendChild(tag);
        }

        const detail = document.createElement('span');
        detail.className = 'option-detail';
        detail.textContent = option.detail;

        box.appendChild(title);
        box.appendChild(detail);
        label.appendChild(input);
        label.appendChild(box);
        container.appendChild(label);
    }
}

function renderBrowserPicker() {
    const select = document.getElementById('browser-picker');
    if (!select) return;
    select.innerHTML = '';
    for (const [id, target] of Object.entries(BROWSER_TARGETS)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = target.label;
        select.appendChild(option);
    }
    select.value = currentBrowser;
    select.addEventListener('change', () => {
        currentBrowser = select.value;
        render();
    });
}

function setupPickers() {
    document.querySelectorAll('#os-picker .seg').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('#os-picker .seg').forEach(b => b.classList.remove('active'));
            button.classList.add('active');
            currentOs = button.dataset.os;
            render();
        });
    });

    document.getElementById('update-url')?.addEventListener('input', render);
}

function render() {
    const urlRow = document.getElementById('update-url-row');
    urlRow?.classList.toggle('hidden', !selected.has('forceinstall'));

    const target = BROWSER_TARGETS[currentBrowser];
    const updateUrl = document.getElementById('update-url')?.value.trim() || '';
    const policies = buildPolicies([...selected], EXTENSION_ID, updateUrl);

    const empty = document.getElementById('empty-note');
    const area = document.getElementById('command-area');
    const hasAny = Object.keys(policies).length > 0;

    empty?.classList.toggle('hidden', hasAny);
    area?.classList.toggle('hidden', !hasAny);
    if (!hasAny) return;

    const cmd = document.getElementById('generated-cmd');
    if (cmd) cmd.textContent = buildCommand(currentOs, policies, target);

    const revert = document.getElementById('revert-cmd');
    if (revert) revert.textContent = buildRevertCommand(currentOs, target);

    const steps = document.getElementById('run-steps');
    if (steps) {
        steps.innerHTML = '';
        for (const note of RUN_NOTES[currentOs]) {
            const li = document.createElement('li');
            li.textContent = note;
            steps.appendChild(li);
        }
    }
}

function setupCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const source = document.getElementById(button.dataset.copy);
            if (!source) return;
            try {
                await navigator.clipboard.writeText(source.textContent);
                showToast('Copied to clipboard.');
            } catch {
                // Clipboard can be refused; selecting the text still lets them copy.
                const range = document.createRange();
                range.selectNodeContents(source);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                showToast('Selected — press Ctrl+C to copy.');
            }
        });
    });
}

function showToast(message) {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toast-text');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('show');
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

document.addEventListener('DOMContentLoaded', init);
