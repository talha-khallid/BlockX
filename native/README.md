# Shared Settings

BlockX keeps one set of settings across every profile and machine you use. It
does that through two independent layers.

| Layer | Covers | Setup |
|---|---|---|
| **Account sync** | Every profile signed into the same Google account, on any device | None — always on |
| **Settings file** | Every profile on one machine, *regardless of which account they use* | Run the installer once per machine |

You do not have to choose. Whichever layers are available are kept in step with
each other automatically, so installing the file bridge later never loses
anything.

---

## Why the file needs a helper

A Chrome extension cannot read or write arbitrary paths on disk — the sandbox
has no API for it, by design. Reaching a real file therefore needs a small
program living outside the sandbox that the browser is explicitly told to talk
to. That is `blockx_host.py`: about a hundred lines that do nothing but read and
write one JSON file. It never interprets your settings and never decides
anything.

If you skip this step, everything still works — you just get account sync only.

---

## Install

Requires Python 3.7 or newer, which macOS and most Linux distributions already
have. On Windows, install it from [python.org](https://www.python.org/downloads/)
and tick **Add Python to PATH**.

```bash
cd native
python3 install.py
```

On Windows use `py install.py` from a normal Command Prompt.

Then **restart your browser** and open the BlockX dashboard. Under
*General → Shared Settings*, the "Settings file" row turns green and shows the
path.

The installer registers with every Chromium-family browser it finds for your
user — Chrome, Chromium, Brave, Edge, Vivaldi, including Flatpak installs. It
writes nothing outside your own home directory and needs no administrator
rights.

### Where the settings file lives

| Platform | Path |
|---|---|
| Linux | `~/.config/blockx/settings.json` (honours `XDG_CONFIG_HOME`) |
| macOS | `~/Library/Application Support/BlockX/settings.json` |
| Windows | `%APPDATA%\BlockX\settings.json` |

It is created the first time the extension has something to save. If it already
exists when a new profile starts up, that profile adopts it.

### Uninstall

```bash
python3 install.py --uninstall
```

This removes the registration only. Your settings file is left alone — delete it
yourself if you want it gone.

---

## How conflicts are settled

Every snapshot carries a revision stamp. On startup, whenever another profile
changes something, and every five minutes, BlockX reads whichever stores it can
reach, takes the highest revision, and writes it back to the others. There is no
merge step and nothing to resolve by hand — the most recent change wins.

## Editing the file by hand

The file is plain JSON and you are welcome to read it. Editing it is a different
matter.

Everything BlockX writes is checksummed. If the file's contents no longer match
its checksum, the extension knows it was edited outside the dashboard and treats
it as untrusted:

- Edits that **tighten** protection are accepted — adding blocked domains,
  keywords or pages.
- Edits that **loosen** protection are ignored, and the file is rewritten from
  the extension's own state. That covers removing blocklist entries, adding to
  the whitelist or scan exclusions, coarsening scan sensitivity, and switching
  off the dashboard password.

This exists so the settings file cannot be used to sidestep the twelve-minute
cooling-off period that removals go through in the dashboard. It is a deterrent
against a moment of weakness with a text editor, not a security boundary — the
checksum recipe is right there in `src/settings-sync.js`, and anyone determined
enough to read it can defeat it. The same is true of any tool like this: it
works because you want it to.

To change settings properly, use the dashboard. Those changes are signed, so
they propagate everywhere without complaint.

---

## Troubleshooting

**The row stays orange after installing.** Restart the browser completely —
registrations are read at launch. On Linux, make sure you restarted the same
browser the installer listed.

**"Specified native messaging host not found" in the service worker console.**
The browser you are using was not among those the installer found. Re-run
`python3 install.py` and check the list it prints.

**Your extension ID is not the pinned one.** `manifest.json` pins a public key
so the ID is `fmmhohhhgjnddojamhkeagkedbenofnp` everywhere. If you have removed
that key, register your actual ID as well:

```bash
python3 install.py --id <your-extension-id>
```

**Nothing appears in the file.** It is written the first time settings change.
Toggle something in the dashboard, then look again.
