#!/usr/bin/env python3
"""
BlockX native messaging host.

A deliberately dumb file proxy. Chrome extensions cannot touch arbitrary paths
on disk, so this sits outside the sandbox and does nothing but read and write a
single JSON file. It never interprets the settings and never decides anything —
all validation, checksumming and merge logic lives in the extension.

Protocol (Chrome native messaging): each message is a 4-byte little-endian
length prefix followed by that many bytes of UTF-8 JSON, on stdin and stdout.

Requests:
    {"action": "ping"}   -> {"ok": true, "path": "...", "exists": bool}
    {"action": "read"}   -> {"ok": true, "empty": true}
                          | {"ok": true, "document": {...}}
    {"action": "write", "document": {...}} -> {"ok": true, "path": "..."}

Every response carries "ok"; failures carry "ok": false and "error".
"""

import json
import os
import struct
import sys
import tempfile

APP_DIR_NAME = "BlockX"
FILE_NAME = "settings.json"
MAX_MESSAGE_BYTES = 4 * 1024 * 1024


def in_flatpak() -> bool:
    return os.path.exists("/.flatpak-info") or bool(os.environ.get("FLATPAK_ID"))


def settings_path() -> str:
    """The conventional per-user config location for each platform."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, APP_DIR_NAME, FILE_NAME)

    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
        return os.path.join(base, APP_DIR_NAME, FILE_NAME)

    # Linux and other unixes follow the XDG base directory spec — except under
    # Flatpak, where XDG_CONFIG_HOME points into the calling app's private
    # sandbox tree (~/.var/app/<id>/config). Honouring it there would give each
    # browser its own private settings file, which is the opposite of the
    # point, so the real home is used instead. Flatpak browsers that can reach
    # this host already hold home filesystem permission.
    if in_flatpak():
        base = os.path.join(os.path.expanduser("~"), ".config")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")

    return os.path.join(base, APP_DIR_NAME.lower(), FILE_NAME)


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack("<I", header)[0]
    if length == 0 or length > MAX_MESSAGE_BYTES:
        return None
    raw = sys.stdin.buffer.read(length)
    if len(raw) < length:
        return None
    return json.loads(raw.decode("utf-8"))


def send_message(payload) -> None:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(raw)))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def handle_read(path):
    if not os.path.exists(path):
        return {"ok": True, "empty": True, "path": path}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as exc:
        # A corrupt or unreadable file is reported, never silently replaced.
        return {"ok": False, "error": "unreadable: %s" % exc, "path": path}
    return {"ok": True, "document": document, "path": path}


def handle_write(path, document):
    if document is None:
        return {"ok": False, "error": "missing document"}

    directory = os.path.dirname(path)
    try:
        os.makedirs(directory, exist_ok=True)
        # Write to a sibling temp file and replace, so an interrupted write
        # cannot leave a half-written settings file behind.
        handle, temp_path = tempfile.mkstemp(dir=directory, prefix=".settings-", suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(document, out, indent=2, sort_keys=True)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp_path, path)
        except BaseException:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise
    except OSError as exc:
        return {"ok": False, "error": "unwritable: %s" % exc, "path": path}

    return {"ok": True, "path": path}


def main() -> int:
    path = settings_path()

    while True:
        try:
            request = read_message()
        except ValueError as exc:
            send_message({"ok": False, "error": "bad request: %s" % exc})
            continue

        if request is None:
            return 0

        action = request.get("action")

        if action == "ping":
            send_message({"ok": True, "path": path, "exists": os.path.exists(path)})
        elif action == "read":
            send_message(handle_read(path))
        elif action == "write":
            send_message(handle_write(path, request.get("document")))
        else:
            send_message({"ok": False, "error": "unknown action: %r" % action})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
