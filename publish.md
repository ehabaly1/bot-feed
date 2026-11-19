# Bot Feed (GitHub Pages) — rebuild and publish

Site: https://ehabaly1.github.io/bot-feed/  ·  Repo: https://github.com/ehabaly1/bot-feed
Everything sensitive (feed, orders, bot list, app code, webhook URL+key, relay token) lives
only inside `data.enc.json` (AES-256-GCM, key = PBKDF2-SHA256(passcode, salt, 300k)).
Never print secrets. Commit messages stay generic ("Update site"). No business words in file names.

## After every feed refresh (8 AM / 4 PM Cairo, or after appending a bot reply)
```bash
cd /workspace/bot-feed-pages
python3 build.py                      # re-encrypts /workspace/bot-office-panel/feed.json -> data.enc.json
git add -A && git commit -q -m "Update site" && git push -q origin main
```
Pages redeploys in ~30–60 s. Phones pick it up on next open (the page re-fetches data.enc.json every 60 s while open).

Push auth: the box needs a GitHub credential for ehabaly1/bot-feed (gh auth login, or a
fine-grained token with Contents: read/write on this repo only, stored via `gh auth login --with-token`).
The cursor-github connector cannot write files, create repos, or enable Pages.

## How comments are sent
The Cursor webhook only allows browser CORS from cursor.com, so github.io cannot call it directly.
The page instead calls GitHub's API (`workflow_dispatch` on `.github/workflows/relay.yml`) with a
fine-grained token (Actions: read/write on this repo only) that is stored inside the encrypted payload.
The order is AES-GCM encrypted with the same feed key before it leaves the phone, so the public
Actions run only shows ciphertext. The workflow decrypts it and POSTs it to the webhook
(`Authorization: Bearer`), exactly like server.py.

Repo secrets the workflow needs (Settings → Secrets and variables → Actions):
- `FEED_AES_KEY`  = contents of `~/.config/bot-feed/feed_aes_key.b64` (written by build.py)
- `WEBHOOK_URL`   = the "url" in /workspace/bot-office-panel/config.json
- `WEBHOOK_KEY`   = $BOT_OFFICE_WEBHOOK_KEY
Set them with gh without echoing: `gh secret set WEBHOOK_KEY -R ehabaly1/bot-feed --body "$BOT_OFFICE_WEBHOOK_KEY"` etc.

Browser relay token: put it in env `BOT_FEED_GH_TOKEN` or `~/.config/bot-feed/relay_token` (mode 600),
then `python3 build.py` (it switches relay mode to "github").

## If the passcode changes
Set the new BOT_FEED_PASSCODE, delete data.enc.json (forces a new salt), run build.py, update the
`FEED_AES_KEY` secret from ~/.config/bot-feed/feed_aes_key.b64, and push. Phones will ask once for the new passcode.

## Verify from outside
```bash
curl -sI https://ehabaly1.github.io/bot-feed/ | head -1          # 200
curl -s https://ehabaly1.github.io/bot-feed/data.enc.json | head -c 120   # only v/kdf/iter/salt/iv/ct
```
