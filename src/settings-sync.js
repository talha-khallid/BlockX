// settings-sync.js
// ------------------------------------------------------------------
// Keeps one set of settings across every profile and machine.
//
// Three stores hold the same snapshot:
//   local  chrome.storage.local — what the extension actually runs on
//   sync   chrome.storage.sync  — follows the Google account across devices
//   file   a JSON file on disk  — shared by every profile on this machine,
//                                 reached through the native host in native/
//
// Each snapshot carries a revision. Reconciling means reading whatever stores
// are reachable, taking the highest revision, and writing it back to the rest.
// Nothing here needs the stores to agree on how they got out of step.

let nativeState = { checked: false, available: false, path: null, error: null };
let syncInFlight = null;

// ------------------------------------------------------------------
// CHECKSUM
// ------------------------------------------------------------------

async function settingsChecksum(revision, settings) {
  const payload = SETTINGS_CHECKSUM_SALT + canonicalJson({ revision, settings });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function nextRevision(...revisions) {
  // Wall clock, but never allowed to go backwards or collide.
  return Math.max(Date.now(), ...revisions.map(r => (typeof r === 'number' ? r : 0) + 1));
}

// ------------------------------------------------------------------
// LOCAL
// ------------------------------------------------------------------

async function readLocalSnapshot() {
  // Array form on purpose. Passing an object whose values are `undefined`
  // silently drops those keys when the argument is serialised across the
  // extension API boundary, so only SETTINGS_REVISION would be requested and
  // every snapshot would come back empty.
  const stored = await chrome.storage.local.get([...SETTINGS_KEYS, 'SETTINGS_REVISION']);
  return {
    revision: typeof stored.SETTINGS_REVISION === 'number' ? stored.SETTINGS_REVISION : 0,
    settings: pickSettings(stored) || {}
  };
}

async function writeLocalSnapshot(settings, revision) {
  await chrome.storage.local.set({ ...settings, SETTINGS_REVISION: revision });
}

// ------------------------------------------------------------------
// CHROME SYNC STORAGE
// ------------------------------------------------------------------

async function readSyncSnapshot() {
  try {
    const stored = await chrome.storage.sync.get({ BLOCKX_SNAPSHOT: null });
    const snapshot = stored.BLOCKX_SNAPSHOT;
    if (!snapshot || typeof snapshot !== 'object') return null;

    const settings = pickSettings(snapshot.settings);
    if (!settings) return null;
    return { revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0, settings };
  } catch (e) {
    console.warn('[BlockX] Sync storage unreadable:', e);
    return null;
  }
}

async function writeSyncSnapshot(settings, revision) {
  try {
    await chrome.storage.sync.set({ BLOCKX_SNAPSHOT: { version: SETTINGS_FILE_VERSION, revision, settings } });
    return true;
  } catch (e) {
    // Most likely QUOTA_BYTES_PER_ITEM: the lists have outgrown sync storage.
    console.warn('[BlockX] Could not write sync storage:', e);
    return false;
  }
}

// ------------------------------------------------------------------
// SETTINGS FILE (via native host)
// ------------------------------------------------------------------

async function nativeSend(message) {
  return chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
}

/**
 * Probes for the native host once per service-worker lifetime. Its absence is
 * the normal case — the helper is optional — so this never throws.
 */
async function probeNativeHost(force = false) {
  if (nativeState.checked && !force) return nativeState;
  try {
    const reply = await nativeSend({ action: 'ping' });
    nativeState = {
      checked: true,
      available: !!(reply && reply.ok),
      path: reply?.path || null,
      error: reply && reply.ok ? null : (reply?.error || 'unexpected reply')
    };
  } catch (e) {
    nativeState = { checked: true, available: false, path: null, error: e?.message || String(e) };
  }
  return nativeState;
}

async function readFileSnapshot() {
  const state = await probeNativeHost();
  if (!state.available) return null;

  let reply;
  try {
    reply = await nativeSend({ action: 'read' });
  } catch (e) {
    console.warn('[BlockX] Settings file unreadable:', e);
    return null;
  }

  if (!reply || !reply.ok || reply.empty) return null;

  const doc = reply.document;
  const settings = pickSettings(doc?.settings);
  if (!settings) return null;

  const revision = typeof doc.revision === 'number' ? doc.revision : 0;
  const expected = await settingsChecksum(revision, settings);

  return { revision, settings, trusted: doc.checksum === expected };
}

async function writeFileSnapshot(settings, revision) {
  const state = await probeNativeHost();
  if (!state.available) return false;

  const document = {
    app: 'BlockX',
    version: SETTINGS_FILE_VERSION,
    revision,
    settings,
    checksum: await settingsChecksum(revision, settings)
  };

  try {
    const reply = await nativeSend({ action: 'write', document });
    if (reply && reply.ok) {
      nativeState.path = reply.path || nativeState.path;
      return true;
    }
    console.warn('[BlockX] Settings file write rejected:', reply?.error);
  } catch (e) {
    console.warn('[BlockX] Settings file write failed:', e);
  }
  return false;
}

// ------------------------------------------------------------------
// RECONCILE
// ------------------------------------------------------------------

/**
 * An untrusted file — one whose checksum does not match, meaning it was edited
 * by hand rather than written by the extension — is not allowed to loosen
 * anything. Its tightening changes are still honoured.
 */
function admissibleSettings(local, candidate) {
  if (candidate.trusted !== false) return candidate.settings;

  if (!weakensProtection(local.settings, candidate.settings)) {
    console.log('[BlockX] Settings file was hand-edited; changes only tighten, accepting.');
    return candidate.settings;
  }

  console.warn('[BlockX] Settings file was hand-edited to loosen protection. Ignoring those parts.');
  const merged = { ...candidate.settings };

  for (const key of WEAKENING_REMOVAL_LISTS) {
    const before = Array.isArray(local.settings[key]) ? local.settings[key] : [];
    const after = Array.isArray(merged[key]) ? merged[key] : [];
    merged[key] = [...new Set([...before, ...after])];
  }
  for (const key of WEAKENING_ADDITION_LISTS) {
    const before = new Set(Array.isArray(local.settings[key]) ? local.settings[key] : []);
    merged[key] = (Array.isArray(merged[key]) ? merged[key] : []).filter(item => before.has(item));
  }
  if (typeof merged.SCAN_SENSITIVITY === 'number') {
    merged.SCAN_SENSITIVITY = Math.min(merged.SCAN_SENSITIVITY, local.settings.SCAN_SENSITIVITY ?? 2);
  }
  if (local.settings.SECURITY_ENABLED) merged.SECURITY_ENABLED = true;

  return merged;
}

/**
 * Pulls from every reachable store, decides the winner, and pushes it back to
 * the others. Safe to call repeatedly; it is serialised.
 */
async function reconcileSettings(reason = 'startup') {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    try {
      const local = await readLocalSnapshot();
      const [sync, file] = await Promise.all([readSyncSnapshot(), readFileSnapshot()]);

      let winner = { ...local, source: 'local' };
      if (sync && sync.revision > winner.revision) winner = { ...sync, source: 'sync' };
      if (file && file.revision > winner.revision) winner = { ...file, source: 'file' };

      let settings = winner.settings;
      let revision = winner.revision;

      if (winner.source === 'file') {
        const admissible = admissibleSettings(local, winner);
        if (canonicalJson(admissible) !== canonicalJson(winner.settings)) {
          // Rejecting part of the file means this is now a new revision that
          // has to be written back over it.
          settings = admissible;
          revision = nextRevision(local.revision, sync?.revision, file.revision);
        }
        await writeLocalSnapshot(settings, revision);
      } else if (winner.source === 'sync') {
        await writeLocalSnapshot(settings, revision);
      } else if (revision === 0) {
        // First run: stamp whatever is already in local storage.
        revision = nextRevision();
        await chrome.storage.local.set({ SETTINGS_REVISION: revision });
      }

      const pushes = [];
      if (!sync || sync.revision !== revision) pushes.push(writeSyncSnapshot(settings, revision));
      if (nativeState.available && (!file || file.revision !== revision || winner.source !== 'file')) {
        pushes.push(writeFileSnapshot(settings, revision));
      }
      await Promise.all(pushes);

      console.log(`[BlockX] Settings reconciled (${reason}); winner=${winner.source} rev=${revision}`);
      return { revision, source: winner.source };
    } catch (e) {
      console.error('[BlockX] Settings reconcile failed:', e);
      return null;
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

/**
 * Called after the extension itself changes settings: stamps a fresh revision
 * and fans it out. This is the write path that makes the file trusted.
 */
async function publishSettings() {
  const local = await readLocalSnapshot();
  const revision = nextRevision(local.revision);

  await chrome.storage.local.set({ SETTINGS_REVISION: revision });
  await Promise.all([
    writeSyncSnapshot(local.settings, revision),
    writeFileSnapshot(local.settings, revision)
  ]);
  return revision;
}

async function settingsSyncStatus() {
  const state = await probeNativeHost(true);
  const local = await readLocalSnapshot();
  return {
    revision: local.revision,
    file: { available: state.available, path: state.path, error: state.error },
    sync: { available: !!(await readSyncSnapshot()) || true }
  };
}
