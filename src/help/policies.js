// policies.js
// ------------------------------------------------------------------
// Chrome reads enterprise policy from a location only an administrator can
// write. That is the whole point: once these are in place, the browser itself
// enforces them and the signed-in user cannot switch them back off.
//
// Everything here is a documented Chromium policy. Nothing is a trick, and
// each entry says plainly what it does and what it costs.

const HARDENING_OPTIONS = [
  {
    id: 'incognito',
    label: 'Turn off Incognito mode',
    detail: 'Removes the menu entry and the Ctrl+Shift+N shortcut. Incognito windows cannot be opened at all.',
    policies: { IncognitoModeAvailability: 1 }
  },
  {
    id: 'guest',
    label: 'Turn off Guest mode',
    detail: 'A guest window is a fresh profile with no extensions, so it bypasses everything.',
    policies: { BrowserGuestModeEnabled: false }
  },
  {
    id: 'profiles',
    label: 'Prevent adding new profiles',
    detail: 'A new profile is another way to get a browser without the extension in it.',
    policies: { BrowserAddPersonEnabled: false }
  },
  {
    id: 'safesearch',
    label: 'Force Google SafeSearch',
    detail: 'Enforced by the browser on every Google search, above anything the page or the extension does.',
    policies: { ForceGoogleSafeSearch: true }
  },
  {
    id: 'youtube',
    label: 'Force YouTube Restricted Mode',
    detail: 'Strict restricted mode, which cannot be turned off from YouTube settings.',
    policies: { ForceYouTubeRestrict: 2 }
  },
  {
    id: 'extensionspage',
    label: 'Block the extensions page',
    detail: 'Without reaching chrome://extensions there is no way to switch BlockX off or delete it. '
          + 'This is what actually makes the extension stick for a locally loaded copy.',
    policies: { URLBlocklist: ['chrome://extensions', 'chrome://extensions/*'] }
  },
  {
    id: 'devtools',
    label: 'Turn off Developer Tools',
    detail: 'Stops the page inspector being used to pull the extension\'s overlay off a page.',
    policies: { DeveloperToolsAvailability: 2 }
  },
  {
    id: 'otherextensions',
    label: 'Block installing other extensions',
    detail: 'Nothing new can be installed, so no proxy or unblocker extension can be added later. '
          + 'BlockX itself stays allowed.',
    policies: { ExtensionInstallBlocklist: ['*'] },
    needsExtensionId: true,
    extend(policies, extensionId) {
      policies.ExtensionInstallAllowlist = [extensionId];
    }
  },
  {
    id: 'pin',
    label: 'Pin BlockX to the toolbar',
    detail: 'Keeps the icon visible so the one-time visit prompt is always one click away.',
    needsExtensionId: true,
    extend(policies, extensionId) {
      policies.ExtensionSettings = policies.ExtensionSettings || {};
      policies.ExtensionSettings[extensionId] = {
        ...(policies.ExtensionSettings[extensionId] || {}),
        toolbar_pin: 'force_pinned'
      };
    }
  },
  {
    id: 'forceinstall',
    label: 'Force-install BlockX so it cannot be removed',
    detail: 'The strongest option, but it only works for an extension served from a web address — '
          + 'the Chrome Web Store or your own update manifest. It cannot force-install the unpacked '
          + 'folder you loaded by hand.',
    advanced: true,
    needsExtensionId: true,
    extend(policies, extensionId, updateUrl) {
      policies.ExtensionSettings = policies.ExtensionSettings || {};
      policies.ExtensionSettings[extensionId] = {
        ...(policies.ExtensionSettings[extensionId] || {}),
        installation_mode: 'force_installed',
        update_url: updateUrl || 'https://clients2.google.com/service/update2/crx'
      };
    }
  }
];

// Where each browser reads managed policy from, per platform.
const BROWSER_TARGETS = {
  chrome: {
    label: 'Google Chrome',
    linuxDir: '/etc/opt/chrome/policies/managed',
    // Written by an earlier version of this page to a directory Chrome never
    // reads. Cleaned up so it cannot sit there looking like it does something.
    legacyLinuxDir: '/etc/opt/chrome/policy/managed',
    macDomain: 'com.google.Chrome',
    winKey: 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome'
  },
  chromium: {
    label: 'Chromium',
    linuxDir: '/etc/chromium/policies/managed',
    macDomain: 'org.chromium.Chromium',
    winKey: 'HKLM:\\SOFTWARE\\Policies\\Chromium'
  },
  brave: {
    label: 'Brave',
    linuxDir: '/etc/brave/policies/managed',
    macDomain: 'com.brave.Browser',
    winKey: 'HKLM:\\SOFTWARE\\Policies\\BraveSoftware\\Brave'
  },
  edge: {
    label: 'Microsoft Edge',
    linuxDir: '/etc/opt/edge/policies/managed',
    macDomain: 'com.microsoft.Edge',
    winKey: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'
  }
};

const POLICY_FILE_NAME = 'blockx.json';

/**
 * Merges the selected options into one policy object.
 */
function buildPolicies(selectedIds, extensionId, updateUrl) {
  const policies = {};

  for (const option of HARDENING_OPTIONS) {
    if (!selectedIds.includes(option.id)) continue;

    for (const [key, value] of Object.entries(option.policies || {})) {
      if (Array.isArray(value) && Array.isArray(policies[key])) {
        policies[key] = [...new Set([...policies[key], ...value])];
      } else {
        policies[key] = value;
      }
    }
    if (typeof option.extend === 'function') option.extend(policies, extensionId, updateUrl);
  }

  return policies;
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------
// COMMAND BUILDERS
// ------------------------------------------------------------------

function linuxCommand(policies, target) {
  const json = JSON.stringify(policies);
  const path = `${target.linuxDir}/${POLICY_FILE_NAME}`;
  const cleanup = target.legacyLinuxDir
    ? ` && sudo rm -f ${target.legacyLinuxDir}/${POLICY_FILE_NAME}`
    : '';

  // Deliberately one line. A multi-line heredoc is fragile when pasted.
  return `sudo mkdir -p ${target.linuxDir} && printf '%s' ${shellQuote(json)}`
    + ` | sudo tee ${path} > /dev/null${cleanup}`
    + ` && echo "Applied. Now quit ${target.label} completely and start it again."`;
}

function macCommand(policies, target) {
  const json = JSON.stringify(policies);
  const plist = `/Library/Managed Preferences/${target.macDomain}.plist`;
  return `sudo mkdir -p "/Library/Managed Preferences" && printf '%s' ${shellQuote(json)}`
    + ` | plutil -convert xml1 -o - - | sudo tee ${shellQuote(plist)} > /dev/null`
    + ` && sudo killall cfprefsd`
    + ` && echo "Applied. Now quit ${target.label} completely and start it again."`;
}

/**
 * Chrome on Windows reads scalars as registry values, list policies from a
 * numbered subkey, and dictionary policies from a single JSON string.
 */
function windowsCommand(policies, target) {
  const lines = [`New-Item -Path '${target.winKey}' -Force | Out-Null`];

  for (const [key, value] of Object.entries(policies)) {
    if (Array.isArray(value)) {
      const sub = `${target.winKey}\\${key}`;
      lines.push(`New-Item -Path '${sub}' -Force | Out-Null`);
      value.forEach((item, index) => {
        lines.push(`New-ItemProperty -Path '${sub}' -Name '${index + 1}' -Value '${item}' -PropertyType String -Force | Out-Null`);
      });
    } else if (value !== null && typeof value === 'object') {
      const json = JSON.stringify(value).replace(/'/g, "''");
      lines.push(`New-ItemProperty -Path '${target.winKey}' -Name '${key}' -Value '${json}' -PropertyType String -Force | Out-Null`);
    } else {
      const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
      lines.push(`New-ItemProperty -Path '${target.winKey}' -Name '${key}' -Value ${numeric} -PropertyType DWord -Force | Out-Null`);
    }
  }

  lines.push(`Write-Host 'BlockX policy applied. Restart ${target.label}.'`);
  return lines.join('\n');
}

function buildCommand(os, policies, target) {
  if (Object.keys(policies).length === 0) return '';
  if (os === 'linux') return linuxCommand(policies, target);
  if (os === 'macos') return macCommand(policies, target);
  return windowsCommand(policies, target);
}

function buildRevertCommand(os, target) {
  if (os === 'linux') {
    const paths = [`${target.linuxDir}/${POLICY_FILE_NAME}`];
    if (target.legacyLinuxDir) paths.push(`${target.legacyLinuxDir}/${POLICY_FILE_NAME}`);
    return `sudo rm -f ${paths.join(' ')}`;
  }
  if (os === 'macos') {
    return `sudo rm -f ${shellQuote(`/Library/Managed Preferences/${target.macDomain}.plist`)} && sudo killall cfprefsd`;
  }
  return `Remove-Item -Path '${target.winKey}' -Recurse -Force`;
}

/**
 * Shows what else is already in the policy directory. Chrome merges every file
 * there, so a stray one can quietly override this.
 */
function buildListCommand(os, target) {
  if (os === 'linux') return `ls -la ${target.linuxDir}/ && head -n -0 ${target.linuxDir}/*.json`;
  if (os === 'macos') return `ls -la "/Library/Managed Preferences/"`;
  return `Get-ChildItem -Path '${target.winKey}' -Recurse | Format-List`;
}

const RUN_NOTES = {
  linux: [
    'Open a terminal.',
    'Paste the line and press Enter.',
    'Enter your password when sudo asks — this writes to /etc, which is why it needs one.',
    'Quit the browser completely and start it again. Closing every window is not always '
      + 'enough; if it still does not show up, end the remaining process and relaunch.',
    'On a Flatpak browser, quitting properly matters more than usual — see the note below.',
    'Open chrome://policy. The entries should be listed with Source: Platform. If the page '
      + 'is empty, the browser was never restarted.'
  ],
  macos: [
    'Open Terminal.',
    'Paste the line and press Enter.',
    'Enter your password when sudo asks.',
    'Quit the browser completely (Cmd+Q) and start it again.',
    'Check chrome://policy — the entries should be listed as Source: Platform.'
  ],
  windows: [
    'Press Start, type PowerShell, right-click it and choose Run as administrator.',
    'Paste the whole block and press Enter.',
    'Close every browser window and start the browser again.',
    'Check chrome://policy — the entries should be listed as Source: Platform.'
  ]
};
