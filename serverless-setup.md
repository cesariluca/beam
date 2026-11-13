# Beam — serverless setup (short-lived credentials, no secret in the page)

The relay secret lives in a Netlify environment variable. A small function hands the
page temporary credentials at runtime, so nothing sensitive is ever in the HTML.

## Folder to deploy
```
beam/
├── index.html
├── netlify.toml
└── netlify/
    └── functions/
        └── turn-credentials.js
```

## Deploy to Netlify (permanent URL)
1. Put the folder in a GitHub repo, then in Netlify: **Add new site → Import from Git**.
   (Netlify Drop's drag-and-drop does not run functions — use Git, or the Netlify CLI, so `/api/turn` works.)
2. Build command: leave empty. Publish directory: the folder root. Functions are auto-detected from `netlify.toml`.
3. **Site configuration → Change site name** → e.g. `my-beam`. Your permanent URL is `https://my-beam.netlify.app`.
4. Add it to the iPhone Home Screen and bookmark it on the laptop.

## Set the environment variables
Netlify: **Site configuration → Environment variables**. Pick ONE backend.

### Option 1 — your own coturn
| Variable | Value |
|---|---|
| `TURN_PROVIDER` | `coturn` |
| `TURN_HOST` | `turn.yourdomain.com` |
| `TURN_SECRET` | the same string as coturn's `static-auth-secret` |
| `TURN_TTL` | `3600` (optional) |

Deploy coturn with the provided `turnserver.conf` (it uses `use-auth-secret`). Generate the
secret with `openssl rand -hex 32` and put the identical value in both `static-auth-secret`
and Netlify's `TURN_SECRET`. Server-side steps (DNS, Let's Encrypt, firewall, `setcap` for
port 443) are the same as before — see the comments in `turnserver.conf`.

### Option 2 — Metered (expiring credentials minted through Metered's API)
| Variable | Value |
|---|---|
| `TURN_PROVIDER` | `metered` |
| `METERED_APP_DOMAIN` | your Metered app domain, e.g. `yourapp.metered.live` (no `https://`) |
| `METERED_SECRET_KEY` | the **Secret Key** from the dashboard's **Developers** page |
| `METERED_DOMAIN` | `standard.relay.metered.ca` (free plan) — or `global.relay.metered.ca` on a paid plan |
| `TURN_TTL` | `3600` (optional) |

The function calls Metered's "create credential" API with the Secret Key and hands the browser
only the resulting **expiring** username/password (created with `2 × TURN_TTL` seconds of life;
each one is reused by a warm function instance while it still has at least `TURN_TTL` left, because
Metered says a new credential can take up to ~2 minutes to start working). The browser never sees
a long-lived credential. Expired credentials stop working on their own; you can prune them from the
dashboard (label `beam`) if the list gets long.

**Migrating from the old static setup:** `METERED_USERNAME` / `METERED_PASSWORD` are no longer
read. Delete them from Netlify, and delete (or rotate) that static credential in the Metered
dashboard — every visitor's browser received it under the old setup.

On the **free plan the TURN domain is `standard.relay.metered.ca`**
— `global.relay.metered.ca` and regional domains are paid-only, and using them on a free account
makes the relay silently fail.

After setting variables, trigger a redeploy so the function picks them up.

## Verify
- Open `https://your-site.netlify.app/api/turn` directly — you should see a JSON `iceServers` array with a `username`/`credential`. If you see an `error`, the message says which variable is missing. (If you've enabled `BEAM_ACCESS_TOKEN`, a plain browser visit returns `401` instead — that's correct; see the curl test below.)
- In the app, open **Network & relay**: "Relay" should read *active (auto-renewing)*. Run **Run connectivity test** from inside a corporate network and look for a green **relay** result.

## Notes
- Credentials auto-renew: the page refetches before expiry and every ~45 minutes.
- coturn's relay only forwards already-encrypted packets; it cannot read your files.

## Public site, and the optional function token
The site is public: the `_headers` file only sets security headers (CSP etc.). An earlier `Basic-Auth`
rule there was never enforced on this Netlify plan, and it would also have locked out the public
training-room drop page, so it was removed. Anyone can therefore load the page and read what it ships.
- **Who is protected by what:** an incoming link always needs the receiver to tap **Accept**, and both
  screens then show the same short verification code — users should compare it before sending.
- **Relay quota:** anyone who loads the page can mint TURN credentials. On Metered's free plan the worst
  case is the monthly quota running out (the relay stops until it resets); there is no bill.
- **`BEAM_ACCESS_TOKEN`** (optional) — set it as a Netlify environment variable and put the same value in
  `window.BEAM_ACCESS_TOKEN` in `js/config.js`. The page sends it as an `X-Beam-Token` header; requests
  without it get `401`. Because the page is public the token is visible to anyone, so it only stops naive
  scripted use of `/api/turn`.
  - With the token enabled, opening `/api/turn` directly in a browser returns `401` — that's expected and confirms it's protected. To test it manually:
    `curl -H "X-Beam-Token: YOUR_TOKEN" https://your-site.netlify.app/api/turn`