#!/usr/bin/env python3
"""
Registers the BlockX native messaging host with the Chromium-family browsers
installed on this machine.

Run once per machine (not per profile) — every profile of a registered browser
then shares the same settings file:

    Linux    ~/.config/blockx/settings.json
    macOS    ~/Library/Application Support/BlockX/settings.json
    Windows  %APPDATA%\\BlockX\\settings.json

    python3 install.py                 install for the current user
    python3 install.py --uninstall     remove the registration
    python3 install.py --id <ext-id>   also allow an extra extension id
"""

import argparse
import json
import os
import stat
import sys

HOST_NAME = "com.blockx.settings"

# Derived from the fixed public key pinned in manifest.json, so the extension
# has the same id on every machine and profile.
DEFAULT_EXTENSION_ID = "fmmhohhhgjnddojamhkeagkedbenofnp"

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_SCRIPT = os.path.join(HERE, "blockx_host.py")


def browser_targets():
    """(label, directory) for each browser's NativeMessagingHosts folder."""
    home = os.path.expanduser("~")

    if sys.platform == "win32":
        # Windows locates the host through the registry, not a directory.
        return [("Chromium-family (registry)", None)]

    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
        candidates = [
            ("Google Chrome", os.path.join(base, "Google", "Chrome")),
            ("Chrome Beta", os.path.join(base, "Google", "Chrome Beta")),
            ("Chromium", os.path.join(base, "Chromium")),
            ("Brave", os.path.join(base, "BraveSoftware", "Brave-Browser")),
            ("Edge", os.path.join(base, "Microsoft Edge")),
            ("Vivaldi", os.path.join(base, "Vivaldi")),
        ]
    else:
        cfg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        candidates = [
            ("Google Chrome", os.path.join(cfg, "google-chrome")),
            ("Chrome Beta", os.path.join(cfg, "google-chrome-beta")),
            ("Chromium", os.path.join(cfg, "chromium")),
            ("Brave", os.path.join(cfg, "BraveSoftware", "Brave-Browser")),
            ("Edge", os.path.join(cfg, "microsoft-edge")),
            ("Vivaldi", os.path.join(cfg, "vivaldi")),
        ]
        # Flatpak keeps a private config tree per application.
        flatpak = os.path.join(home, ".var", "app")
        for app_id, config_dir, label in (
            ("com.google.Chrome", "google-chrome", "Google Chrome (Flatpak)"),
            ("com.brave.Browser", "BraveSoftware/Brave-Browser", "Brave (Flatpak)"),
            ("org.chromium.Chromium", "chromium", "Chromium (Flatpak)"),
            ("com.microsoft.Edge", "microsoft-edge", "Edge (Flatpak)"),
        ):
            candidates.append((label, os.path.join(flatpak, app_id, "config", config_dir)))

    # Only browsers that are actually present — otherwise the installer would
    # scatter config directories for browsers this machine has never had.
    targets = []
    for label, path in candidates:
        host_dir = os.path.join(path, "NativeMessagingHosts")
        if os.path.isdir(path) or os.path.isdir(host_dir):
            targets.append((label, host_dir))
    return targets


def host_manifest(extension_ids):
    return {
        "name": HOST_NAME,
        "description": "BlockX shared settings file bridge",
        "path": HOST_SCRIPT if sys.platform != "win32" else os.path.join(HERE, "blockx_host.bat"),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % ext for ext in extension_ids],
    }


def ensure_launchable():
    """Make the host directly executable on unix; shim it on Windows."""
    if sys.platform == "win32":
        bat_path = os.path.join(HERE, "blockx_host.bat")
        with open(bat_path, "w", encoding="utf-8") as handle:
            handle.write("@echo off\r\n")
            handle.write('"%s" "%s" %%*\r\n' % (sys.executable, HOST_SCRIPT))
        return bat_path

    mode = os.stat(HOST_SCRIPT).st_mode
    os.chmod(HOST_SCRIPT, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return HOST_SCRIPT


def install_windows(manifest, uninstall):
    import winreg

    key_path = r"Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME
    if uninstall:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            print("  removed registry key HKCU\\%s" % key_path)
        except FileNotFoundError:
            print("  registry key was not present")
        return

    manifest_path = os.path.join(HERE, "%s.json" % HOST_NAME)
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, manifest_path)
    print("  registered HKCU\\%s" % key_path)


def install_unix(manifest, targets, uninstall):
    written = 0
    for label, directory in targets:
        manifest_path = os.path.join(directory, "%s.json" % HOST_NAME)

        if uninstall:
            if os.path.exists(manifest_path):
                os.unlink(manifest_path)
                print("  removed  %-28s %s" % (label, manifest_path))
                written += 1
            continue

        try:
            os.makedirs(directory, exist_ok=True)
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(manifest, handle, indent=2)
        except OSError as exc:
            print("  skipped  %-28s %s" % (label, exc))
            continue

        print("  wrote    %-28s %s" % (label, manifest_path))
        written += 1
    return written


def main():
    parser = argparse.ArgumentParser(description="Install the BlockX settings bridge.")
    parser.add_argument("--uninstall", action="store_true", help="remove the registration")
    parser.add_argument("--id", action="append", default=[], metavar="EXT_ID",
                        help="additional extension id to allow (repeatable)")
    args = parser.parse_args()

    if not os.path.exists(HOST_SCRIPT):
        print("error: blockx_host.py not found next to this script", file=sys.stderr)
        return 1

    extension_ids = [DEFAULT_EXTENSION_ID] + [i.strip() for i in args.id if i.strip()]
    seen = set()
    extension_ids = [i for i in extension_ids if not (i in seen or seen.add(i))]

    action = "Uninstalling" if args.uninstall else "Installing"
    print("%s the BlockX settings bridge for the current user.\n" % action)

    if not args.uninstall:
        launch_path = ensure_launchable()
        print("  host script  %s" % launch_path)
        print("  allowed ids  %s\n" % ", ".join(extension_ids))

    manifest = host_manifest(extension_ids)

    if sys.platform == "win32":
        install_windows(manifest, args.uninstall)
        written = 1
    else:
        targets = browser_targets()
        if not targets:
            print("  no Chromium-family browser configuration directories found")
            return 1
        written = install_unix(manifest, targets, args.uninstall)

    print()
    if args.uninstall:
        print("Done. The settings file itself was left untouched.")
        return 0

    if not written:
        print("Nothing was registered. Is a Chromium-family browser installed for this user?")
        return 1

    # Import lazily so a missing host module cannot break --uninstall.
    sys.path.insert(0, HERE)
    from blockx_host import settings_path

    print("Done. Restart your browser, then open the BlockX dashboard.")
    print("Settings file: %s" % settings_path())
    return 0


if __name__ == "__main__":
    sys.exit(main())
