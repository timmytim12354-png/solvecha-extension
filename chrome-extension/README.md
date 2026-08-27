# Solvecha Auto-Captcha — Chrome extension

A Manifest V3 Chrome extension that detects hCaptcha widgets on the pages you
visit and auto-solves them through the **solvecha.net** API. A single toggle
turns it on/off; solving can also be paused per site.

## Requirements

- Chrome (or any Chromium browser) that supports Manifest V3.
- A **solvecha.net account with a linked Discord account** and an API key.
  Keys can only be created after the Discord link — that's the abuse gate.

## Install (unpacked, for development)

1. Clone the repo and open the `chrome-extension/` folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the `chrome-extension/` folder.

To package for distribution: `chrome://extensions` → **Pack extension** (a
`.crx` + `.pem`), or zip the folder and publish to the Chrome Web Store.

## Getting your API key

1. Create an account at **https://solvecha.net** (email/password or Discord
   sign-in).
2. **Link your Discord account** — the account is only considered verified
   once a Discord account (with a verified email) is linked. The dashboard
   shows a "Link Discord" banner until you do.
3. Create an API key:
   - **Dashboard:** Settings → API keys → *New key*. The full `hk_…` secret is
     shown exactly once.
   - **Discord bot:** DM `!api` to the Solvecha bot; it mints a fresh key and
     DMs it to you.
4. Open the extension → **Settings**, paste the key, press **Check & save**.
   The key is validated against the API and your plan/quota appears.

## Using it

- **Global toggle** — popup switch or Settings → Auto-solve. Off means no
  captcha is ever touched.
- **Per-site pause** — Settings → Paused sites → `example.com` pauses that
  domain and all subdomains.
- **What gets solved** — the extension watches for hCaptcha widgets: the
  visible "I'm not a robot" checkbox, or a challenge iframe that pops up
  (including invisible captchas that trigger a challenge). When one appears it
  asks solvecha.net for a token, injects it, and shows a small toast.
- **Usage is yours** — every successful solve is billed to *your* key, so it
  appears in your solvecha.net dashboard and counts against your monthly
  quota (free plan: 10 solves/month). The popup shows your live quota.

## How the key stays safe (read this)

**A secret baked into a Chrome extension can always be extracted** — an
extension is just a zip; anyone can unpack it and read the JavaScript. So this
extension deliberately contains **no shared key**.

- Each user must have their **own** solvecha.net account + linked Discord.
- The API key is issued per account and stored only in your browser's
  `chrome.storage.local`.
- Requests go directly from the extension's background worker to
  `solvecha.net/api/v1/solve` with `Authorization: Bearer <your key>`.
- Because there is no key in the extension, reverse-engineering the extension
  yields nothing — and because keys are tied to verified accounts, one
  person's key can't be used to drain someone else's quota.

This satisfies the "everyone must create an account, link Discord, and have
usage tied to their account" requirement on the server side: the solve
endpoint rejects unverified accounts (`account_unverified`) and over-quota
keys (`quota_exceeded`).

## API surface used

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/solve` | Solve hCaptcha (`sitekey` + `pageurl`) → token. Counts against your quota. |
| `GET /api/v1/me` | Validate a key and return plan/quota without consuming a solve. |

## Troubleshooting

- **"No API key configured"** — open Settings and connect your key.
- **"account isn't verified yet"** — link your Discord account at
  solvecha.net, then re-check the key in Settings.
- **"Monthly solve quota reached"** — the free tier allows 10 successful
  solves/month; it resets on the 1st (UTC). Upgrade or wait for the reset.
- **"rate_limited"** — too many simultaneous solves; the extension retries
  automatically.
- **Nothing happens on a page** — make sure Auto-solve is on, the site isn't
  paused, and the page actually uses hCaptcha (this extension does not handle
  reCAPTCHA/Turnstile).

## Self-hosting

If you run your own solvecha server, set the API base URL in
Settings → Advanced (e.g. `http://localhost:3000`). The host must be listed in
`host_permissions` in `manifest.json`, then reload the extension.

## Development

- `background.js` — service worker; the only file that talks to solvecha.net.
- `content.js` — detection + token injection + toast (runs in all frames).
- `popup.*`, `options.*` — UI.
- `shared.js` — config/storage helpers (no secret material).
- `make-icons.mjs` — regenerates `icons/` with `node make-icons.mjs`
  (zero-dependency PNG encoder).

No build step: load the folder as an unpacked extension.
