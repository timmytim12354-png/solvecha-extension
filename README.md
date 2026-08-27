# Solvecha Auto-Captcha

Chrome extension that auto-solves hCaptcha and Cloudflare Turnstile through your [solvecha.net](https://solvecha.net) account.

## Install (use a Release zip)

GitHub’s **Code → Download ZIP** wraps files in a `solvecha-extension-main/` folder. Chrome cannot install that and shows **Could not unzip extension for install**.

Always download a **Release** asset instead. Those zips have `manifest.json` at the root.

1. Open the latest release: https://github.com/timmytim12354-png/solvecha-extension/releases
2. Download `solvecha-extension-x.y.z.zip` (or `solvecha-extension.zip` from this repo’s root)
3. Open `chrome://extensions`
4. Turn on **Developer mode**
5. Drag the zip onto the page, **or** unzip it and click **Load unpacked** on the unzipped folder

You should see `manifest.json` immediately inside the unzipped folder — not inside another `chrome-extension` directory.

## Requirements

- Chrome (or another Chromium browser) with Manifest V3
- A [solvecha.net](https://solvecha.net) account with Discord linked and an API key

## Getting an API key

1. Create an account at https://solvecha.net
2. Link Discord on the dashboard
3. Create a key under Settings → API keys, or DM `!api` to the Solvecha Discord bot
4. Open the extension → Settings, paste the `hk_…` key, press **Check & save**

## Using it

- **Global toggle** — popup switch or Settings → Auto-solve
- **Per-site pause** — Settings → Paused sites
- Each successful solve counts against **your** monthly quota

## Releasing a new version

1. Bump `"version"` in `manifest.json` (for example `1.0.3`)
2. Commit and push to `main`
3. Tag and push: `git tag v1.0.3 && git push origin v1.0.3`

GitHub Actions packs a root-level zip and publishes it on the tag.

To pack locally:

```bash
python scripts/pack.py
```

That writes `dist/solvecha-extension-<version>.zip` and `solvecha-extension.zip` at the repo root. Both have `manifest.json` at the archive root.

## Development

Load this repository folder as an unpacked extension (`chrome://extensions` → **Load unpacked**). There is no build step.

- `background.js` — talks to solvecha.net
- `content.js` — finds hCaptcha / Turnstile and injects the token
- `popup.*` / `options.*` — UI
- `shared.js` — storage helpers (no secrets)

This extension ships **no shared API key**. Each user stores their own key in `chrome.storage.local`.
