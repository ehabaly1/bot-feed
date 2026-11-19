#!/usr/bin/env python3
"""Build the encrypted static Bot Feed site.

Reads the panel's feed.json, orders logs, app.js and page markup, plus secrets
from the environment, and writes data.enc.json (AES-256-GCM, key from
PBKDF2-SHA256 of the passcode). Never prints any secret or plaintext.

Env:
  BOT_FEED_PASSCODE        passcode (fallback: <panel>/passcode.txt)
  BOT_OFFICE_WEBHOOK_KEY   webhook key (fallback: <panel>/.webhook_key)
  BOT_FEED_GH_TOKEN        optional fine-grained token used by the browser to
                           trigger the relay workflow (fallback: ~/.config/bot-feed/relay_token)
  BOT_FEED_GH_REPO         owner/repo for the relay (default ehabaly1/bot-feed)
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

SITE = Path(__file__).resolve().parent
PANEL = Path(os.environ.get("BOT_FEED_PANEL_DIR", "/workspace/bot-office-panel"))
ITERATIONS = 300_000
STATIC = ["app.css", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def secret(env: str, *files: Path) -> str:
    val = os.environ.get(env, "").strip()
    if val:
        return val
    for f in files:
        if f.is_file():
            val = f.read_text(encoding="utf-8").strip()
            if val:
                return val
    return ""


def derive(passcode: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return kdf.derive(passcode.encode("utf-8"))


def body_markup() -> str:
    html = (PANEL / "index.html").read_text(encoding="utf-8")
    m = re.search(r"<body[^>]*>(.*)</body>", html, re.S)
    if not m:
        sys.exit("build: could not find <body> in panel index.html")
    return m.group(1).strip()


def orders() -> list:
    sys.path.insert(0, str(PANEL))
    try:
        import server  # noqa: PLC0415  (guarded by __main__, safe to import)
        return server.merge_orders(50)
    except Exception:  # noqa: BLE001
        return []


def main() -> None:
    passcode = secret("BOT_FEED_PASSCODE", PANEL / "passcode.txt")
    wh_key = secret("BOT_OFFICE_WEBHOOK_KEY", PANEL / ".webhook_key")
    gh_token = secret("BOT_FEED_GH_TOKEN", Path.home() / ".config/bot-feed/relay_token")
    repo = os.environ.get("BOT_FEED_GH_REPO", "ehabaly1/bot-feed")
    if not passcode:
        sys.exit("build: passcode missing (BOT_FEED_PASSCODE)")
    cfg = json.loads((PANEL / "config.json").read_text(encoding="utf-8"))
    feed = json.loads((PANEL / "feed.json").read_text(encoding="utf-8"))

    payload = {
        "v": 1,
        "me": os.environ.get("BOT_FEED_OWNER_NAME", "Ehab"),
        "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "feed": feed,
        "orders": orders(),
        "body_html": body_markup(),
        "app_js": (PANEL / "app.js").read_text(encoding="utf-8"),
        "webhook": {"url": cfg.get("url", ""), "key": wh_key},
        "relay": {"mode": "github" if gh_token else "webhook", "repo": repo,
                  "workflow": "relay.yml", "ref": "main", "token": gh_token},
    }
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    # Keep the salt stable so devices that saved the derived key stay signed in.
    out = SITE / "data.enc.json"
    salt = None
    if out.is_file():
        try:
            old = json.loads(out.read_text())
            if old.get("iter") == ITERATIONS:
                salt = base64.b64decode(old["salt"])
        except Exception:  # noqa: BLE001
            salt = None
    salt = salt or os.urandom(16)
    key = derive(passcode, salt)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain, None)
    doc = {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITERATIONS, "salt": b64(salt),
           "iv": b64(iv), "ct": b64(ct)}
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc), encoding="utf-8")
    os.replace(tmp, out)

    for name in STATIC:
        shutil.copyfile(PANEL / name, SITE / name)
    # Bump the service-worker cache version so phones pick up new shells.
    sw = SITE / "sw.js"
    if sw.is_file():
        txt = re.sub(r'const VERSION = "[^"]*";', f'const VERSION = "{int(time.time())}";', sw.read_text())
        sw.write_text(txt)

    # The relay workflow needs the raw AES key as a repo secret (FEED_AES_KEY).
    # Write it to a private file for one-time setup; never print it.
    kf = Path.home() / ".config/bot-feed/feed_aes_key.b64"
    kf.parent.mkdir(parents=True, exist_ok=True)
    kf.write_text(b64(key))
    os.chmod(kf, 0o600)
    print(f"build: wrote data.enc.json ({len(ct)} bytes ciphertext, relay mode {payload['relay']['mode']})")


if __name__ == "__main__":
    main()
